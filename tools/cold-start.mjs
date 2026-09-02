/**
 * How long after a cold start is a card still empty?
 *
 * The browser suite went red about one run in two on checks that read slots
 * off the first card, and "flaky" was as far as reading got. This is what
 * turned it into a number: repeat only the first selection, on a fresh
 * profile, and report what the card held each time.
 *
 * Two measurements, because the interesting question is not how long it takes
 * but whether a card that is empty at 2.5s is *late* or *lost*:
 *
 *   repeat  — one selection per fresh page, sampled once at 2.5s
 *   watch   — one selection, watched second by second to 40s
 *
 * Run with `node tools/cold-start.mjs [repeat|watch]` after `npm run build`.
 * Nothing here asserts; it prints. The suite is where assertions live — this
 * exists so the next person to see that flake can re-measure in one command
 * instead of re-deriving the method.
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
  if (!root) return { card: false, pending: 0, sections: [], sources: [] };
  return {
    card: true,
    pending: root.querySelectorAll('section.pending').length,
    sections: [...root.querySelectorAll('section .label')].map((el) => el.textContent ?? ''),
    sources: [...root.querySelectorAll('footer .source > span:not(.mark)')].map(
      (el) => el.textContent ?? '',
    ),
  };
};

async function selectManifest(page, origin) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page
    .locator('p', { hasText: 'A manifest is a metadata file' })
    .first()
    .dblclick({ position: { x: 20, y: 10 } });
}

async function main() {
  const mode = process.argv[2] ?? 'repeat';

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;

  // Fresh, or the first lookup is not a first lookup: Chrome keeps the
  // registered service worker of an extension already in the profile.
  await rm(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: process.env.HEADED !== '1',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });

  if (mode === 'watch') {
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
  } else {
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
  }

  await context.close();
  server.close();
}

await main();
