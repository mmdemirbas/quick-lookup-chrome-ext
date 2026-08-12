/**
 * What the page itself says the term means.
 *
 * The motivating case is a word whose useful meaning is not in any
 * dictionary, encyclopedia or registry: `planner` on a query-engine page.
 * No source consulted over the network knows that sense, and the one text
 * that does is already on screen.
 *
 * So this looks for a sentence that *defines* rather than merely uses the
 * term. The patterns are deliberately narrow — a sentence that happens to
 * contain the word is not evidence of anything, and there are usually
 * dozens of those. Nothing here touches the network or leaves the device.
 */

/** Occurrences past this are ignored; a defining sentence comes early. */
const MAX_OCCURRENCES = 40;

const MIN_SENTENCE_CHARS = 25;
const MAX_SENTENCE_CHARS = 320;

/**
 * Words allowed between the start of the sentence and the term.
 *
 * The term is usually the head of a noun phrase rather than the first word:
 * "The query planner is the component that…" is the shape documentation
 * actually uses. Allowing a few words admits it while still requiring the
 * term to be the subject — by the time a sentence has said seven words
 * before reaching it, the term is an object and the sentence is using it,
 * not defining it.
 */
const MAX_WORDS_BEFORE_TERM = 3;

export type PageDefinition = { text: string; score: number };

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How strongly a sentence reads as a definition of the term, 0 when it does
 * not. The three shapes, in descending order of how reliably they define:
 *
 * 1. The term as the subject of a defining verb — "A manifest is a file…".
 * 2. A glossary entry — "Manifest: a file that lists…".
 * 3. The term introduced as a name for something — "…is called the planner".
 */
export function definitionScore(term: string, sentence: string): number {
  const trimmed = sentence.trim();
  if (trimmed.length < MIN_SENTENCE_CHARS || trimmed.length > MAX_SENTENCE_CHARS) return 0;

  const t = escapeRegExp(term.trim());
  if (!t) return 0;

  const subject = new RegExp(
    `^\\W*(?:[\\p{L}\\p{N}'-]+\\s+){0,${MAX_WORDS_BEFORE_TERM}}?${t}\\b` +
      `[^.]{0,40}?\\b(?:is|are|was|were|refers\\s+to|means|denotes|describes|represents)\\b`,
    'iu',
  );
  if (subject.test(trimmed)) return 1;

  if (new RegExp(`^\\W*${t}\\s*[:—–-]\\s+\\S`, 'i').test(trimmed)) return 0.8;

  if (
    new RegExp(`\\b(?:called|known\\s+as|termed|referred\\s+to\\s+as)\\s+(?:the\\s+|a\\s+|an\\s+)?${t}\\b`, 'i').test(
      trimmed,
    )
  ) {
    return 0.6;
  }

  return 0;
}

/**
 * The sentence surrounding an offset, bounded so one long node stays cheap.
 *
 * A newline is not a sentence boundary. Markup wraps prose at arbitrary
 * points, so treating one as an end truncates the sentence mid-clause —
 * usually just before the verb that made it a definition. Block boundaries
 * arrive as separate text nodes and are joined with a space instead.
 */
function sentenceAround(text: string, at: number, length: number): string {
  const before = text.slice(Math.max(0, at - MAX_SENTENCE_CHARS), at);
  const startOffset = before.search(/[.!?][^.!?]*$/);
  const start = startOffset < 0 ? at - before.length : at - before.length + startOffset + 1;

  const from = at + length;
  const tail = text.slice(from, from + MAX_SENTENCE_CHARS);
  const endMark = tail.search(/[.!?]/);
  const end = endMark < 0 ? from + tail.length : from + endMark + 1;

  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * The best defining sentences for `term` in `text`, strongest first.
 *
 * Ties break towards the earlier occurrence, because a page that defines a
 * term usually does so before using it.
 */
export function findDefinitions(term: string, text: string, limit = 2): PageDefinition[] {
  const needle = term.trim().toLowerCase();
  if (needle.length < 2 || !text) return [];

  const haystack = text.toLowerCase();
  const found: PageDefinition[] = [];
  const seen = new Set<string>();

  let at = haystack.indexOf(needle);
  for (let n = 0; at >= 0 && n < MAX_OCCURRENCES; n++) {
    // Whole words only: "plan" must not match inside "planner".
    const before = at === 0 ? ' ' : haystack[at - 1] ?? ' ';
    const after = haystack[at + needle.length] ?? ' ';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) {
      const sentence = sentenceAround(text, at, needle.length);
      const score = definitionScore(term, sentence);
      const key = sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (score > 0 && !seen.has(key)) {
        seen.add(key);
        found.push({ text: sentence, score });
      }
    }
    at = haystack.indexOf(needle, at + needle.length);
  }

  // Stable sort keeps document order among equal scores.
  return found.sort((a, b) => b.score - a.score).slice(0, limit);
}
