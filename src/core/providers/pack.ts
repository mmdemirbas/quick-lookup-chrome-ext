/**
 * Installed dictionary packs — the only source that costs nothing and cannot
 * run out.
 *
 * Every other source is a request: rate-limited, offline-breakable, and in
 * the case of translation, metered. A pack is a file the reader installed, so
 * it answers at the speed of local storage and keeps answering on a plane.
 * That makes it the right source for the thing done most often — reading a
 * page in a second language, word by word.
 *
 * Which pack answers is decided by its languages, never by its name:
 *
 * - A **monolingual** pack (source and target the same) writes definitions.
 * - A **bilingual** pack writes the translation slot, and only when its
 *   target is the language the reader asked for. Without that rule, someone
 *   with an English-Turkish and an English-German pack installed gets a card
 *   whose translation line and equivalents are in different languages.
 * - A pack whose source is not the language being read is not consulted. A
 *   Turkish-English pack has nothing to say about an English word.
 */
import type { Provider, ProviderResult, Sense, SlotData } from '../types.ts';
import { candidateForms, splitEquivalents, type PackHit } from '../packs.ts';
import { dedupeBy, truncate } from '../text.ts';

/** More than this is a thesaurus, not an answer. Packs are wordy. */
const MAX_EQUIVALENTS = 8;

/**
 * Caps on the translated line, measured against the real corpus rather than
 * guessed: FreeDict's `partition` carries seven numbered meanings and reaches
 * about 190 characters, which is dense but still one glanceable line. These
 * sit above it so a normal entry is never cut, and an outlier cannot turn the
 * card into a wall.
 */
const MAX_MEANINGS = 8;
const MAX_LINE_CHARS = 300;

/**
 * The first form any pack knows, and every pack's answer for it.
 *
 * Forms are tried in order rather than merged, so a reader selecting
 * `caught` gets the entry for `caught` and not that entry plus a guess at
 * `catch`. Merging would put two head-words on one card and make the pack
 * look confused about which word was selected.
 */
export async function firstKnownForm(
  lookup: { entries(headword: string): Promise<PackHit[]> },
  word: string,
): Promise<PackHit[]> {
  for (const form of candidateForms(word)) {
    const hits = await lookup.entries(form);
    if (hits.length > 0) return hits;
  }
  return [];
}

export const packProvider: Provider = {
  id: 'packs',
  label: 'Installed dictionaries',
  intents: ['word', 'phrase', 'technical', 'foreign'],
  slots: ['headword', 'pronunciation', 'senses', 'translation'],
  // Local storage. A deadline this short is a fault detector, not a budget:
  // if an installed pack cannot answer in a third of a second, the card is
  // better off without it.
  deadlineMs: 300,

  async run(request, context): Promise<ProviderResult | null> {
    const lookup = context.packs;
    if (!lookup) return null;

    const lang = context.uiLang.split('-')[0] || 'en';
    const hits = await firstKnownForm(lookup, request.text);
    if (hits.length === 0) return null;

    const senses: Sense[] = [];
    const pronunciation: SlotData['pronunciation'] = [];
    const equivalents: Array<{ word: string; source: string }> = [];
    const lines: string[] = [];
    let headword: string | undefined;
    let target: string | undefined;
    let source: string | undefined;

    for (const { pack, entry } of hits) {
      if (pack.source !== lang) continue;

      const bilingual = pack.target !== pack.source;
      if (bilingual && pack.target !== request.glossLanguage) continue;

      headword ??= entry.headword;
      if (entry.ipa) pronunciation.push({ ipa: entry.ipa });

      if (!bilingual) {
        for (const meaning of entry.senses) {
          senses.push({ definition: meaning, source: pack.name });
        }
        continue;
      }

      target ??= pack.target;
      source ??= pack.name;
      for (const meaning of entry.senses) {
        const words = splitEquivalents(meaning);
        if (words.length === 0) continue;
        // Grouping survives the join: meanings are separated by semicolons
        // and the words inside one meaning by commas, which is how a printed
        // dictionary distinguishes "bank, riverbank" from "bank; riverbank".
        lines.push(words.join(', '));
        for (const word of words) equivalents.push({ word, source: pack.name });
      }
    }

    if (!headword) return null;

    const words = dedupeBy(equivalents, (e) => e.word.toLowerCase()).slice(0, MAX_EQUIVALENTS);

    return {
      slots: {
        headword,
        ...(pronunciation.length ? { pronunciation: dedupeBy(pronunciation, (p) => p.ipa ?? '') } : {}),
        ...(senses.length ? { senses } : {}),
        ...(target && source && lines.length
          ? {
              translation: {
                text: truncate(lines.slice(0, MAX_MEANINGS).join('; '), MAX_LINE_CHARS),
                lang: target,
                source,
                ...(words.length ? { equivalents: words } : {}),
              },
            }
          : {}),
      },
    };
  },
};
