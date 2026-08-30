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

### 4.2 What is actually available, measured

Probed on this machine (2026-08-12) by loading the extension and calling
`availability()` inside its service worker:

| Browser | Translator | LanguageModel | Detector, Summarizer |
|---|---|---|---|
| Brave 150, as installed | absent | absent | absent |
| Brave 150, `--enable-features=TranslationAPI` | **downloadable** | absent | absent |
| Brave 150, every AI switch | downloadable | unavailable | absent / unavailable |
| **Chrome 151, no flags** | **downloadable** | unavailable | unavailable |
| Chromium (Chrome for Testing) | downloadable | unavailable | unavailable |

**The translation API is not in Brave's flags UI.** That page lists 760
experiments and none of them is it; the Prompt, Writer, Rewriter and
Summarizer APIs for Gemini Nano are all there, and translation is not. It
can only be turned on with a launch switch, which on macOS means
`open -a "Brave Browser" --args --enable-features=TranslationAPI` and
applies only to launches started that way. Chrome needs nothing.

Two things follow. Translation is the capability worth building for — it is
what the reader asked for, and it is obtainable. Free-form generation is not
reachable on any browser measured here, so nothing may depend on it.

A `downloadable` pair needs an explicit request: browsers gate a language
pack behind a user gesture and will wait forever to be asked. That is why
settings carries a Download button. Without it the translate path could
never become live, however long anyone waited.

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

Hold the modifier and point at a word. No selection needed.

Hovering can only ever indicate one word, so the arrow keys are part of
the trigger rather than an extra. Each arrow grows the span on its own
side; holding shift shrinks that side instead:

| Key | Effect |
|---|---|
| `→` | One more word on the right |
| `←` | One more word on the left |
| `Shift`+`→` | One fewer word on the right |
| `Shift`+`←` | One fewer word on the left |

The span never collapses below one word and never leaves the text node,
so a held key is safe. The card re-queries as the span changes: the dwell
applies to pointer movement, but an arrow key fires at once, because it
is a deliberate act rather than a side effect of moving the mouse.

Word boundaries come from `Intl.Segmenter`, so scripts that do not
separate words with spaces behave correctly.

The pointer listener is attached when the modifier goes down and removed
when it comes up. A page where the reader never hovers pays nothing per
mouse move.

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
selection sits inside a code element, the host, and which software
ecosystems the page shows evidence of.

## 7. Page context

Each page is profiled once and cached for the tab. The profile carries
the title, the first heading, the meta description, the site name, the
host, and the most distinctive terms on the page.

Local context carries the enclosing sentence, the nearest heading above
the selection, and whether the selection is inside code.

Context is used four ways, in increasing order of risk:

1. **As a source.** The page is scanned locally for a sentence that
   *defines* the selection rather than merely using it. This is the only
   source that can know what a term means here, and it costs no request and
   sends nothing anywhere.
2. Bias the search query sent to a source.
3. Rank returned senses by overlap with the topic and the sentence.
4. Ask the model to choose one of the senses a source returned.

The page text is walked once per page with a `TreeWalker`, never
`innerText`, and built lazily on the first lookup — a page nothing is
looked up on costs nothing. The scan stops at 200,000 characters and at the
fortieth occurrence of the term, because a page that defines a term does so
early.

The patterns are narrow on purpose. A sentence that merely contains the
word is not evidence of anything and there are usually dozens of those.
Three shapes count: the term as the subject of a defining verb, a glossary
entry, and the term introduced as a name for something.

## 8. Answer composition

Each intent maps to a layout of named slots. Providers write into slots.
The card renders slots as they arrive and reserves their height, so
nothing below moves.

Slots: `headword`, `pronunciation`, `gloss`, `senses`, `related`,
`translation`, `entity`, `facts`, `extract`, `onPage`, `links`, `sources`.

Several providers may write the same slot. Merge rules are per slot:
first non-empty for scalars, deduplicated union for lists, with the
source recorded for every item.

Two rules exist because more than one source can answer the same
question:

- **`extract` is owned by source priority, not by arrival order.** An
  article whose title resolved directly leads. A Wikipedia *search* result
  comes last, because it is whatever the search engine judged related —
  for a package name, usually the general article about the language.
  Without this the paragraph shown would depend on which request returned
  first, so the same lookup would differ between a fast network and a slow
  one.
- **The same sentence is never shown twice.** A registry description and a
  tag wiki opening are often word for word identical; printed as both the
  gloss and the summary it reads as a bug.

### 8.1 Taking the card away

The card copies itself in three shapes: plain text, Markdown, and a
tab-separated Anki note. All three come from one reading of the slots, so
one format cannot quietly drift from the others as slots are added.

Two rules decide what a copy contains:

- **What is copied is what is shown.** The same slots in the same order,
  the same caps, and the same suppressions — a summary already folded into
  the entity block is not repeated in the copy either. A copy holding more
  or less than the card did is worse than no copy button, because nothing
  would prompt the reader to check it.
- **A copy carries its provenance.** The sources, the reference URL of
  whichever source supplied the prose, and the page the lookup was made on.
  A note that cannot be traced back is worth much less a month later.

The Anki shape uses Anki's own file headers — `#separator:Tab`,
`#html:true`, `#tags:quick-lookup`, supported from 2.1.54 — so it imports
without touching the options dialog. The first field is the query, which is
also Anki's duplicate key, so looking a word up twice updates the note
rather than adding a second one.

The card never takes focus, so its buttons cannot be reached by tabbing.
`Alt+C` copies the Markdown shape while the card is open. Alt rather than
the configured trigger modifier, which may be set to ctrl or meta and is
already spoken for by the copy-cancels-the-card guard.

Nothing is sent anywhere. The clipboard is the only destination.

## 9. Sources

More than one source per job. Backups are expected, and mixing produces a
richer answer than any single source.

| Source | Used for | Notes |
|---|---|---|
| The page itself | What the term means here | Local, instant, no request. See section 7 |
| freedictionaryapi.com | Definitions, pronunciation | Wiktionary data, 1000 req/hour/IP, no key |
| en.wiktionary.org REST | Definitions | Independent path on Wikimedia infrastructure |
| Datamuse | Synonyms, related words, collocations | Free to 100k/day until 2027-01-01 |
| Wikipedia REST | Entity and technical summaries | Edge cached, the fastest measured source |
| Stack Overflow tag wikis | Definitions of programming terms | 300/day/IP without a key. Technical intent only |
| npm, PyPI, crates.io | Package version, licence, description | One registry per lookup, chosen by the page |
| MDN | Web platform reference | Site search, not a published API. Web and npm pages only |
| MyMemory | Translation, when the browser has none | Off by default. 5,000 chars/day, 50,000 with an address |

Rules for every source:

- Send `Api-User-Agent` with a contact address on Wikimedia requests.
- Treat every source as optional. A failure removes a slot, never the card.
- Never scrape HTML from a site that has no API.

### 9.1 Asking the right registry

Package names collide across ecosystems. `iceberg` is a real npm package
described as "just a pretty iceberg in the console", so a lookup on a page
about the Apache table format would otherwise produce a fact that is true
about something nobody meant.

So a registry is asked only when the page shows evidence of that ecosystem,
from its host and from the vocabulary around the selection. A page with no
such evidence gets no registry request at all. The signal decides which
source to *ask*, never what to believe, so being wrong costs one request.

The same signal widens intent routing: an article about React on a personal
blog is a technical page, and no list of developer hosts will ever contain
the blogs where most reading happens.

### 9.2 Three ways to translate, in order

No single one of these works everywhere, so all three ship and the card
takes the best available.

| Tier | Where it runs | Coverage | Cost |
|---|---|---|---|
| Dictionary head-words | The dictionary request already being made | Partial — Turkish exists for roughly a third of words tried | None |
| On-device translator | The device | Broad | A flag in Brave, nothing in Chrome, plus a one-time download |
| MyMemory | A third party | Broad | Off by default. The selection leaves the device |

The first two are not competitors. A translator renders the selection; a
dictionary gives the head-word for *this sense*, curated, in dictionary
order. The card shows both when both exist — measured on `ephemeral`, the
dictionary says "efemera" and the translator says "geçici".

Only the third changes where the selection goes, so it is the only one
behind a switch, and the switch is off until the reader turns it on.

### 9.3 Not built, and why

- **Wikidata structured facts.** The only route that batches properties with
  their labels resolved is the SPARQL endpoint, measured at 10.7 s — an
  order of magnitude outside the budget. The REST API filters one property
  per request, so a person card would cost six. The Wikipedia summary
  already carries the description and dates for most entities.
- **crates.io `/crates/{name}`.** 422 KB, because it carries every version.
  The search route is 1 KB and the name is checked for an exact match.

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

Cache has two layers, because they solve different problems. The
in-memory map in the service worker only survives within a burst, since
the worker is torn down after about thirty seconds idle. The
`storage.local` layer behind it is what makes a word looked up yesterday
instant today.

A card is cached only when at least one source answered, so a transient
outage cannot stick for a week.

## 11. Storage

- `storage.sync` — preferences only. Never credentials.
- `storage.local` — cache, history, and any key the user chooses to add.
  Local rather than sync because the cache would pass the sync quota
  within a day, and history records what was being read.

Cache entries are stored one key per entry, with a short index of key and
timestamp pairs for eviction. One large map would have to be rewritten on
every lookup, which is the opposite of what a cache is for.

History keeps the most recent 300 lookups. Repeating a query moves its
entry rather than adding one. A starred entry survives both the cap and
Clear.

## 12. Conversation

A lookup answers "what does this mean". Everything else a reader wants from a
page — is this claim true, what is this arguing, how would I reply — is a
conversation, and lives in the panel's second view.

### 12.1 Why the panel and not the card

The card is the fast path and is bound to a selection on a page: it is torn
down when that page goes. A conversation has to outlive navigation, because
the interesting case spans pages — read a post, open the paper it cites, ask
whether the paper says what the post claimed. The panel is browser chrome, so
the page it was opened over has no say in whether it stays.

### 12.2 The page travels with the turn

The conversation belongs to the window; the page belongs to the question. Each
user turn carries the page it was asked against — url, title, the selection if
there was one, and the readable text within a budget. A thread that spans four
pages is therefore honest about which question was asked about which.

Page text comes from the same `pageText()` the lookup uses, so a definition
found on the page and a question asked about the page see the same document.

### 12.3 What is sent, and only then

Nothing reaches the API unless two things are true: a key is stored, and the
reader used the **Discuss this page with Claude** context-menu item. There is
no ambient collection. The gesture is a context-menu click for the same reason
the panel's own opening is: a button in the page reaches the extension as a
message, which leaves the service worker calling `sidePanel.open()` with no
user gesture behind it, and the browser refuses that (§5.3).

The context budget is a setting, defaulting to 24,000 characters. When a page
exceeds it the first part is sent and **the panel says so on the turn** — an
answer about the first third of a page is a different thing from an answer
about the page, and only that line distinguishes them.

### 12.4 Where the thread lives

In the panel document, not the service worker. The worker is torn down after
about thirty seconds of inactivity and would have forgotten the thread between
two questions, so the panel holds it and sends it whole each time. It is
mirrored to `storage.session`, keyed by window, so closing and reopening the
panel does not lose it and closing the browser does.

### 12.5 The cache breakpoint

Prompt caching matches a prefix, so the breakpoint goes on the **last**
attached page. Follow-up questions about the same page then re-send a prefix
that has not changed by a byte and are billed at about a tenth. That is the
common shape — land on a page, ask five things — and without it each of those
five re-sends the whole page at full price.

### 12.6 Models

Sonnet 5 by default, changeable per conversation; Opus 5 for questions that
are actually hard, Haiku 4.5 for cheap ones. Adaptive thinking and the effort
control are sent only to models that accept them — Haiku 4.5 answers a 400,
not a slightly worse reply. Reasoning is requested as a summary so that a
streaming panel has something to show instead of a still box.

### 12.7 Backends

Three of four are built. The seam is `streamChat()` in
`src/platform/anthropic.ts`: `src/core/chat.ts` builds the request and nothing
above it knows how the request is sent.

| Backend | State | Note |
|---|---|---|
| Anthropic API key | built | Works anywhere; metered; key in `storage.local`, never `sync` |
| Hand off to claude.ai | built | Not a backend but an export action, so it sits beside `Ask` rather than behind the seam. No cost, no key; you leave the page to talk |
| Local bridge to Claude Code | built | `bridge/server.mjs`. Spends a subscription rather than a key, and puts no key in the browser at all; only works on the machine running it, only while it runs (§12.9) |
| Built-in browser AI | not built | Measured `unavailable` on every browser on this machine (§4.2). Re-measure before starting |

### 12.8 The keyless path

`handoffPrompt()` composes the question and the page into one block, the panel
puts it on the clipboard, and a tab opens on `claude.ai/new` to paste into.

It renders **the same block** the API path sends, which is the point: the
clipped notice travels with it, so a half-page is declared a half-page
wherever the question is asked. Two formats would have drifted.

The clipboard rather than a query-string prefill. A page excerpt runs to tens
of thousands of characters and would exceed what a URL can carry long before
the context budget does — a prefill would work on short pages and fail
silently on exactly the long ones this exists for.

Because it needs no key, the empty state names it. A panel that says "an API
key is needed" while one of its two buttons works without one is lying by
omission.

### 12.9 The local bridge

`bridge/server.mjs` is a zero-dependency Node process that answers from Claude
Code instead of the API. It speaks **the same wire format** — a Messages body
in, Anthropic-shaped SSE out — so `streamChat()` parses both and choosing a
backend is a URL and a header, not a code path. That is what the seam was for.

**Why `--restricted` is not enough on its own.** The prompt contains a web
page the reader did not write, so the input is attacker-controlled by
construction. `--restricted` removes Bash, PowerShell and the REPL, and the
name suggests that is the end of it — but reading the tool list out of the
session's own `init` event shows **26 tools remaining, including `Edit`,
`Write` and `NotebookEdit`**. A page that can talk an agent into writing a
file has a foothold. The bridge therefore also passes `--disallowed-tools`
for every write, read and network tool, which takes the session to 18 with
none of them left.

`WebSearch` is refused even though it would genuinely help with "is this claim
true". A page that can steer a search can put the page's own contents in the
query, which turns a reading tool into an exfiltration channel. Re-admitting
it needs a way to stop the page choosing the query, and there isn't one yet.

**Why an empty working directory.** Claude Code reads `CLAUDE.md` and the
settings around its cwd. Measured on this machine: a trivial question asked
from a project directory cost **25,012** cache-creation tokens; the same
question from an empty directory with `--restricted --strict-mcp-config
--settings '{}'` cost **10,926**. None of the difference has anything to do
with the page being discussed.

**Why a token, on loopback.** Any page in the browser can `fetch` a localhost
port. It cannot read the reply, but it can send the request, and that alone
spends the subscription this exists to use. A source address is not a peer
identity. The bridge requires a bearer token *and* an `Origin` beginning
`chrome-extension://`.

**Why the bridge answers CORS instead of the extension taking a host
permission.** `http://127.0.0.1/*` in `host_permissions` would have granted
the extension every other service on the machine to solve this one problem.
Instead the bridge echoes `Access-Control-Allow-Origin` for extension origins.
The preflight is answered **before** the token check, because a preflight is
sent by the browser and carries no `Authorization` — authenticating it would
refuse every request before the real one was made.

**What it costs.** About five seconds to the first token against well under
one for the API, because a CLI session starts per question. The bridge is
stateless like the API path: it re-sends the conversation rather than resuming
a session, so the session preamble is paid on every turn. Resuming would fix
that and is not built.

## 13. Security and privacy

- No remote code. No `eval`. No third-party HTML injected into the page.
- Every value from a source is inserted as text, never as markup.
- Only hosts listed in the manifest are contacted.
- No analytics.
- Two things send the reader's text somewhere it was not already going to
  answer a lookup. Both are off until switched on, and both say so where they
  are switched on.
  - A setting sends the *selection* to a translation service. The card names
    the service that answered.
  - The panel's conversation sends the *page* to the Anthropic API. This is
    much the larger of the two — a page can hold a draft, a message thread or
    an account number that no lookup would ever have transmitted — so it needs
    a stored key **and** a per-page gesture, and it never runs by itself
    (§12.3). The turn shows which page was sent and how much of it.
- The bridge token is kept beside the key, under the same rule, and for the
  extra reason that it is machine-specific: the bridge on this laptop has
  nothing to do with any other browser.
- The API key is kept in `storage.local`, never `storage.sync`: settings
  replicate to every browser the reader is signed into and a key must not
  travel that way. It is never put in the `Settings` object, so it cannot
  reach a content script, and the options page shows a mask rather than the
  key. This is storage, not secrecy — extension storage is not encrypted.
- Answers from the model are inserted as text, never as markup. A model
  reading pages the reader did not write is not a source to hand markup
  privileges to in the extension's own origin.

## 14. Quality gates

All four must pass before any change is considered done:

```
npm run typecheck    # tsc --noEmit, no errors
npm test             # unit tests over core, all passing
npm run build        # produces a loadable unpacked extension
npm run check        # all of the above
```

Core logic is tested without a browser. Anything that needs a browser API
lives in `platform` behind an interface that tests can substitute.

## 15. Roadmap

| Phase | Content |
|---|---|
| 1 | Foundation, trigger, card shell, English word lookup |
| 2 | Intent router, entity and technical paths, page context |
| 3 | Inference adapter — classification, translation, phrasing |
| 4 | History, bookmarks, export, side panel for depth |
| 4.5 | Conversation in the panel, Anthropic API backend (§12) |
| 5 | Writing tools — summarise, rewrite, proofread |
| 6 | PDF support, accessibility pass, Firefox target |
