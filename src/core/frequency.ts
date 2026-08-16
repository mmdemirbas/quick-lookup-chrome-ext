/**
 * How common a word is, on a scale a reader can act on.
 *
 * The number a corpus gives — occurrences per million words — is not usable
 * as it stands, because word frequency is exponential. `of` occurs 23,376
 * times per million and `ephemeral` 1.6, so on a linear bar every word worth
 * looking up is pinned to zero and indistinguishable from every other.
 *
 * Zipf is the standard fix: the base-10 logarithm of occurrences per billion.
 * It compresses that range to roughly 0 to 7.5 and spaces ordinary vocabulary
 * out evenly along it. Measured against Datamuse on 2026-08-16:
 *
 *     of 7.4 · work 5.7 · the 5.6 · table 5.4 · manifest 4.1 · commit 4.0
 *     query 4.0 · partition 3.9 · schema 3.7 · ephemeral 3.2 · iceberg 3.0
 *     obsequious 2.5 · serializable 2.3 · idempotent 1.8 · defenestrate 0.0
 *
 * The bands below are cut from that: everything a fluent reader uses without
 * thinking lands in the top band, the technical vocabulary of a working
 * programmer lands in the middle, and the words worth writing down land in
 * the bottom two.
 */

export type Frequency = {
  /** Occurrences per million words, as the source reported it. */
  perMillion: number;
  /** 1 for the rarest, 5 for everyday. The bar has five segments. */
  band: 1 | 2 | 3 | 4 | 5;
  label: string;
  source: string;
};

/** Occurrences per billion, log base 10. The standard lexical scale. */
export function zipf(perMillion: number): number {
  return perMillion > 0 ? Math.log10(perMillion * 1000) : 0;
}

const BANDS: Array<{ atLeast: number; band: Frequency['band']; label: string }> = [
  { atLeast: 5, band: 5, label: 'everyday' },
  { atLeast: 4, band: 4, label: 'common' },
  { atLeast: 3, band: 3, label: 'fairly common' },
  { atLeast: 2, band: 2, label: 'uncommon' },
  { atLeast: -Infinity, band: 1, label: 'rare' },
];

export function frequencyBand(perMillion: number): { band: Frequency['band']; label: string } {
  const score = zipf(perMillion);
  // The last band has no lower bound, so this cannot miss; the fallback is
  // for the type, not for a case that happens.
  const found = BANDS.find((entry) => score >= entry.atLeast) ?? BANDS[BANDS.length - 1]!;
  // Rebuilt rather than returned: the table row carries its own lower bound,
  // and spreading it into a slot would put that bound in every stored card.
  return { band: found.band, label: found.label };
}

/**
 * The frequency out of a Datamuse tag list.
 *
 * Datamuse returns metadata as string tags — `["adj", "n", "f:1.600203"]` —
 * so the part of speech and the frequency arrive in the same array and are
 * told apart only by a prefix. A word the corpus has never seen simply has
 * no `f:` tag, which is why this returns nothing rather than zero: absent
 * and "never occurs" are different, and only one of them is worth drawing.
 */
export function readFrequencyTag(tags: string[] | undefined): number | undefined {
  const tag = tags?.find((value) => value.startsWith('f:'));
  if (!tag) return undefined;
  const value = Number(tag.slice(2));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Whether a selection can have a frequency at all.
 *
 * The corpus is indexed by word. Asking it about a phrase returns nothing,
 * and asking it about a name returns the frequency of that spelling as a
 * common noun, which says nothing about the person.
 */
export function hasFrequency(text: string): boolean {
  const word = text.trim();
  return word.length > 1 && word.length <= 40 && /^\p{L}[\p{L}'-]*$/u.test(word);
}
