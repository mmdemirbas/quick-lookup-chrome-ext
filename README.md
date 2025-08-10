# Quick Lookup (MV3)

Instant lookup of selected text with a movable, pinnable popup. Translation links, entity card (
image via Wikidata), Wikipedia summary, dictionary, and quick links.

## Build & Load

```bash
npm i
npm run build
```

then: chrome://extensions → Developer mode → Load unpacked → dist

## Privacy & Security

- No analytics, no remote code. All data stored locally.
- Only calls whitelisted hosts: Wikipedia, Wikidata, Dictionary API (and optional translation URL if
  configured).

## Notes

- Icons are placeholder 1×1 PNGs generated at build; replace `dist/icons/*.png` with real icons
  before publishing.
- Settings → Options page controls modifier key and timeouts; provider templates editable there.
- AI Summary: configure your preferred service and API key in Options (OpenAI, Groq, OpenRouter, or Cloudflare Workers AI). With service set to “auto”, the extension prefers free tiers first if keys are present.

## Dev

- `npm run dev` builds to `dist/` once; use `--watch` if you prefer file watchers.

