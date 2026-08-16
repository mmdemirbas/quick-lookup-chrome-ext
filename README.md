# Quick Lookup

Select text on any page and get the most useful answer for that kind of
text, in place. An English word gets definitions, pronunciation and
related words. A name gets an entity card. A technical term gets the
sense that fits the page you are reading.

Facts come from data sources. The on-device model, where the browser has
one, only ranks and translates — it is never the source of a fact.

Design and reasoning: `SPEC.md`.
Landscape research and the decisions behind it: `docs/redesign-2026-08-11.md`.
Competitor survey, defect causes and the current roadmap: `docs/round-2026-08-16.md`.
Current health, live source and relevance results: `docs/status-2026-08-16.md`.

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
| `npm run sweep` | Puts 20 known terms through the entity provider against live Wikipedia |
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

## Keeping what you find

Every card copies itself, from the row at its foot: as plain text, as
Markdown for notes, or as a tab-separated Anki note that imports without
touching Anki's options dialog. `Alt+C` takes the Markdown version without
reaching for the mouse.

What you copy is what you see, plus the sources, the reference link and the
page you were on. It goes to the clipboard and nowhere else.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings and the lookup cache |
| `contextMenus` | Right-click lookup on a selection |
| `activeTab` | Reading the selection when triggered by the shortcut |
| `<all_urls>` content script | The selection handle must be able to appear on any page. The always-on script only listens for selection changes; everything else is loaded on first use |
| Thirteen host permissions | Wikipedia, Wiktionary, freedictionaryapi.com, Datamuse, Wikidata, Wikimedia images, Stack Exchange, npm, PyPI, crates.io, MDN, MyMemory and Google Translate. Each is listed with its reason in `manifest.config.js`. Stack Exchange, the registries and MDN are asked only for technical terms, the registries only on a page about that ecosystem, and the two translators only if you switch translation on |

## Privacy

- No account, no API key, no analytics, no remote code.
- Selected text is sent only to the data source being queried, and only
  when a lookup was asked for.
- A copied card carries the URL of the page you were on, so the note can
  be traced back later. It reaches the clipboard and nothing else.
- One setting, off by default, sends the selection to a translation
  service for machines whose browser has no translator of its own. It is
  the only thing here that sends your text somewhere it was not already
  going, and the card names the service that answered. Two services are
  available and either can be chosen alone: Google's keyless endpoint,
  which has no allowance to exhaust, and MyMemory, which is documented
  but limited to 5,000 characters a day.
- Translation and ranking run on the device when the browser provides a
  model, and are skipped when it does not.
- Everything stored stays local. Preferences sync; the cache does not.
