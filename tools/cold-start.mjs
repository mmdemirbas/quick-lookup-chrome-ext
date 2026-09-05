/**
 * How long after a cold start is a card still empty — and why?
 *
 * The browser suite went red about one run in two on checks that read slots
 * off the first card, and "flaky" was as far as reading got. This is what
 * turned it into numbers, and then into a cause: repeat the first selection
 * on a fresh profile and report what the card held, and when.
 *
 * Four measurements, because each answers a different question:
 *
 *   repeat  — one selection per fresh page, sampled once at 2.5s.
 *             Is the first card empty at all?
 *   watch   — one selection, watched second by second to 40s.
 *             Is an empty card late, or lost?
 *   first   — three fresh profiles, the page's own answer polled every 20ms.
 *             How soon is the sentence the reader met the word in on screen?
 *   wake    — the worker stopped over the DevTools protocol, then a lookup.
 *             What does a lookup cost after Chrome has idled the worker out?
 *             Playwright's attached session keeps a worker alive, so waiting
 *             for the idle timeout measures nothing; stopping it is the only
 *             way to reach that state from here.
 *
 * Run with `node tools/cold-start.mjs [repeat|watch|first|wake]` after
 * `npm run build`. Nothing here asserts; it prints. The suite is where
 * assertions live — this exists so the next person to see that flake can
 * re-measure in one command instead of re-deriving the method.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(here, '..', 'dist', 'chromium');
const PROFILE = path.join(here, '..', 'dist', 'cold-start-profile');

/** The same paragraph the suite uses, so the numbers are about the same card. */
const FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Apache Iceberg table specification</title></head><body><h1>Table spec</h1>
<p>A manifest is a metadata file that lists the data files making up a snapshot,
together with their partition values and per-column statistics.</p></body></html>`;

/** What the card is holding right now, read from its shadow root. */
const readCard = () => {
  const root = document.querySelector('quick-lookup-card')?.shadowRoot;
  if (!root) return { card: false, pending: 0, sections: [], sources: [], onPage: false };
  const sections = [...root.querySelectorAll('section')];
  return {
    card: true,
    pending: root.querySelectorAll('section.pending').length,
    sections: [...root.querySelectorAll('section .label')].map((el) => el.textContent ?? ''),
    sources: [...root.querySelectorAll('footer .source > span:not(.mark)')].map(
      (el) => el.textContent ?? '',
    ),
    onPage: sections.some((section) => /On this page/.test(section.textContent ?? '')),
  };
};

async function selectManifest(page, origin) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page
    .locator('p', { hasText: 'A manifest is a metadata file' })
    .first()
    .dblclick({ position: { x: 20, y: 10 } });
}

/**
 * Milliseconds from the double-click until the page's own answer is drawn,
 * polled finely enough that the number means something.
 */
async function timeToPageAnswer(page, origin, cap = 20_000) {
  await selectManifest(page, origin);
  const clicked = Date.now();
  for (;;) {
    const state = await page.evaluate(readCard);
    const elapsed = Date.now() - clicked;
    if (state.onPage) return elapsed;
    if (elapsed > cap) return -1;
    await page.waitForTimeout(20);
  }
}

async function launch() {
  // Fresh, or the first lookup is not a first lookup: Chrome keeps the
  // registered service worker of an extension already in the profile.
  await rm(PROFILE, { recursive: true, force: true });
  return chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: process.env.HEADED !== '1',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
}

async function main() {
  const mode = process.argv[2] ?? 'repeat';

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;

  if (mode === 'first') {
    for (let run = 1; run <= 3; run += 1) {
      const context = await launch();
      const page = await context.newPage();
      const ms = await timeToPageAnswer(page, origin);
      console.log(`fresh profile, run ${run}: page's own answer drawn at ${ms < 0 ? 'never (20s cap)' : `${ms} ms`}`);
      await context.close();
    }
  } else if (mode === 'wake') {
    const context = await launch();
    const page = await context.newPage();
    console.log('fresh profile        :', await timeToPageAnswer(page, origin), 'ms');
    console.log('warm                 :', await timeToPageAnswer(page, origin), 'ms');

    // Stop the worker the way Chrome would after thirty seconds idle.
    const cdp = await context.newCDPSession(page);
    const versions = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
      for (const version of event.versions) versions.set(version.versionId, version);
    });
    await cdp.send('ServiceWorker.enable');
    await page.waitForTimeout(500);
    for (const version of versions.values()) {
      if (/^chrome-extension:/.test(version.scriptURL)) {
        await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      }
    }
    await page.waitForTimeout(1000);
    const status = [...versions.values()]
      .filter((version) => /^chrome-extension:/.test(version.scriptURL))
      .map((version) => version.runningStatus);
    console.log('worker after stop    :', status.join(', ') || 'not listed');
    await cdp.detach();

    console.log('after the stop       :', await timeToPageAnswer(page, origin), 'ms');
    console.log('warm again           :', await timeToPageAnswer(page, origin), 'ms');
    await context.close();
  } else if (mode === 'watch') {
    const context = await launch();
    const page = await context.newPage();
    await selectManifest(page, origin);
    const clicked = Date.now();
    let last = '';
    for (let i = 0; i < 40; i += 1) {
      const state = await page.evaluate(readCard);
      const line = `card=${state.card} pending=${state.pending} sections=[${state.sections}] sources=[${state.sources}]`;
      if (line !== last) {
        console.log(String(Date.now() - clicked).padStart(6), 'ms', line);
        last = line;
      }
      await page.waitForTimeout(1000);
    }
    await context.close();
  } else {
    const context = await launch();
    for (let i = 0; i < 14; i += 1) {
      const page = await context.newPage();
      await selectManifest(page, origin);
      await page.waitForTimeout(2500);
      const state = await page.evaluate(readCard);
      console.log(
        String(i).padStart(2),
        `card=${String(state.card).padEnd(5)}`,
        `pending=${state.pending}`,
        `sections=${String(state.sections.length).padEnd(2)}`,
        `sources=[${state.sources.join('|')}]`,
      );
      await page.close();
    }
    await context.close();
  }

  server.close();
}

await main();
