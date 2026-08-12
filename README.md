# Quick Lookup

Select text on any page and get the most useful answer for that kind of
text, in place. An English word gets definitions, pronunciation and
related words. A name gets an entity card. A technical term gets the
sense that fits the page you are reading.

Facts come from data sources. The on-device model, where the browser has
one, only ranks and translates — it is never the source of a fact.

Design and reasoning: `SPEC.md`.
Landscape research and the decisions behind it: `docs/redesign-2026-08-11.md`.

## Build and load

```bash
npm install
npm run build
```

Then, in Brave, Chrome or Edge:

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on Developer mode.
3. Choose "Load unpacked" and select `dist/chromium`.

For Firefox, build with `node build.mjs --firefox` and load
`dist/firefox` through `about:debugging`.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Builds the unpacked extension into `dist/chromium` |
| `npm run dev` | Same, with watch and source maps |
| `npm run typecheck` | Type checks without emitting |
| `npm test` | Unit tests over the pure core, no browser needed |
| `npm run check` | Typecheck, tests and build — the gate before any commit |
| `npm run smoke` | Runs the real pipeline against the real sources |
| `npm run preview` | Builds a page that renders the card outside the extension |

`npm run smoke` is separate from `npm run check` on purpose. Unit tests
use canned payloads, so they keep passing when a source goes down or
changes shape — which is how the previous version shipped a dictionary
provider whose API had started returning 502. The smoke test catches
that, but a network outage is not a reason to block a commit.

## How it decides what to show

1. **Signals.** Token count, casing, script, identifier style, shape
   patterns, whether the selection is inside code, the host, and which
   software ecosystems the page shows evidence of. All local, under a
   millisecond.
2. **Intent.** One of word, phrase, entity, technical, citation,
   quantity, foreign. When the answer is ambiguous the router widens the
   fetch rather than guessing — providers run in parallel and merge, so
   fetching two paths costs one extra request and gives a better card.
3. **Sources.** Several per job, with independent failure modes. One
   source failing removes a slot, never the card. The first one consulted
   is the page itself: it is scanned locally for a sentence that *defines*
   the selection, which is the only way to learn what a term means on this
   particular page. It costs no request and sends nothing anywhere.
4. **Page context.** The page is profiled once — title, headings,
   description — and that profile biases the search and ranks the senses.
   This is what makes `manifest` on an Iceberg page resolve to Apache
   Iceberg rather than the everyday adjective. It also decides which
   sources are worth asking: a package registry answers only on a page
   about that ecosystem, because `iceberg` is a real npm package and it
   is not the one anyone reading about table formats means.

## Triggering

The card opens when you select text. Ten guards keep that from being
intrusive; the two that matter most are a short dwell before opening,
and cancelling entirely if a copy shortcut follows the selection.

Per site, or globally, the trigger can be changed to a handle, to
require a modifier, or to nothing at all. The toolbar popup switches the
current site without opening settings.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings and the lookup cache |
| `contextMenus` | Right-click lookup on a selection |
| `activeTab` | Reading the selection when triggered by the shortcut |
| `<all_urls>` content script | The selection handle must be able to appear on any page. The always-on script only listens for selection changes; everything else is loaded on first use |
| Ten host permissions | Wikipedia, Wiktionary, freedictionaryapi.com, Datamuse, Wikidata, Wikimedia images, Stack Exchange, npm, PyPI, crates.io and MDN. Each is listed with its reason in `manifest.config.js`. The last five are asked only for technical terms, and the registries only on a page about that ecosystem |

## Privacy

- No account, no API key, no analytics, no remote code.
- Selected text is sent only to the data source being queried, and only
  when a lookup was asked for.
- Translation and ranking run on the device when the browser provides a
  model, and are skipped when it does not.
- Everything stored stays local. Preferences sync; the cache does not.
