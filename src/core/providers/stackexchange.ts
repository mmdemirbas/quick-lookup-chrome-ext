/**
 * Stack Overflow tag wikis — a crisp, human-written definition of a
 * programming term.
 *
 * A tag wiki is the closest thing the software world has to a dictionary
 * entry: one paragraph, written for practitioners, on exactly the terms
 * people actually look up. Measured against the alternatives it is also
 * cheap — about 250-800 ms for under a kilobyte.
 *
 * Two properties of the endpoint shape this provider:
 *
 * - Several tags can be requested in one call, and tags that do not exist
 *   are simply absent from the response rather than being an error. So the
 *   plausible spellings of a term are all asked at once and whichever
 *   exists comes back: "Apache Iceberg" asks for `apache-iceberg` and
 *   `apacheiceberg` in the same request.
 * - The quota is 300 requests per day per address without a key, which is
 *   why this runs for technical intent only. Repeat lookups are served
 *   from the cache and cost nothing.
 */
import type { Provider, ProviderResult } from '../types.ts';
import { dedupeBy, stripHtml, truncate } from '../text.ts';

const SOURCE = 'stackexchange';
const SITE = 'stackoverflow';

/** Stack Exchange rejects tags longer than this. */
const MAX_TAG_CHARS = 35;

const EXCERPT_CHARS = 320;
const GLOSS_CHARS = 180;

type WikiItem = { tag_name?: string; excerpt?: string };
type WikisResponse = { items?: WikiItem[] };

/**
 * The spellings a term might have as a tag, best first.
 *
 * Tags are lowercase and use hyphens, but not consistently — `apache-spark`
 * and `apacheds` both exist. Asking for both costs nothing because they
 * travel in one request.
 */
export function tagCandidates(query: string): string[] {
  const base = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!base) return [];
  const forms = dedupeBy([base.replace(/ /g, '-'), base.replace(/ /g, '')], (f) => f);
  return forms.filter(
    (f) => f.length > 1 && f.length <= MAX_TAG_CHARS && /^[a-z0-9+#._-]+$/.test(f),
  );
}

/**
 * Advice to askers, which many tag wikis carry alongside — or instead of —
 * a definition.
 */
const GUIDANCE =
  /\b(?:off[- ]topic|on[- ]topic|questions?\s+(?:must|should)|(?:do\s+not|don'?t)\s+use\s+this\s+tag|use\s+a\s+more\s+specific|ambiguous\s+tag|stack\s+overflow|stack\s+exchange)\b/i;

export function isGuidance(sentence: string): boolean {
  return GUIDANCE.test(sentence);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The part of a tag wiki that defines the term, or nothing.
 *
 * Wikis mix the two registers freely. The `manifest` one defines the word
 * and then adds "Generally an ambiguous tag, try and use a more specific
 * one"; the `kubernetes` one is nothing but advice and never says what
 * Kubernetes is. So advice is removed sentence by sentence — but a wiki
 * whose *opening* sentence is advice is rejected outright, because what
 * follows is a continuation of it rather than a definition.
 */
export function definitionText(excerpt: string): string | undefined {
  const all = sentences(excerpt);
  const first = all[0];
  if (!first || isGuidance(first)) return undefined;

  const kept = all.filter((s) => !isGuidance(s)).join(' ');
  return kept.length > 20 ? kept : undefined;
}

/** The lead sentence doubles as the one-line gloss above the paragraph. */
function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(?:\s|$)/.exec(text);
  return match?.[1] ?? text;
}

export const stackExchangeProvider: Provider = {
  id: SOURCE,
  label: 'Stack Overflow',
  intents: ['technical'],
  slots: ['gloss', 'extract', 'links'],
  deadlineMs: 1500,

  async run(request, context): Promise<ProviderResult | null> {
    const candidates = tagCandidates(request.text);
    if (candidates.length === 0) return null;

    const path = candidates.map(encodeURIComponent).join(';');
    const body = await context.http.json<WikisResponse>(
      `https://api.stackexchange.com/2.3/tags/${path}/wikis?site=${SITE}`,
      { signal: context.signal },
    );

    const items = body.items ?? [];
    // Candidate order is preference order, so the hyphenated spelling wins
    // over the run-together one when a term happens to have both.
    for (const candidate of candidates) {
      const item = items.find((i) => i.tag_name === candidate);
      const excerpt = definitionText(stripHtml(item?.excerpt ?? ''));
      if (!excerpt) continue;

      const url = `https://stackoverflow.com/questions/tagged/${encodeURIComponent(candidate)}`;
      return {
        slots: {
          gloss: truncate(firstSentence(excerpt), GLOSS_CHARS),
          extract: { text: truncate(excerpt, EXCERPT_CHARS), source: SOURCE, url },
          links: [{ id: `so-tag-${candidate}`, label: `Tagged ${candidate}`, url }],
        },
      };
    }
    return null;
  },
};
