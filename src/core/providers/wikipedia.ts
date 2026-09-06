/**
 * Wikipedia — entity and technical summaries.
 *
 * Three endpoints were measured before settling on this shape:
 *
 * - `page/summary` is served from a two-week edge cache, answers in about
 *   200-350 ms, and normalises the title, so "alan turing" resolves. It is
 *   the fast path and handles most entity lookups in one request.
 * - `rest.php/v1/search/title` returned 429 after a handful of requests in
 *   testing, and gives only titles, so a second request was always needed.
 *   It is not used.
 * - The Action API with `generator=search` returns candidates *with* their
 *   extract, description and thumbnail in a single request, from a
 *   different rate-limit pool. It is the fallback.
 *
 * The fallback also biases the search with the page's topic, which is what
 * resolves a general word to the sense the page is about: `parquet` on a
 * table-format page returns Apache Parquet rather than the flooring.
 * Biasing can over-constrain and return nothing, so an unbiased retry
 * follows — and every search result must then survive `isAbout`, because
 * biasing fails by returning the page's own subject for anything at all.
 *
 * The fast path needs the same treatment for a different reason. A title
 * that resolves is not a title that resolved to the right thing: `Parquet`
 * has an article of its own, about the flooring, so the fast path answered
 * and the biased search that knew better never ran. When the resolved
 * article has nothing in common with the page, the biased search runs after
 * all — and may only take over on the terms in `moreSpecific`.
 */
import type { PageContext, Provider, ProviderResult } from '../types.ts';
import { contentWords, overlapScore, truncate } from '../text.ts';

const SOURCE = 'wikipedia';
const EXTRACT_CHARS = 320;

/** More than this over-constrains the search and returns no candidates. */
const MAX_BIAS_TERMS = 3;

/**
 * How much a biased result must overlap the page topic to be trusted.
 *
 * Low on purpose: it separates "related to this page" from "the search
 * engine matched on a coincidence", and nothing finer than that is
 * meaningful from a three-sentence extract.
 */
const MIN_BIAS_SCORE = 0.02;

type Candidate = {
  title?: string;
  description?: string;
  extract?: string;
  index?: number;
  thumbnail?: { source?: string };
};

type QueryResponse = { query?: { pages?: Record<string, Candidate> } };

type SummaryResponse = {
  type?: string;
  title?: string;
  description?: string;
  extract?: string;
  thumbnail?: { source?: string };
  content_urls?: { desktop?: { page?: string } };
};

/** Article titles use underscores rather than spaces. */
function toTitle(text: string): string {
  return encodeURIComponent(text.trim().replace(/\s+/g, '_'));
}

function articleUrl(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${toTitle(title)}`;
}

/**
 * The few topic terms most likely to disambiguate, excluding any word
 * already in the selection — those would match every candidate equally.
 */
export function biasTerms(page: PageContext, selection: string): string[] {
  const own = new Set(contentWords(selection));
  return (page.topicTerms ?? []).filter((t) => !own.has(t)).slice(0, MAX_BIAS_TERMS);
}

/** `manifests` and `manifest` should match the same article. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * Whether a search result is about the selection at all.
 *
 * This is the gate that topic bias needs and did not have. A biased search
 * asks Wikipedia for the selection *and* the page's topic, so the page's own
 * subject matches every selection made anywhere on it: on the Iceberg
 * documentation, selecting `Schema` returned "Apache Iceberg", and so would
 * almost any other capitalised word. Topic overlap ranks candidates against
 * each other. It cannot establish that one answers the question asked.
 *
 * What counts is the article's *subject*, not a mention of the term. That is
 * readable from Wikipedia's house style: the title names the subject, and so
 * does the lead sentence, before its verb. Checking the rest of the extract
 * instead would let the reported case straight back through — the Iceberg
 * article's second sentence mentions schema evolution.
 *
 * Only search results are gated. A title resolved directly is about the
 * selection by construction, including through a redirect, so `NYC` finding
 * "New York City" keeps working.
 */
export function isAbout(candidate: Candidate, query: string): boolean {
  const needles = contentWords(query).map(stem);
  if (needles.length === 0) return true;

  const lead = (candidate.extract ?? '').split(/(?<=[.!?])\s/, 1)[0] ?? '';
  const subject = lead.split(/\s+(?:is|was|are|were|refers|denotes)\s+/i, 1)[0] ?? '';
  const named = new Set(contentWords(`${candidate.title ?? ''} ${subject}`).map(stem));

  return needles.some((needle) => named.has(needle));
}

/**
 * Picks the candidate that best fits the page, and says how well it fits.
 *
 * The score matters as much as the choice. A biased search fails by
 * returning confidently irrelevant results rather than none — searching
 * "planner iceberg" returns a Toyota model — so an emptiness check is not
 * enough to detect that the bias misfired. A near-zero score is.
 *
 * With no topic terms, or when none match, the search engine's own
 * relevance order stands — among the candidates that are about the query.
 */
export function chooseCandidate(
  candidates: Candidate[],
  topicTerms: string[],
  query: string,
): { candidate: Candidate; score: number } | undefined {
  const ordered = [...candidates]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .filter((candidate) => isAbout(candidate, query));
  const first = ordered[0];
  if (!first) return undefined;
  if (topicTerms.length === 0) return { candidate: first, score: 0 };

  let best = first;
  let bestScore = 0;
  for (const candidate of ordered) {
    const haystack = `${candidate.title ?? ''} ${candidate.description ?? ''} ${candidate.extract ?? ''}`;
    const score = overlapScore(haystack, topicTerms);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore > 0 ? { candidate: best, score: bestScore } : { candidate: first, score: 0 };
}

function usable(summary: SummaryResponse): boolean {
  return Boolean(summary.extract) && summary.type !== 'disambiguation';
}

/**
 * Whether a challenger names the same thing as the selection, only more
 * precisely: every content word of the selection appears in its title.
 *
 * This is what separates the swap that is wanted from the one that is not.
 * `Parquet` to `Apache Parquet` is the same term, qualified. `Alan Turing` to
 * `Turing completeness` is a different subject that happens to mention what
 * the page is about, and taking it over an article Wikipedia resolved
 * directly would be a worse answer than the one being replaced.
 */
export function moreSpecific(title: string, query: string): boolean {
  const named = new Set(contentWords(title).map(stem));
  const needles = contentWords(query).map(stem);
  return needles.length > 0 && needles.every((needle) => named.has(needle));
}

/**
 * How the article was found, which is how much to trust its paragraph.
 *
 * A title that resolved directly is about the selection. A search result is
 * about something the search engine judged related, which for a package
 * name is often the general article about the language. Recording the
 * difference lets composition prefer an exactly matched source over this
 * one without either provider knowing about the other.
 */
const SOURCE_SEARCHED = 'wikipedia-search';

function result(
  title: string,
  extract: string,
  url: string,
  source: string,
  description?: string,
  imageUrl?: string,
): ProviderResult {
  const text = truncate(extract, EXTRACT_CHARS);
  return {
    slots: {
      entity: {
        title,
        ...(description ? { description } : {}),
        extract: text,
        ...(imageUrl ? { imageUrl } : {}),
        url,
        source: SOURCE,
      },
      extract: { text, source, url },
    },
  };
}

export const wikipediaProvider: Provider = {
  id: 'wikipedia',
  label: 'Wikipedia',
  intents: ['entity', 'technical', 'phrase', 'unknown'],
  slots: ['entity', 'extract'],
  /**
   * The fast path costs one cached request, two when the article it found
   * has nothing to do with the page. The disambiguation path can cost three
   * sequential ones, which is deliberately allowed to exceed the card's
   * headline budget: by then the dictionary slots are already drawn and this
   * fills in beneath them.
   */
  deadlineMs: 2000,

  async run(request, context): Promise<ProviderResult | null> {
    const lang = context.uiLang.split('-')[0] || 'en';
    const query = request.text.trim();
    if (!query) return null;

    const api = `https://${lang}.wikipedia.org/w/api.php`;

    // Fast path: the cached summary endpoint, which also normalises titles.
    let direct: SummaryResponse | undefined;
    try {
      direct = await context.http.json<SummaryResponse>(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${toTitle(query)}`,
        { signal: context.signal },
      );
    } catch {
      // No such article, or an outage. Both fall through to search.
    }

    // A disambiguation page is Wikipedia stating that the term names
    // several unrelated things. Searching after that does not resolve the
    // ambiguity, it only hides it behind whichever article ranked first —
    // which is how `First` returned a watch manufacturer. Better to leave
    // the slot empty and let the page's own sentence and the dictionary
    // answer, which they do well for exactly this kind of word.
    if (direct?.type === 'disambiguation') return null;

    const search = async (terms: string): Promise<Candidate[]> => {
      const url =
        `${api}?action=query&format=json&origin=*&generator=search` +
        `&gsrsearch=${encodeURIComponent(terms)}&gsrlimit=5` +
        `&prop=extracts%7Cdescription%7Cpageimages` +
        `&exintro=1&explaintext=1&exsentences=3&piprop=thumbnail&pithumbsize=160`;
      try {
        const body = await context.http.json<QueryResponse>(url, { signal: context.signal });
        return Object.values(body.query?.pages ?? {});
      } catch {
        return [];
      }
    };

    const topicTerms = request.page.topicTerms ?? [];
    const bias = biasTerms(request.page, query);

    const fromCandidate = (candidate: Candidate): ProviderResult =>
      result(
        candidate.title ?? '',
        candidate.extract ?? '',
        articleUrl(lang, candidate.title ?? ''),
        SOURCE_SEARCHED,
        candidate.description,
        candidate.thumbnail?.source,
      );

    if (direct && usable(direct)) {
      const found = result(
        direct.title ?? query,
        direct.extract ?? '',
        direct.content_urls?.desktop?.page ?? articleUrl(lang, direct.title ?? query),
        SOURCE,
        direct.description,
        direct.thumbnail?.source,
      );

      // A title resolving is not the same as it resolving to what this page
      // means. `Parquet` on a page about table formats is the flooring:
      // Wikipedia answered the question exactly as asked, and the question
      // was ambiguous. The fast path could not see that, because it never
      // looked at the page.
      //
      // The search that can see it is rate limited far more aggressively
      // than this endpoint, and it is also the fallback every miss depends
      // on, so it is spent only when there is a reason to: a page with a
      // topic, and an article with nothing to do with it.
      const fit = overlapScore(
        `${direct.title ?? ''} ${direct.description ?? ''} ${direct.extract ?? ''}`,
        topicTerms,
      );
      if (bias.length === 0 || fit >= MIN_BIAS_SCORE) return found;

      // Three conditions, because this replaces an answer Wikipedia gave
      // directly: the challenger has to fit the page, name the same thing,
      // and be a different article from the one already in hand.
      const better = chooseCandidate(await search(`${query} ${bias.join(' ')}`), topicTerms, query);
      const candidate = better?.candidate;
      if (
        better &&
        candidate?.title &&
        candidate.extract &&
        better.score >= MIN_BIAS_SCORE &&
        candidate.title !== direct.title &&
        moreSpecific(candidate.title, query) &&
        !/\bmay refer to\b/i.test(candidate.extract)
      ) {
        return fromCandidate(candidate);
      }
      return found;
    }

    let chosen = bias.length
      ? chooseCandidate(await search(`${query} ${bias.join(' ')}`), topicTerms, query)
      : undefined;

    // The biased search either found nothing or found something unrelated to
    // the page. Either way the bias misfired, so ask again without it.
    if (!chosen || chosen.score < MIN_BIAS_SCORE) {
      // Kept unless the retry beats it. A plain assignment threw away an
      // article already in hand whenever the second request was refused —
      // and this endpoint answers 429 readily — so a lookup that had found
      // "Parquet (file format)" returned nothing at all.
      const again = chooseCandidate(await search(query), topicTerms, query);
      if (again && (!chosen || again.score >= chosen.score)) chosen = again;
    }

    const candidate = chosen?.candidate;
    if (!candidate?.title || !candidate.extract) return null;
    // A disambiguation article reached through search is no more useful than
    // one reached directly.
    if (/\bmay refer to\b/i.test(candidate.extract)) return null;

    return fromCandidate(candidate);
  },
};
