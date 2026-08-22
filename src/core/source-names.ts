/**
 * What to call a source where a reader will see it.
 *
 * A card's `sources` are provider ids — short, lower-case, chosen to be typed
 * rather than read. Printing them is fine until a source's terms ask to be
 * named: freedictionaryapi.com serves Wiktionary data under CC BY-SA 4.0 and
 * asks for "a visible attribution to FreeDictionaryAPI.com", which the id
 * `free-dictionary` does not give.
 *
 * The names live here rather than being read off the providers because this
 * table is used by the card and by the export, and neither may pull the
 * provider graph — every provider's code would end up in the content script.
 * A test walks the real providers and fails if one of them has no name here,
 * so the two cannot drift apart in silence.
 */

const NAMES: Record<string, string> = {
  page: 'this page',
  packs: 'installed dictionaries',
  'free-dictionary': 'FreeDictionaryAPI.com',
  wiktionary: 'Wiktionary',
  datamuse: 'Datamuse',
  tatoeba: 'Tatoeba',
  wikipedia: 'Wikipedia',
  stackexchange: 'Stack Exchange',
  mdn: 'MDN',
  registry: 'package registry',
  links: 'links',
};

/** The id itself when nothing is known about it — an unnamed source is still a source. */
export function sourceName(id: string): string {
  return NAMES[id] ?? id;
}

/** Exported for the test that holds this table against the real providers. */
export function namedSources(): string[] {
  return Object.keys(NAMES);
}
