/**
 * Wikipedia REST — entity and technical summaries.
 *
 * The fastest measured source by a wide margin, because the summary
 * endpoint is served from a two-week edge cache. It is therefore the only
 * provider allowed to gate the first paint.
 *
 * Search runs first so that a selection which is not an exact article title
 * still resolves, and so that page context can influence which of several
 * candidate articles is chosen.
 */
import type { Provider, ProviderResult } from '../types.ts';
import { overlapScore, truncate } from '../text.ts';

const SOURCE = 'wikipedia';

type SearchResponse = {
  pages?: Array<{ key?: string; title?: string; description?: string }>;
};

type SummaryResponse = {
  type?: string;
  title?: string;
  description?: string;
  extract?: string;
  thumbnail?: { source?: string };
  content_urls?: { desktop?: { page?: string } };
};

/**
 * Picks the candidate that best fits the page the selection came from.
 *
 * With no topic terms this returns the first result, which is Wikipedia's
 * own relevance order. With topic terms it prefers a candidate whose
 * description shares vocabulary with the page — the mechanism that makes
 * `planner` resolve to a query planner on a database page.
 */
export function chooseCandidate(
  pages: NonNullable<SearchResponse['pages']>,
  topicTerms: string[],
): { key?: string; title?: string } | undefined {
  if (pages.length === 0) return undefined;
  if (topicTerms.length === 0) return pages[0];

  let best = pages[0];
  let bestScore = -1;
  for (const page of pages) {
    const haystack = `${page.title ?? ''} ${page.description ?? ''}`;
    const score = overlapScore(haystack, topicTerms);
    if (score > bestScore) {
      bestScore = score;
      best = page;
    }
  }
  // A tie at zero means context said nothing; fall back to relevance order.
  return bestScore > 0 ? best : pages[0];
}

export const wikipediaProvider: Provider = {
  id: 'wikipedia',
  label: 'Wikipedia',
  intents: ['entity', 'technical', 'phrase', 'unknown'],
  slots: ['entity', 'extract'],
  deadlineMs: 700,

  async run(request, context): Promise<ProviderResult | null> {
    const lang = context.uiLang.split('-')[0] || 'en';
    const query = request.text.trim();
    if (!query) return null;

    const search = await context.http.json<SearchResponse>(
      `https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(
        query,
      )}&limit=5`,
      { signal: context.signal },
    );

    const candidate = chooseCandidate(search.pages ?? [], request.page.topicTerms ?? []);
    const key = candidate?.key ?? candidate?.title;
    if (!key) return null;

    const summary = await context.http.json<SummaryResponse>(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`,
      { signal: context.signal },
    );

    // Disambiguation pages carry no information a card can show.
    if (!summary.extract || summary.type === 'disambiguation') return null;

    const url = summary.content_urls?.desktop?.page;
    const image = summary.thumbnail?.source;

    return {
      slots: {
        entity: {
          title: summary.title ?? key,
          ...(summary.description ? { description: summary.description } : {}),
          extract: truncate(summary.extract, 320),
          ...(image ? { imageUrl: image } : {}),
          ...(url ? { url } : {}),
          source: SOURCE,
        },
        extract: {
          text: truncate(summary.extract, 320),
          source: SOURCE,
          ...(url ? { url } : {}),
        },
      },
    };
  },
};
