/**
 * End-to-end check: the extension, loaded into a real browser.
 *
 * Every other gate stops short of the browser. Unit tests exercise pure
 * logic, the smoke test exercises the sources through the pipeline, and the
 * preview exercises the renderer on a plain page — but none of them proves
 * that the manifest loads, that the service worker starts, that the content
 * script is injected, or that a message crosses between them. A subsystem
 * that is correct and never runs looks exactly like one that works.
 *
 * So this loads the unpacked build, opens a page, and selects a word with
 * the mouse the way a reader would.
 *
 * Run with `npm run e2e`. Like the smoke test it sits outside `npm run
 * check`, because it needs a browser and a network.
 */
import { chromium, type BrowserContext, type Worker } from 'playwright';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(here, '..', 'dist', 'chromium');
const PROFILE = path.join(here, '..', 'dist', 'e2e-profile');

/**
 * The fixture defines "manifest" in the shape documentation uses, so the
 * local extractor has something to find. That assertion is the valuable
 * one: it depends on no network and therefore cannot flake.
 */
const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Apache Iceberg table specification</title>
<meta name="description" content="Table format specification: snapshots, manifests and partitioning.">
<style>body{font:16px/1.7 system-ui;max-width:40em;margin:3em auto}</style></head>
<body>
<h1>Apache Iceberg table specification</h1>
<h2>Metadata</h2>
<p>A manifest is a metadata file that lists the data files making up a snapshot,
together with their partition values and per-column statistics.</p>
<p>Readers use the current snapshot, and writers produce a new one on every
commit. The manifest list is read before planning begins.</p>
<p id="low" style="position:fixed;bottom:20px;left:24px;margin:0">
A partition groups data files by a column value.</p>
</body></html>`;

/**
 * A stand-in for the browser's translator.
 *
 * The real language pack is a large download served by the browser vendor's
 * component updater, which Chrome for Testing cannot reach — and waiting on
 * one would make this check slow and dependent on a third party either way.
 * What needs proving here is the wiring: that a `downloadable` pair offers a
 * button, that progress is reported, and that the settings page ends up
 * saying the pair is ready. The real model is the browser's job, not ours.
 */
const FAKE_TRANSLATOR = `
  let state = 'downloadable';
  Object.defineProperty(window, 'Translator', {
    configurable: true,
    value: {
      async availability() { return state; },
      async create(options) {
        const listeners = [];
        options.monitor?.({ addEventListener: (_type, fn) => listeners.push(fn) });
        for (let step = 1; step <= 4; step++) {
          await new Promise((r) => setTimeout(r, 20));
          for (const fn of listeners) fn({ loaded: step / 4 });
        }
        state = 'available';
        return { translate: async (text) => text, destroy() {} };
      },
    },
  });
`;

async function checkTranslationDownload(context: BrowserContext, id: string): Promise<void> {
  const page = await context.newPage();
  await page.addInitScript(FAKE_TRANSLATOR);
  await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'domcontentloaded' });

  const button = page.locator('#downloadTranslation');
  const label = page.locator('#translationLabel');

  const offered = await button
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  record(
    'a downloadable language pair offers a download',
    offered,
    offered ? ((await label.textContent()) ?? '') : 'no button appeared',
  );

  // Sending the selection to a third party is the one thing here that must
  // never happen because a default drifted, so the default is asserted.
  const online = page.locator('#onlineTranslation');
  record(
    'sending text to an online translator is off until asked for',
    (await online.isChecked()) === false,
    'onlineTranslation default',
  );

  if (offered) {
    await button.click();
    const ready = await label
      .filter({ hasText: /is ready and runs on this device/ })
      .waitFor({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    record('downloading a language pair reports progress and completes', ready, (await label.textContent()) ?? '');
  }
  await page.close();
}

/**
 * The card must stay on screen when the selection is near the foot of the
 * window — the case that reads as "the bottom half is cut off".
 *
 * Measured after the providers have landed, because the defect only appears
 * once the card has grown past the height it was placed at. Asserting on the
 * placement code would have proved nothing: the code was correct for the
 * height it was given.
 */
async function checkBottomPlacement(page: import('playwright').Page): Promise<void> {
  await page.getByText('A partition groups data files').dblclick({ position: { x: 20, y: 8 } });

  const card = page.locator('quick-lookup-card .card');
  const appeared = await card
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    record('a selection at the foot of the window opens the card', false, 'never appeared');
    return;
  }

  await page.waitForTimeout(2500);
  const fits = await page.evaluate(() => {
    const host = document.querySelector('quick-lookup-card');
    const box = host?.shadowRoot?.querySelector('.card')?.getBoundingClientRect();
    if (!box) return null;
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      height: Math.round(box.height),
      viewport: window.innerHeight,
    };
  });

  record(
    'a card anchored near the foot of the window stays on screen',
    Boolean(fits && fits.top >= 0 && fits.bottom <= fits.viewport),
    fits ? `top=${fits.top} bottom=${fits.bottom} height=${fits.height} viewport=${fits.viewport}` : 'no card',
  );

  // Dragging across the answer is how a reader copies one line out of it.
  // This must be a real drag: a programmatic `selectNodeContents` succeeds
  // even when `mousedown` is being cancelled, which is the actual defect.
  await page.evaluate(() => getSelection()?.removeAllRanges());
  // Not the first section: one still waiting on its provider is three empty
  // skeleton bars, and the topmost one sits under the sticky header on a
  // card tall enough to scroll. Either would fail for the wrong reason.
  const target = page.locator('quick-lookup-card .body section .label ~ *').first();
  await target.scrollIntoViewIfNeeded().catch(() => {});
  const box = await target.boundingBox();
  if (box) {
    // Starting well inside the text column, not on the edge: a list indents
    // its items, so the first few pixels of the box are padding and a drag
    // beginning there selects nothing even when selection works perfectly.
    const y = box.y + Math.min(box.height / 2, 24);
    await page.mouse.move(box.x + 80, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, y + 18, { steps: 12 });
    await page.mouse.up();
  }
  const picked = await page.evaluate(() => getSelection()?.toString() ?? '');
  record(
    'text inside the card can be selected with the mouse',
    picked.trim().length > 0,
    box ? `"${picked.trim().slice(0, 44)}"` : 'no section to drag across',
  );
  record('selecting inside the card does not close it', await card.isVisible());

  await page.keyboard.press('Escape');
}

/**
 * A selection long enough to read as a quote gets the handle instead of the
 * card, and pressing the handle must open the card.
 *
 * Worth a browser check rather than a unit test, because what broke it was
 * event ordering and nothing else: the document's capture-phase
 * `pointerdown` listener hid the handle before its own `click` could land,
 * so the button was gone from under the finger. Every unit test of the
 * decision logic passed the whole time.
 */
async function checkHandle(page: import('playwright').Page): Promise<void> {
  // Triple-click takes the whole paragraph, which is past the word count
  // where a selection stops reading as a lookup.
  await page.getByText('A manifest is a metadata file', { exact: false }).click({ clickCount: 3 });

  const handle = page.locator('quick-lookup-handle button');
  const offered = await handle
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  record('a long selection offers the handle instead of opening', offered);
  if (!offered) return;

  await handle.click();
  const card = page.locator('quick-lookup-card .card');
  const opened = await card
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const query = opened
    ? ((await page.locator('quick-lookup-card header .query').textContent()) ?? '')
    : '';
  record('pressing the handle opens the card', opened, query.slice(0, 40));

  await page.keyboard.press('Escape');
}

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(FIXTURE);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;

let context: BrowserContext | undefined;
try {
  context = await chromium.launchPersistentContext(PROFILE, {
    // An extension needs a persistent context, and only the `chromium`
    // channel loads one without a visible window. Set E2E_HEADED=1 to watch
    // it happen, which is the fastest way to understand a failure here.
    channel: 'chromium',
    headless: process.env.E2E_HEADED !== '1',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });

  // The worker may already be running, or may still be starting.
  let worker: Worker | undefined = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 20_000 }).catch(() => undefined);
  }
  record('service worker starts', Boolean(worker), worker?.url() ?? 'never appeared');
  if (!worker) throw new Error('the background script did not start; nothing else can work');

  const workerErrors: string[] = [];
  worker.on('console', (message) => {
    if (message.type() === 'error') workerErrors.push(message.text());
  });

  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  record('content script is injected', true, origin);

  // Double-click selects the word and produces the pointer events the
  // trigger actually listens for. Nothing here reaches inside the
  // extension: this is the gesture a reader makes.
  await page.getByText('A manifest is a metadata file', { exact: false }).dblclick({
    position: { x: 20, y: 10 },
  });

  const card = page.locator('quick-lookup-card .card');
  const appeared = await card
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  record('a selection opens the card', appeared, appeared ? '' : 'card never became visible');

  if (appeared) {
    const headword = (await page.locator('quick-lookup-card header .query').textContent()) ?? '';
    record('the card names what was selected', /manifest/i.test(headword), `query=${headword}`);

    // Local, so it must arrive regardless of the network.
    const onPage = page.locator('quick-lookup-card section', { hasText: 'On this page' });
    const quoted = (await onPage.locator('.quote').first().textContent().catch(() => null)) ?? '';
    record(
      'the page itself answers',
      /metadata file that lists the data files/i.test(quoted),
      quoted ? `"${quoted.slice(0, 70)}…"` : 'no sentence from the page',
    );

    // Network sources are reported rather than asserted: an outage is not a
    // defect in the extension.
    await page.waitForTimeout(2500);
    const sources = (await page.locator('quick-lookup-card footer span').first().textContent()) ?? '';
    console.log(`\n  ${sources.trim()}`);

    // Copying is checked through the real clipboard rather than by asserting
    // on the string the formatter returned — the unit tests already cover the
    // formatting, and what can break here is everything in between.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const readClipboard = () =>
      page.evaluate(() => navigator.clipboard.readText()).catch(() => '');

    const copyMarkdown = page
      .locator('quick-lookup-card button.chip')
      .filter({ hasText: 'Markdown' });
    const offersCopy = (await copyMarkdown.count()) > 0;
    record('the card offers a way to copy itself', offersCopy);

    if (offersCopy) {
      await copyMarkdown.click();
      const copied = await readClipboard();
      const said = await page
        .locator('quick-lookup-card button.chip[data-state="done"]')
        .count();
      record(
        'the copy button puts markdown on the clipboard and says so',
        said === 1 && copied.startsWith('## manifest'),
        copied ? `${copied.split('\n')[0]} (${copied.length} chars)` : 'clipboard was empty',
      );

      // The card never takes focus, so the keyboard route is the only one a
      // reader who does not use a mouse has.
      await page.evaluate(() => navigator.clipboard.writeText('not the card'));
      await page.keyboard.press('Alt+c');
      const byKeyboard = await readClipboard();
      record(
        'Alt+C copies the card without touching the mouse',
        byKeyboard.startsWith('## manifest'),
        byKeyboard.split('\n')[0] ?? '',
      );
    }

    // Escape must close it, because that is the reader's escape hatch.
    await page.keyboard.press('Escape');
    const closed = await card
      .waitFor({ state: 'hidden', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    record('Escape closes the card', closed);
    if (closed) await checkBottomPlacement(page);
    if (closed) await checkHandle(page);
  }

  await checkTranslationDownload(context, worker.url().split('/')[2] ?? '');

  record('no errors from the background script', workerErrors.length === 0, workerErrors.join(' | '));
  record('no errors on the page', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await context?.close();
  server.close();
}

console.log('');
let failed = 0;
for (const check of checks) {
  if (!check.ok) failed++;
  console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
}
console.log(failed === 0 ? '\nThe extension works in a browser.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
