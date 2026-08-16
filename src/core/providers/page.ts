/**
 * The page the reader is on, as a source.
 *
 * Costs nothing and can answer what no remote source can: what a term means
 * *here*. The sentences were found locally by the content script, so this
 * provider only has to hand them to a slot — it exists so the page takes
 * the same shape as every other source rather than being special-cased in
 * the middle of composition.
 */
import type { Provider, ProviderResult, SlotData } from '../types.ts';

/**
 * Longest sentence worth carrying back onto the card.
 *
 * Past this it is a paragraph that happens to have no full stop in it, and
 * repeating a paragraph the reader is already looking at is pure noise.
 */
const MAX_SENTENCE_CHARS = 220;

/**
 * The sentence the word was met in, split around the word.
 *
 * Split rather than kept whole so the card can show which word it is about.
 * A sentence with the term buried in it reads as a quotation; a sentence with
 * the term marked reads as evidence.
 *
 * The match is on the exact selection and nothing cleverer: a stem match
 * would highlight the wrong span in "a partition of the partitioned table",
 * and being wrong about which word is under discussion is worse than not
 * marking it at all.
 */
export function inContext(sentence: string, term: string): SlotData['inContext'] | undefined {
  const text = sentence.trim();
  const needle = term.trim();
  if (!text || !needle || text.length > MAX_SENTENCE_CHARS) return undefined;
  // A "sentence" that is only the word itself tells the reader nothing they
  // cannot see in the title of the card.
  if (text.length <= needle.length) return undefined;

  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return { before: text, term: '', after: '' };
  return {
    before: text.slice(0, at),
    term: text.slice(at, at + needle.length),
    after: text.slice(at + needle.length),
  };
}

export const pageProvider: Provider = {
  id: 'page',
  label: 'This page',
  intents: ['word', 'phrase', 'entity', 'technical', 'citation', 'quantity', 'foreign', 'unknown'],
  slots: ['onPage', 'inContext'],
  deadlineMs: 0,

  async run(request): Promise<ProviderResult | null> {
    const definitions = request.page.definitions ?? [];
    // Carried on the card because a card can now outlive the selection that
    // opened it: one that has been dragged aside, or copied into a note, has
    // no page behind it any more. The sentence is what makes it stand alone.
    const context = request.page.sentence
      ? inContext(request.page.sentence, request.text)
      : undefined;

    if (definitions.length === 0 && !context) return null;
    return {
      slots: {
        ...(definitions.length > 0 ? { onPage: definitions } : {}),
        ...(context ? { inContext: context } : {}),
      },
    };
  },
};
