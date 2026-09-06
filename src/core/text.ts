/** Small string helpers shared by providers and composition. */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

/**
 * Removes markup from a source string.
 *
 * Some sources return HTML inside JSON fields. Values are always inserted
 * into the DOM as text, so this is about readability rather than safety —
 * but stripping here means a stray tag never reaches the card either way.
 */
/** One character, or nothing when the number cannot be one. */
function codePoint(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return undefined;
  // Surrogate halves are not characters on their own.
  if (value >= 0xd800 && value <= 0xdfff) return undefined;
  return String.fromCodePoint(value);
}

export function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')
    // `String.fromCodePoint` throws a RangeError above U+10FFFF, and this
    // runs on text a remote source wrote. An uncaught throw here costs the
    // whole slot, so an unusable reference is left as it was written.
    .replace(/&#(\d+);/g, (whole, code: string) => codePoint(Number(code)) ?? whole)
    .replace(/&#x([0-9a-f]+);/gi, (whole, code: string) => codePoint(parseInt(code, 16)) ?? whole)
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  const cut = input.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Deduplicates while preserving first-seen order. */
export function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'as', 'at', 'by', 'from',
  'you', 'your', 'we', 'our', 'they', 'their', 'can', 'will', 'not', 'has', 'have',
]);

/** Lowercased content words, used for overlap scoring against page context. */
export function contentWords(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Fraction of `candidate`'s content words that also appear in `context`.
 *
 * Used to rank senses against the page topic — the mechanism behind
 * resolving `planner` differently on a database page than on a wedding one.
 */
export function overlapScore(candidate: string, context: string[]): number {
  if (context.length === 0) return 0;
  const words = contentWords(candidate);
  if (words.length === 0) return 0;
  const contextSet = new Set(context.map((w) => w.toLowerCase()));
  let hits = 0;
  for (const w of words) if (contextSet.has(w)) hits++;
  return hits / words.length;
}
