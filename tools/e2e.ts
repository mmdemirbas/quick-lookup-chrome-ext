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
</body></html>`;

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

    // Escape must close it, because that is the reader's escape hatch.
    await page.keyboard.press('Escape');
    const closed = await card
      .waitFor({ state: 'hidden', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    record('Escape closes the card', closed);
  }

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
