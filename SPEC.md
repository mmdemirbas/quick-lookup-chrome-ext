# Quick Lookup — build specification

Version 2. Supersedes the first specification, which is kept in git
history. The research and reasoning behind these decisions is in
`docs/redesign-2026-08-11.md`.

## 1. Goal

One gesture on any selected text returns the most useful answer for that
kind of text, in place, fast enough that no other tool is worth opening.

Three primary jobs:

1. An English word — what it means here, how it is said, how it is used.
2. A technical term — what it is in this page's context, and where the
   real documentation is.
3. A person or named entity — who, why known, and when.

## 2. Principles

These decide arguments. When two of them conflict, the earlier one wins.

1. **Never annoying.** The tool may be wrong or slow. It may never be in
   the way. Any behaviour that interrupts reading is a defect.
2. **Evidence, not invention.** Facts come from data sources. A language
   model may classify, rank, translate and phrase. It may never be the
   source of a fact.
3. **Fast first, deep on request.** A useful answer inside 400 ms. Deeper
   work continues in the background or waits for an explicit ask.
4. **Works with nothing.** No account, no API key, no model download, no
   network for anything already cached. Every capability above that is an
   improvement, never a requirement.
5. **Local by default.** Selected text and page context stay on the
   device unless a data source is explicitly queried for them.

## 3. Platforms

Desktop is the primary target. Mobile is welcome where it is free.

| Target | Status | Notes |
|---|---|---|
| Brave | Primary | Chromium MV3. Built-in AI only after manual setup |
| Chrome 138+ | First class | Built-in AI available with no setup |
| Edge 138+ | First class | Same API names, different models |
| Firefox | Best effort | Different extension AI API, no free-form generation |

The extension is installed unpacked. Store publishing is out of scope.

## 4. Architecture

Four layers. Dependencies point downward only.

```
content  ──┐
background ├──►  core  (pure, no browser APIs, no I/O)
options  ──┘       ▲
                   │
                platform  (browser APIs, network, inference adapter)
```

- **core** — intent detection, provider definitions, card composition,
  ranking, caching policy. No `chrome.*`, no `fetch`. Every dependency is
  injected. This layer is unit tested.
- **platform** — the browser namespace shim, the HTTP client, storage,
  and the inference adapter. The only layer that knows which browser it
  is running in.
- **background** — the service worker. Owns orchestration, deadlines,
  the cache, and history.
- **content** — selection detection, the handle, and the card. Runs in a
  shadow root.

### 4.1 Inference adapter

One interface, several implementations, chosen by capability detection.
No code above the adapter names a browser.

```ts
type Capabilities = {
  classify: boolean;   // pick one option from a list
  translate: boolean;  // language pair translation
  generate: boolean;   // free-form text
  detect: boolean;     // language detection
};
```

| Implementation | Detected by | Provides |
|---|---|---|
| `webml` | `LanguageModel` / `Translator` / `LanguageDetector` globals | All four. Chrome, Edge, and Brave once enabled |
| `firefox` | `browser.trial.ml` | Classification and summarisation only |
| `none` | nothing detected | Nothing. The default assumption |

The adapter never throws on absence. Callers ask for a capability and
take the answer.

**The no-model path is the default path.** Chrome and Edge both refuse to
download the model on a metered connection, so the extension must be
complete without it.

## 5. Triggering

### 5.1 Selection

On by default. The card opens after the selection settles.

Ten guards keep it quiet. All are default behaviour, not settings:

1. Open 250 ms after the selection settles, not on `mouseup`.
2. A copy shortcut within the dwell window cancels the card.
3. Nothing renders while the mouse button is down.
4. Beyond 12 words, show the handle only.
5. Editable fields are excluded unless enabled.
6. The card never covers the selection.
7. The card never takes keyboard focus and never scrolls the page.
8. Selections inside the card itself are ignored.
9. Three dismissals without interaction on one site in one session offer
   handle-only mode for that site.
10. The card header carries a one-click site kill switch.

### 5.2 Modifier and hover

Hold the modifier and point at a word. No selection needed. The span
starts at the token under the cursor and grows to the longest known entry
that starts there.

While the modifier is held:

- `→` extends the span one word right, `←` shrinks it.
- `Shift`+`←` extends the span one word left.

The card re-queries as the span changes.

### 5.3 Other paths

- A keyboard shortcut looks up the current selection.
- The context menu offers a lookup on any selection.

## 6. Intent routing

Cheap deterministic signals first. The model is consulted only when the
signals are ambiguous, and only to choose from a fixed list.

Intents: `word`, `phrase`, `entity`, `technical`, `citation`,
`quantity`, `foreign`, `unknown`.

Signals are all local and cost under a millisecond: token count, casing,
script, identifier style, shape patterns (year in parentheses, episode
code, DOI, package version, hex colour, IP address), whether the
selection sits inside a code element, and the host.

## 7. Page context

Each page is profiled once and cached for the tab. The profile carries
the title, the first heading, the meta description, the site name, the
host, and the most distinctive terms on the page.

Local context carries the enclosing sentence, the nearest heading above
the selection, and whether the selection is inside code.

Context is used three ways, in increasing order of risk:

1. Bias the search query sent to a source.
2. Rank returned senses by overlap with the topic and the sentence.
3. Ask the model to choose one of the senses a source returned.

## 8. Answer composition

Each intent maps to a layout of named slots. Providers write into slots.
The card renders slots as they arrive and reserves their height, so
nothing below moves.

Slots: `headword`, `pronunciation`, `gloss`, `senses`, `related`,
`translation`, `entity`, `facts`, `extract`, `links`, `sources`.

Several providers may write the same slot. Merge rules are per slot:
first non-empty for scalars, deduplicated union for lists, with the
source recorded for every item.

## 9. Sources

More than one source per job. Backups are expected, and mixing produces a
richer answer than any single source.

| Source | Used for | Notes |
|---|---|---|
| freedictionaryapi.com | Definitions, pronunciation | Wiktionary data, 1000 req/hour/IP, no key |
| en.wiktionary.org REST | Definitions | Independent path on Wikimedia infrastructure |
| Datamuse | Synonyms, related words, collocations | Free to 100k/day until 2027-01-01 |
| Wikipedia REST | Entity and technical summaries | Edge cached, the fastest measured source |
| Wikidata | Structured facts, images | Not cached upstream. Background only |

Rules for every source:

- Send `Api-User-Agent` with a contact address on Wikimedia requests.
- Treat every source as optional. A failure removes a slot, never the card.
- Never scrape HTML from a site that has no API.

## 10. Performance budget

| Stage | Budget |
|---|---|
| Handle visible | No work at all |
| Card frame and skeleton | 16 ms |
| Full answer from warm cache | 120 ms |
| First evidence slot | 400 ms |
| All slots settled or marked absent | 1200 ms |
| Deep work on request | No budget, runs in the background |

A new selection aborts every request in flight.

Cache has two layers: an in-memory map in the service worker, and
`storage.local` with a time to live behind it.

## 11. Storage

- `storage.sync` — preferences only. Never credentials.
- `storage.local` — cache, history, per-site settings, and any key the
  user chooses to add.

## 12. Security and privacy

- No remote code. No `eval`. No third-party HTML injected into the page.
- Every value from a source is inserted as text, never as markup.
- Only hosts listed in the manifest are contacted.
- No analytics.

## 13. Quality gates

All four must pass before any change is considered done:

```
npm run typecheck    # tsc --noEmit, no errors
npm test             # unit tests over core, all passing
npm run build        # produces a loadable unpacked extension
npm run check        # all of the above
```

Core logic is tested without a browser. Anything that needs a browser API
lives in `platform` behind an interface that tests can substitute.

## 14. Roadmap

| Phase | Content |
|---|---|
| 1 | Foundation, trigger, card shell, English word lookup |
| 2 | Intent router, entity and technical paths, page context |
| 3 | Inference adapter — classification, translation, phrasing |
| 4 | History, bookmarks, export, side panel for depth |
| 5 | Writing tools — summarise, rewrite, proofread |
| 6 | PDF support, accessibility pass, Firefox target |
