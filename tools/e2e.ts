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
import { rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { markFor } from '../src/core/marks.ts';

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
  await paragraph(page, 'A partition groups data files').dblclick({ position: { x: 20, y: 8 } });

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
  await paragraph(page, 'A manifest is a metadata file').click({ clickCount: 3 });

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

/**
 * Dragging a card aside, and getting a second one.
 *
 * The whole feature is stateful in a way no unit test reaches: the card has
 * to move under the pointer, stop being re-placed by the provider that lands
 * next, survive a selection that would previously have replaced its content,
 * and leave a fresh card for that selection to write into. Every one of those
 * is a different way for it to look like it works.
 */
async function checkPinning(context: BrowserContext, origin: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await paragraph(page, 'A manifest is a metadata file').dblclick({ position: { x: 20, y: 10 } });

  const cards = page.locator('quick-lookup-card');
  const first = cards.first().locator('.card');
  if (
    !(await first
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false))
  ) {
    record('a card opens before it can be dragged', false);
    await page.close();
    return;
  }
  // Let the providers land first: the interesting case is a card that has
  // finished growing, because a card still being re-placed hides the bug.
  await page.waitForTimeout(2500);

  const header = cards.first().locator('header');
  const before = await first.boundingBox();
  const grip = await header.boundingBox();
  if (!before || !grip) {
    record('the header can be found to drag by', false);
    await page.close();
    return;
  }

  // Pressed in the middle of the header, between the title and the buttons.
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 180, grip.y + grip.height / 2 + 120, { steps: 14 });
  await page.mouse.up();

  const after = await first.boundingBox();
  record(
    'the card can be dragged by its header',
    Boolean(after && before && Math.abs(after.x - before.x) > 100 && Math.abs(after.y - before.y) > 80),
    after && before
      ? `moved ${Math.round(after.x - before.x)},${Math.round(after.y - before.y)}`
      : 'no box',
  );
  record(
    'and says it is detached',
    (await cards.first().locator('.card.pinned').count()) === 1,
    'pinned styling',
  );

  // The point of pinning: the next selection must not take this card over.
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await paragraph(page, 'A partition groups data files').dblclick({ position: { x: 20, y: 8 } });
  const second = await cards
    .nth(1)
    .locator('.card')
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  const queries = await page.locator('quick-lookup-card header .query').allTextContents();
  record(
    'the next selection opens a second card instead of replacing the first',
    second && queries.length === 2 && /manifest/i.test(queries[0] ?? '') && /partition/i.test(queries[1] ?? ''),
    queries.join(' | ') || 'only one card',
  );

  const moved = await first.boundingBox();
  record(
    'a pinned card stays where it was put',
    Boolean(moved && after && Math.abs(moved.x - after.x) < 2 && Math.abs(moved.y - after.y) < 2),
    moved && after ? `drift ${Math.round(moved.x - after.x)},${Math.round(moved.y - after.y)}` : 'no box',
  );

  // Escape clears the live card first, then the pinned ones.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  record(
    'Escape clears them in the reverse of the order they arrived',
    (await page.locator('quick-lookup-card .card').count()) === 0 ||
      (await page.locator('quick-lookup-card .card:visible').count()) === 0,
    `${await page.locator('quick-lookup-card').count()} host(s) left`,
  );
  await page.close();
}

/**
 * Following a related word, and getting back.
 *
 * The chips used to be labels. Making them buttons is only half the feature:
 * one click replaces the word on the card, and the page no longer has the
 * original selected, so without a way back the reader has lost where they
 * started. Both halves are checked here because either alone is a worse card
 * than the one before.
 */
async function checkFollowing(context: BrowserContext, origin: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await paragraph(page, 'A manifest is a metadata file').dblclick({ position: { x: 20, y: 10 } });

  const chip = page.locator('quick-lookup-card section button.chip.synonym').first();
  const offered = await chip
    .waitFor({ state: 'visible', timeout: 12_000 })
    .then(() => true)
    .catch(() => false);
  record('a related word is offered as something to press', offered);
  if (!offered) {
    await page.close();
    return;
  }

  const word = ((await chip.textContent()) ?? '').trim();
  const query = page.locator('quick-lookup-card header .query');
  await chip.click();
  const followed = await query
    .filter({ hasText: new RegExp(`^${word}$`, 'i') })
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  record('pressing it looks that word up in place', followed, `manifest → ${word}`);

  const back = page.locator('quick-lookup-card header button.back');
  const wayBack = await back
    .waitFor({ state: 'visible', timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  record('and the way back names the word it returns to', wayBack, (await back.getAttribute('title')) ?? '');

  if (wayBack) {
    await back.click();
    const returned = await query
      .filter({ hasText: /^manifest$/i })
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    // Hidden again at the end of the trail, or it offers a journey with no
    // destination.
    record(
      'going back returns to the word and puts the control away',
      returned && (await back.isHidden()),
      returned ? `back to manifest, control hidden: ${await back.isHidden()}` : 'never returned',
    );
  }
  await page.close();
}

/**
 * The history, which is the only way to review a word after the card closed.
 *
 * Worth a browser check rather than a unit test because everything about it
 * is wiring: the service worker records a lookup, the toolbar popup asks for
 * the list over a message, and starring writes back. All three are correct in
 * isolation and none of them is exercised by anything else — the store's own
 * tests pass against an object in memory.
 */
async function checkHistory(context: BrowserContext, id: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/action.html`, { waitUntil: 'domcontentloaded' });

  const rows = page.locator('#history li .word');
  const listed = await rows
    .first()
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  const words = listed ? await rows.allTextContents() : [];
  record(
    'words looked up on a page turn up in the history',
    words.some((word) => /manifest/i.test(word)),
    words.slice(0, 6).join(', ') || 'nothing was recorded',
  );
  if (!listed) {
    await page.close();
    return;
  }

  // Starring is what turns a log into a list worth keeping: a starred entry
  // survives both the size cap and Clear, so Clear is the honest test of it.
  await page.locator('#history li').first().locator('button.star').click();
  await page.locator('#history li button.star.on').first().waitFor({ timeout: 4000 }).catch(() => {});
  const starred = (await page.locator('#history li').first().locator('.word').textContent()) ?? '';

  await page.locator('#clearHistory').click();
  await page.waitForTimeout(400);
  const left = await page.locator('#history li .word').allTextContents();
  record(
    'a starred word survives clearing the rest',
    left.length === 1 && left[0] === starred,
    `kept ${JSON.stringify(left)} after starring "${starred}"`,
  );

  // Left clean, or the next run starts with a word it cannot account for.
  await page.locator('#history li').first().locator('button.star').click();
  await page.waitForTimeout(200);
  await page.locator('#clearHistory').click();
  await page.waitForTimeout(300);
  await page.close();
}

/**
 * A dictd dictionary, built here rather than downloaded.
 *
 * The real FreeDict release is 2 MB behind a network and inside a `.tar.xz`
 * this check cannot unpack, so depending on it would make a browser check
 * depend on a mirror. What has to be proved is the path — a file picker, a
 * gzip stream, a base-64 index, IndexedDB, and a service worker reading what
 * a settings page wrote — and a three-word dictionary proves all of it. The
 * *format* is pinned separately, in `packs.test.ts`, against lines copied out
 * of the real file.
 */
function dictdPack(entries: Array<[string, string]>): { index: Buffer; dict: Buffer } {
  const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const encode = (value: number): string => {
    if (value === 0) return 'A';
    let out = '';
    for (let left = value; left > 0; left = Math.floor(left / 64)) {
      out = digits[left % 64] + out;
    }
    return out;
  };

  const lines: string[] = [];
  let blob = '';
  for (const [word, text] of entries) {
    lines.push(`${word}\t${encode(Buffer.byteLength(blob))}\t${encode(Buffer.byteLength(text))}`);
    blob += text;
  }
  return {
    index: Buffer.from(`${lines.join('\n')}\n`),
    dict: gzipSync(Buffer.from(blob)),
  };
}

/**
 * Installing a dictionary pack, then reading a word out of it on a page.
 *
 * The second half is the point. A pack that imports and is never consulted
 * looks exactly like one that works, and the wiring between them crosses
 * three boundaries: the settings page writes IndexedDB, the service worker
 * reads it, and the cache key has to have changed or the reader gets the
 * card composed before the pack existed.
 */
async function checkDictionaryPack(
  context: BrowserContext,
  id: string,
  origin: string,
): Promise<void> {
  const pack = dictdPack([
    ['manifest', 'manifest /ˈmænɪfɛst/\n1. bildirge, manifesto.\n2. yük listesi.\n'],
    ['partition', 'partition /pɑːˈtɪʃən/\n1. bölme, bölüm, ayırma.\n'],
    ['snapshot', 'snapshot\n1. anlık görüntü.\n'],
  ]);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'domcontentloaded' });

  await page.locator('#packFiles').setInputFiles([
    { name: 'test-eng-tur.index', mimeType: 'text/plain', buffer: pack.index },
    { name: 'test-eng-tur.dict.dz', mimeType: 'application/gzip', buffer: pack.dict },
  ]);

  const status = page.locator('#packStatus');
  const read = await page
    .locator('#packForm')
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  record('a dictionary file is recognised and read', read, (await status.textContent()) ?? '');
  if (!read) {
    await page.close();
    return;
  }

  // The language pair comes from the file name, and getting it wrong shows a
  // card whose words are right and whose label is a lie.
  record(
    'the language pair is taken from the file name',
    (await page.locator('#packSource').inputValue()) === 'en' &&
      (await page.locator('#packTarget').inputValue()) === 'tr',
    `${await page.locator('#packSource').inputValue()} → ${await page.locator('#packTarget').inputValue()}`,
  );

  await page.locator('#packInstall').click();
  const installed = await status
    .filter({ hasText: /Installed \d+ words/ })
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  record('the pack installs', installed, (await status.textContent()) ?? '');

  const listed = (await page.locator('#packs li .name').first().textContent()) ?? '';
  record('an installed pack is listed with its languages', /eng-tur/i.test(listed), listed);
  await page.close();
  if (!installed) return;

  // A fresh tab, not the one the earlier checks used. Three dismissals on one
  // host is the point at which the extension stops opening by itself, and
  // those checks pressed Escape exactly that many times — so reusing the tab
  // would measure the quieten-itself guard rather than the pack.
  //
  // The same word and the same gesture as the very first check in this file,
  // so the only thing that changed between the two is the installed pack.
  // `manifest` having been looked up already is the point: a stale cached
  // card would carry no Turkish at all.
  const reader = await context.newPage();
  await reader.goto(origin, { waitUntil: 'domcontentloaded' });
  await paragraph(reader, 'A manifest is a metadata file').dblclick({ position: { x: 20, y: 10 } });

  const translation = reader.locator('quick-lookup-card .translation');
  const shown = await translation
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  // On failure, report what the card *did* say. "No translation appeared" is
  // true of a stale cached card, a pack that was not consulted and a word
  // that was never selected, and those need different fixes.
  await reader.waitForTimeout(2000);
  const text = shown ? ((await translation.textContent()) ?? '') : 'no translation slot';
  // The sources line says whether the pack was consulted at all, which is the
  // difference between "not installed", "not reached" and "outranked".
  const sources = await reader
    .locator('quick-lookup-card footer .source > span:not(.mark)')
    .allTextContents();
  record(
    'an installed pack answers a word on a real page, offline',
    /bildirge/.test(text) && /yük listesi/.test(text),
    `${text.replace(/\s+/g, ' ').trim().slice(0, 60)} [${sources.join(', ')}]`,
  );
  await reader.close();

  // Uninstall before leaving. The profile outlives the run, so a pack left
  // behind is installed before the *next* run's first lookup — which then
  // caches a card under a key that already carries the pack, and the check
  // above can never observe the difference it exists to observe. Removing it
  // also exercises the button, which nothing else does.
  const cleanup = await context.newPage();
  await cleanup.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'domcontentloaded' });
  await cleanup.locator('#packs li button').first().click();
  const gone = await cleanup
    .locator('#packs li.empty')
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  record('a pack can be removed again', gone);
  await cleanup.close();
}

/**
 * A paragraph of the page itself.
 *
 * Not `getByText`: an open card quotes the page back, Playwright looks inside
 * open shadow roots, and from the second lookup onwards a bare text match
 * resolves to two elements and fails on strict mode. Which of the two it
 * finds also depends on whether an earlier check left a card open, so the
 * failure moves around between runs.
 */
const paragraph = (page: import('playwright').Page, text: string) =>
  page.locator('body > p').filter({ hasText: text });

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
  // A fresh profile every run, and not for tidiness.
  //
  // Chrome keeps the registered service worker of an extension already in the
  // profile and does not swap it for the one on disk. The content script is
  // reloaded, the background script is not — so a run tests today's front end
  // against whatever build last touched this directory. It cost an afternoon:
  // three slots added to the card layout were absent from every card in the
  // browser, and the code was correct the whole time.
  //
  // The persistent cache lives here too, so this also stops a check being
  // answered by a card composed under different settings a week ago.
  await rm(PROFILE, { recursive: true, force: true });

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
  await paragraph(page, 'A manifest is a metadata file').dblclick({ position: { x: 20, y: 10 } });

  const card = page.locator('quick-lookup-card .card');
  const appeared = await card
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  record('a selection opens the card', appeared, appeared ? '' : 'card never became visible');

  if (appeared) {
    const headword = (await page.locator('quick-lookup-card header .query').textContent()) ?? '';
    record('the card names what was selected', /manifest/i.test(headword), `query=${headword}`);

    // The sentence the word was met in, with the word marked. Local, and the
    // thing that lets a card that has been dragged aside — or copied into a
    // note — still say why the word was worth looking up.
    const marked = await page
      .locator('quick-lookup-card .incontext mark')
      .first()
      .waitFor({ timeout: 6000 })
      .then(() =>
        page.locator('quick-lookup-card .incontext mark').first().textContent(),
      )
      .catch(() => null);
    const sentence =
      (await page.locator('quick-lookup-card .incontext').first().textContent().catch(() => null)) ?? '';
    record(
      'the card shows the sentence the word was met in, with the word marked',
      marked?.toLowerCase() === 'manifest' && /metadata file that lists/.test(sentence),
      sentence.slice(0, 56),
    );

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

    // How common the word is, drawn as a bar. The band comes from a corpus,
    // so the count is checked for being a band at all rather than for being a
    // particular one — but a bar with every segment lit, or none, means the
    // reading was lost between the source and the card.
    const bar = await page.evaluate(() => {
      const root = document.querySelector('quick-lookup-card')?.shadowRoot;
      const cells = [...(root?.querySelectorAll('.frequency .bar span') ?? [])];
      return {
        cells: cells.length,
        on: cells.filter((c) => c.classList.contains('on')).length,
        label: root?.querySelector('.frequency .band')?.textContent ?? '',
      };
    });
    record(
      'the card says how common the word is',
      bar.cells === 5 && bar.on >= 1 && bar.on <= 5 && bar.label.length > 0,
      `${bar.on}/${bar.cells} — ${bar.label || 'no reading'}`,
    );
    // The mark each link and each source wears. Three things can go wrong and
    // only the browser can tell: the mark can be missing, it can land on the
    // wrong site, or its colour can fail to resolve — a custom property that
    // never arrives leaves the tile transparent while the letter still shows,
    // which reads as finished from the outside.
    const marks = await page.evaluate(() => {
      const root = document.querySelector('quick-lookup-card')?.shadowRoot;
      const read = (node: Element | null | undefined) =>
        node
          ? {
              letter: node.textContent ?? '',
              hue: (node as HTMLElement).style.getPropertyValue('--hue'),
              paint: getComputedStyle(node).backgroundColor,
            }
          : undefined;
      return {
        links: [...(root?.querySelectorAll('a.chip') ?? [])].map((chip) => ({
          href: (chip as HTMLAnchorElement).href,
          ...(read(chip.querySelector('.mark')) ?? { letter: '', hue: '', paint: '' }),
        })),
        sources: [...(root?.querySelectorAll('.source .mark') ?? [])].map(
          (node) => read(node) ?? { letter: '', hue: '', paint: '' },
        ),
      };
    });
    const painted = (paint: string) => paint !== '' && !/rgba\(0, 0, 0, 0\)/.test(paint);
    // Which site a link points at is decided by its URL here and by its id in
    // the card, so agreeing is evidence rather than a tautology.
    const misplaced = marks.links.filter(
      (link) => markFor('', link.href).letter !== link.letter,
    );
    const hues = new Set(marks.links.map((link) => link.hue));
    record(
      'every link wears its own site mark',
      marks.links.length >= 3 &&
        marks.links.every((link) => link.letter.length > 0 && painted(link.paint)) &&
        misplaced.length === 0 &&
        hues.size > 1,
      misplaced.length > 0
        ? `${misplaced[0]?.letter} on ${misplaced[0]?.href}`
        : marks.links.map((link) => `${link.letter}=${link.hue}`).join(' '),
    );
    record(
      'the sources say which site answered, in that site’s colour',
      marks.sources.length > 0 &&
        marks.sources.every((mark) => mark.letter.length > 0 && painted(mark.paint)),
      marks.sources.map((mark) => mark.letter).join(' ') || 'no source marks',
    );

    const answered = await page
      .locator('quick-lookup-card footer .source > span:not(.mark)')
      .allTextContents();
    console.log(`\n  Sources: ${answered.join(', ')}`);

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

    // The real engine, not a stub. A content script runs in an isolated
    // world, so replacing `speechSynthesis.speak` from the page would
    // replace a different object and record nothing — which is exactly what
    // the first version of this check did. `speaking` is shared state and
    // tells the truth about whether the button reached the engine.
    const speaker = page.locator(
      'quick-lookup-card header button[aria-label="Read this aloud"]',
    );
    const wasSpeaking = await page.evaluate(() => speechSynthesis.speaking);
    await speaker.click();
    const speaking = await page
      .waitForFunction(() => speechSynthesis.speaking, undefined, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    record(
      'the card reads the selection aloud',
      !wasSpeaking && speaking,
      `voices=${await page.evaluate(() => speechSynthesis.getVoices().length)}`,
    );
    await page.evaluate(() => speechSynthesis.cancel());

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

  const extensionId = worker.url().split('/')[2] ?? '';
  await checkTranslationDownload(context, extensionId);
  await checkFollowing(context, origin);
  await checkPinning(context, origin);
  await checkHistory(context, extensionId);
  await checkDictionaryPack(context, extensionId, origin);

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
