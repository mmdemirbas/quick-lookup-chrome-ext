/**
 * Colour for a part of speech.
 *
 * A word with six meanings usually has two or three parts of speech, and
 * which sense belongs to which is the first thing a reader needs in order to
 * place the word. Today that is a line of identical italics: correct, and
 * only readable by reading it. A hue per class makes the grouping visible
 * before a word is read.
 *
 * Two rules keep this from becoming decoration.
 *
 * The label is never removed. Colour is a second encoding of something the
 * text already says, so a reader who cannot separate two hues loses nothing —
 * the same rule the site marks follow.
 *
 * It must not be mistaken for the site marks, which are the other thing on a
 * card carrying a hue. They are filled tiles of two capital letters at the
 * end of a line; this is a lower-case italic word at the start of one. The
 * shapes never collide, so the two palettes can overlap without either
 * meaning anything about the other.
 *
 * Classes rather than one entry per name, because Wiktionary alone uses
 * around thirty part-of-speech strings, and "pronoun, preposition and
 * determiner are all function words" is the distinction a reader can use.
 */

export type PartOfSpeech = {
  /** The class name, for a test and for the tooltip. */
  group: string;
  /** Degrees on the colour wheel. */
  hue: number;
};

/**
 * The five groups, each far enough from the others to be told apart at the
 * size a part of speech is printed.
 *
 * Nouns and verbs get the two hues furthest apart, because that is the
 * distinction being drawn most often.
 */
const GROUPS: Record<string, PartOfSpeech> = {
  // Opposite each other on the wheel — 180 degrees is as far apart as two
  // hues can be, and a test holds it there.
  verb: { group: 'verb', hue: 12 },
  noun: { group: 'noun', hue: 192 },
  adverb: { group: 'adverb', hue: 52 },
  adjective: { group: 'adjective', hue: 142 },
  function: { group: 'function', hue: 280 },
};

/**
 * Which group each name belongs to. Names are what the sources actually
 * send, lower-cased: Wiktionary's own list, plus the shorter spellings the
 * other dictionaries use.
 */
const NAMES: Record<string, keyof typeof GROUPS> = {
  noun: 'noun',
  'proper noun': 'noun',
  'proper-noun': 'noun',
  n: 'noun',
  verb: 'verb',
  v: 'verb',
  'phrasal verb': 'verb',
  participle: 'verb',
  adjective: 'adjective',
  adj: 'adjective',
  adverb: 'adverb',
  adv: 'adverb',
  pronoun: 'function',
  preposition: 'function',
  postposition: 'function',
  conjunction: 'function',
  determiner: 'function',
  article: 'function',
  particle: 'function',
  numeral: 'function',
  number: 'function',
};

/**
 * The colour for a part of speech, or nothing when it is not one of the five.
 *
 * Nothing is a real answer here, not a failure: interjections, prefixes,
 * abbreviations, proverbs and the rest are a long tail that no reader is
 * scanning for, and giving each a hue would spend the whole palette on the
 * cases that do not need it. Those keep the neutral colour.
 */
export function partOfSpeech(name: string | undefined): PartOfSpeech | undefined {
  const key = (name ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!key) return undefined;
  const group = NAMES[key];
  return group ? GROUPS[group] : undefined;
}

/** Exported for the test that guards the palette's spacing. */
export function partOfSpeechGroups(): PartOfSpeech[] {
  return Object.values(GROUPS).map((g) => ({ ...g }));
}
