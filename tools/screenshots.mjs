// Render the card pictures in docs/images from the preview page.
//
//     npm run preview && node tools/screenshots.mjs
//
// The preview mounts the real CardView on canned answers (tools/card-preview.ts),
// so the pictures show the current card without the extension, a browser
// profile or a network. The card lives in a shadow root, so each shot is
// clipped to its largest box rather than taken by selector.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const page = pathToFileURL(`${root}dist/preview/index.html`).href;
const out = `${root}docs/images`;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const scheme of ['light', 'dark']) {
  const p = await browser.newPage({ viewport: { width: 760, height: 1400 }, deviceScaleFactor: 2, colorScheme: scheme });
  await p.goto(page);
  await p.waitForTimeout(600);
  for (const kind of ['Word', 'Technical', 'Entity']) {
    await p.click(`#controls button:text-is("${kind}")`);
    await p.waitForTimeout(500);
    const clip = await p.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
      const box = [...host.shadowRoot.querySelectorAll('*')]
        .map((e) => e.getBoundingClientRect())
        .filter((b) => b.width > 200 && b.height > 200)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    const file = `${out}/card-${kind.toLowerCase()}-${scheme}.png`;
    await p.screenshot({ path: file, clip });
    console.log(file);
  }
  await p.close();
}
await browser.close();
