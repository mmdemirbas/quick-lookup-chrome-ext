/**
 * MDN — the reference for anything the browser itself provides.
 *
 * Asked only on pages about the web platform or the npm ecosystem, and only
 * for technical intent, because it is the slowest source measured at around
 * 1.6 s and its search answers *something* for every query. A result whose
 * title does not contain the selection is discarded rather than shown:
 * searching MDN for a word that is not a web technology returns loosely
 * related documents, and one of those on a card reads as an answer.
 *
 * This is the site's own search endpoint rather than a published API, so it
 * is treated as the most likely of the sources to change shape. A failure
 * removes the slot and nothing else.
 */
import type { Provider, ProviderResult } from '../types.ts';
import { detectEcosystems } from '../ecosystem.ts';
import { truncate } from '../text.ts';

const SOURCE = 'mdn';
const ORIGIN = 'https://developer.mozilla.org';
const SUMMARY_CHARS = 300;

type SearchResponse = {
  documents?: Array<{ title?: string; summary?: string; mdn_url?: string }>;
};

/**
 * Whether a document is about the selection rather than merely near it.
 *
 * MDN titles carry their context — `fetch` lives under "Window: fetch()
 * method" — so an exact title match would reject most real hits. Requiring
 * every word of the selection to appear as a word of the title accepts
 * those and rejects the loosely related ones.
 */
export function titleMatches(query: string, title: string): boolean {
  const words = (text: string) =>
    text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const wanted = words(query);
  if (wanted.length === 0) return false;
  const have = new Set(words(title));
  return wanted.every((w) => have.has(w));
}

export const mdnProvider: Provider = {
  id: SOURCE,
  label: 'MDN',
  intents: ['technical'],
  slots: ['extract', 'links'],
  deadlineMs: 2000,

  async run(request, context): Promise<ProviderResult | null> {
    const query = request.text.trim();
    if (!query || query.length > 60) return null;

    const ecosystems = detectEcosystems(request.page);
    if (!ecosystems.includes('web') && !ecosystems.includes('npm')) return null;

    try {
      const body = await context.http.json<SearchResponse>(
        `${ORIGIN}/api/v1/search?q=${encodeURIComponent(query)}&locale=en-US`,
        { signal: context.signal },
      );

      for (const doc of body.documents ?? []) {
        if (!doc.title || !doc.summary || !doc.mdn_url) continue;
        if (!titleMatches(query, doc.title)) continue;
        const url = `${ORIGIN}${doc.mdn_url}`;
        return {
          slots: {
            extract: { text: truncate(doc.summary, SUMMARY_CHARS), source: SOURCE, url },
            links: [{ id: 'mdn-doc', label: 'MDN', url }],
          },
        };
      }
      return null;
    } catch {
      // An unpublished endpoint is allowed to disappear.
      return null;
    }
  },
};
