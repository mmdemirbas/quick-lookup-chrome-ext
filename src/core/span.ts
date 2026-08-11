/**
 * Word spans within a string.
 *
 * This is the half of the hover trigger that has no DOM in it. Hovering
 * gives a point, a point gives a character offset, and this turns that
 * offset into a span the reader can then widen or narrow with the arrow
 * keys — which is how a hover, which can only ever indicate one word,
 * gets to express a phrase.
 *
 * Segmentation uses `Intl.Segmenter` rather than a regex on spaces, so
 * scripts that do not separate words with spaces behave correctly instead
 * of returning the whole line.
 */

export type Span = { start: number; end: number };

/** Cached per locale: constructing a segmenter is not free. */
const segmenters = new Map<string, Intl.Segmenter>();

function segmenterFor(locale: string): Intl.Segmenter {
  let segmenter = segmenters.get(locale);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    segmenters.set(locale, segmenter);
  }
  return segmenter;
}

/** Word-like segments only: punctuation and whitespace are not words. */
export function words(text: string, locale = 'en'): Span[] {
  const out: Span[] = [];
  for (const segment of segmenterFor(locale).segment(text)) {
    if (!segment.isWordLike) continue;
    out.push({ start: segment.index, end: segment.index + segment.segment.length });
  }
  return out;
}

/**
 * The word containing `offset`.
 *
 * An offset that lands on the boundary between a word and a space belongs
 * to the word, because the cursor sitting just past the last letter is how
 * a reader points at that letter.
 */
export function wordAt(text: string, offset: number, locale = 'en'): Span | undefined {
  const all = words(text, locale);
  for (const span of all) {
    if (offset >= span.start && offset <= span.end) return span;
  }
  return undefined;
}

export function sliceSpan(text: string, span: Span): string {
  return text.slice(span.start, span.end).trim();
}

/**
 * Grows or shrinks a span by whole words.
 *
 * `right` and `left` are counts of words to add on each side; negative
 * values shrink from that side. The span never collapses below one word
 * and never leaves the string, so holding an arrow key is safe.
 */
export function resizeSpan(
  text: string,
  base: Span,
  right: number,
  left: number,
  locale = 'en',
): Span {
  const all = words(text, locale);
  if (all.length === 0) return base;

  const firstIndex = all.findIndex((w) => w.end > base.start);
  const lastIndex = all.reduce((acc, w, i) => (w.start < base.end ? i : acc), firstIndex);
  if (firstIndex < 0) return base;

  const startIndex = clamp(firstIndex - left, 0, all.length - 1);
  const endIndex = clamp(lastIndex + right, startIndex, all.length - 1);

  const start = all[startIndex];
  const end = all[endIndex];
  if (!start || !end) return base;
  return { start: start.start, end: end.end };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * How many words a span covers. The card uses this to decide whether the
 * reader has widened it far enough to be asking about a phrase.
 */
export function wordCount(text: string, span: Span, locale = 'en'): number {
  return words(text.slice(span.start, span.end), locale).length;
}
