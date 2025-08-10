You are generating a Chrome/Chromium Manifest V3 extension named **Quick Lookup**.

## 0) Goals & Principles
- Purpose: **Instant** info for selected text with minimal friction.
- Priorities: speed > correctness > clarity > features.
- Primary use-cases: (a) translation, (b) named entities (people/places/works) with image, (c) definitions; then links.
- Privacy by default: no servers, no analytics, no remote code.

## 1) UX Spec

### Triggering
- **Default:** Auto-open popup on text selection mouseup (no keyboard shortcut).
- Ignore selections inside editable fields (`input`, `textarea`, `contenteditable`) unless user enables “work in editors”.
- Debounce 120–180 ms; ignore selections > 300 chars; ignore whitespace-only.
- **Config options:**
  - “Require modifier”: none | Alt | Ctrl | Cmd (default: none).
  - “Open via context menu” (always on): `Quick Lookup “{text}”`.
  - Disable per-site toggle (three-dot menu in header).

### Popup
- Inject near selection; reposition to stay **inside viewport** (8px margin).
- **Draggable** via header; **Resizable** (min 320×200).
- **Pin/Unpin**; pinned persists across navigations (until closed).
- Tabs (horizontal): **Overview** | **Sources** | **History** | **Settings**.
- Theme: Dark/Light/Auto via `prefers-color-scheme`; expose CSS variables.
- Keyboard: `Esc` closes; `Tab` cycles focus; arrow keys navigate lists; ARIA roles.

### Results Ranking (first-screen content)
- If text language ≠ UI language → **Translation** panel first.
- If looks like a named entity → **Entity card** (Wikipedia/Wikidata summary + image).
- If single word → **Dictionary** first.
- Always show **Quick Links** row (Google, MDN, etc.) for one-click deep dives.

### Entity Heuristics (cheap & fast)
- Signals: Capitalized multi-word phrase; contains known honorifics (“Dr.”, “Mr.”), year-in-parens, or media hints (“(film)”, “S01E03”).
- Try **Wikidata/Wikipedia search** for exact/close match in user or detected language.
- If matched and entity has image (Wikidata P18 or Wikipedia pageimage), show it.

## 2) Architecture (MV3)

### Processes & Flow
- **Content Script:** detect selections; draw Shadow-DOM popup; handle UI; send queries.
- **Background (service worker):** fetch provider data, map/normalize JSON, cache, rate-limit, store history.
- **Options Page:** provider order/toggles, theme, triggers, language prefs.
- **Action Popup (toolbar):** quick access to History/Settings when no selection.

### Data Types (TypeScript)
```ts
export type Query = { text: string; langUI: string; langDetected?: string };
export type Result = {
  providerId: string; title: string; snippet?: string; url?: string;
  imageUrl?: string; extra?: Record<string, any>;
};
export interface Provider {
  id: string;
  displayName: string;
  kind: "json" | "link";
  enabledByDefault: boolean;
  query: (q: Query, signal: AbortSignal) => Promise<Result[]>;
}
````

## 3) Providers

### Built-in Defaults (no accounts)

* **Wikipedia (JSON)**: REST summary `/{lang}.wikipedia.org/api/rest_v1/page/summary/{q}`; map to `{title, extract, page url, thumbnail}`.
* **Wikidata (JSON)**: search + entity lookup for type + **image (P18)**. Prefer Commons file URL thumb for images.
* **Dictionary (JSON)**: `https://api.dictionaryapi.dev/api/v2/entries/{lang}/{q}` (fallback to English).
* **Links (templates)**: MDN, Google, DuckDuckGo, IMDB, Thesaurus, DeepL, Google Translate.
* **Translation (optional inline)**: LibreTranslate endpoint configurable by user (URL + key). If unset, show link buttons instead.

### Provider Plug-in Model (MV3-safe)

* **Link providers:** `{ id, displayName, template }` with `{q}` and `{lang}` tokens.
* **HTTP providers:** `{ endpoint, method, headers, query/body template, jsonPaths }` (declarative map of fields to `Result`); **no arbitrary JS**.
* **Advanced (optional):** support a separate “Custom Providers Pack” extension; communicate via `runtime.connect` with a simple protocol (`query → results`). This allows user-authored JS without violating MV3 CSP.

## 4) Storage Schema

* `storage.sync` (≤100KB): user prefs (`theme`, `trigger`, enabled providers, order, language overrides).
* `storage.local`: cache `{ key: hash(q+provider), value: Result[], expiresAt }`, history `{ q, when, providers[] }`, bookmarks `{ q, note?, tags? }`.
* History cap: N=200; LRU eviction.

## 5) Performance & Reliability

* Parallel fetch with max 4 in-flight; per-provider **timeout 1500 ms**; show partial results fast.
* Abort previous fetches on new selection.
* Two-phase render: skeleton instantly; first result target: cold ≤ 800 ms (Wikipedia), warm (cache) ≤ 120 ms.
* Rate limit per provider: 5 req / 10 s; exponential backoff on errors.
* Offline: serve cached results; show “offline” badge.

## 6) Security & Privacy

* MV3 CSP; **no eval**, **no remote code**; sanitize any third-party HTML (prefer plaintext).
* Only call whitelisted hosts from `host_permissions`.
* No analytics by default. Optional diagnostics toggle (counts only, no text content).
* Never store selected text remotely; all data remains local.

## 7) Accessibility

* WCAG AA contrast; focus management; labels; roles; escape routes.
* Announce dynamic content with ARIA live regions.

## 8) Settings (with Defaults)

```json
{
  "theme": "auto",
  "trigger": { "mode": "selection", "requireModifier": "none" },
  "limits": { "maxSelectionChars": 300, "concurrency": 4, "timeoutMs": 1500, "cacheTtlHrs": 24 },
  "providersOrder": ["translate", "wikipedia", "wikidata", "dictionary", "links"],
  "providers": {
    "translate": { "inline": false, "libreTranslateUrl": "", "apiKey": "" },
    "wikipedia": { "enabled": true },
    "wikidata": { "enabled": true },
    "dictionary": { "enabled": true, "langFallback": "en" },
    "links": {
      "enabled": true,
      "items": [
        { "id": "google", "displayName": "Google", "template": "https://www.google.com/search?q={q}" },
        { "id": "mdn", "displayName": "MDN", "template": "https://developer.mozilla.org/search?q={q}" },
        { "id": "imdb", "displayName": "IMDB", "template": "https://www.imdb.com/find/?q={q}" },
        { "id": "deepl", "displayName": "DeepL", "template": "https://www.deepl.com/translate#auto/{lang}/{q}" },
        { "id": "gtranslate", "displayName": "Google Translate", "template": "https://translate.google.com/?sl=auto&tl={lang}&text={q}&op=translate" }
      ]
    }
  }
}
```

## 9) Entity & Ranking Logic (pseudocode)

```ts
function inferLang(text): string { /* cheap script/letters + navigator.language */ }
function isSingleWord(text): boolean { /* no spaces after trim and length <= 30 */ }
function looksNamedEntity(text): boolean {
  return /[A-Z][a-z]+(?: [A-Z][a-z]+)+/.test(text) || /(?:\(\d{4}\))|S\d+E\d+/.test(text);
}

async function plan(query: Query) {
  const tasks: string[] = [];
  const differentLang = query.langDetected && query.langDetected !== query.langUI;

  if (differentLang) tasks.push("translate");
  if (looksNamedEntity(query.text)) tasks.push("wikidata", "wikipedia");
  if (isSingleWord(query.text)) tasks.push("dictionary");
  tasks.push("links");
  return dedupePreservingOrder(tasks);
}
```

## 10) Manifest (MV3)

* `permissions`: `storage`, `activeTab`, `scripting`, `contextMenus`
* `host_permissions`: whitelist Wikipedia, Wikidata, dictionary API, and optionally LibreTranslate.
* `background.service_worker`: `background.js`
* `action`: default popup (History/Settings)
* `web_accessible_resources`: content UI bundle + CSS.

Provide a **complete `manifest.json`** with the above.

## 11) File Structure

```
/src
  /background/ (service worker: providers, cache, history)
  /content/    (selection detection, popup mount, messaging)
  /ui/         (Shadow-DOM components, tabs)
  /options/    (settings UI)
  /providers/  (wikipedia.ts, wikidata.ts, dictionary.ts, links.ts)
  /types/
manifest.json
```

## 12) Implementation Requirements

### Content script

* Selection listener; debounce; message `{ type: "QUERY", query }` to background.
* Render popup in Shadow DOM. Header with drag handle, pin toggle, menu (per-site disable).
* Keep within viewport on window resize/zoom; store pinned position in `storage.local`.

### Background

* Provider registry implementing the **Provider** interface.
* Fetch layer with timeout, abort, rate-limit; JSON mapping for HTTP providers.
* Cache (LRU by key); history append; serve from cache when valid.
* Query planner (see §9); run tasks in order with concurrency cap; return partials as they arrive.

### Options page

* Toggle providers, reorder via drag & drop, set theme and triggers.
* Configure LibreTranslate endpoint/key; validate with a test call.

### Default Providers (implement now)

* `wikipedia.ts`: locale-aware summary + page URL + thumbnail.
* `wikidata.ts`: search → entity → P18 image (thumbnail from Commons) + entity type.
* `dictionary.ts`: definition list.
* `links.ts`: templates → single `Result` per link.

### UI

* Overview tab renders: Translation (if available) → Entity card → Definition → Links.
* Sources tab shows per-provider panels (collapsible).
* History tab: last 200 items, search filter, “star” bookmarks.
* Settings tab: all prefs; import/export JSON.

### Theming

* Use CSS variables; Dark/Light/Auto; respect `prefers-color-scheme`.

## 13) Testing

* Unit: providers (happy/timeout/error), cache, planner.
* E2E (Puppeteer): selection → popup placement; pin/resizer; offline mode (serve cache).
* Accessibility: axe-core check; keyboard-only flow.
* Performance budgets: cold first result ≤ 800 ms, warm ≤ 120 ms; log timings in dev mode.

## 14) Delivery

* Build with TypeScript + Vite (ES modules); produce MV3-ready assets.
* Output a zip ready for Chrome “Load unpacked”.

## 15) Future (leave hooks, do not implement now)

* Smart entity classification (person/place/work/org) to tune provider order.
* Local embeddings for offline synonym/related (opt-in).
* Companion “Custom Providers Pack” extension protocol.

## 16) What to Generate Now

* All source files, typed in TS.
* `manifest.json`.
* Minimal icons (placeholder).
* README with setup, build, permissions rationale, privacy statement.
* A small fixtures folder with mocked JSON for tests.

**Important guardrails**

* No scraping of Google/IMDB HTML; use APIs or link templates.
* No remote code or eval; keep CSP strict.
* Keep bundle small; zero heavy UI frameworks.

Produce the full project files inline, with code blocks labeled by path and content.
