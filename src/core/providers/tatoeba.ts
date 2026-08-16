/**
 * Tatoeba — the word in a real sentence, with that sentence translated.
 *
 * A definition says what a word means; a sentence shows what it does. For
 * someone reading in a second language the second is often the thing that
 * makes it stick, and Tatoeba is the only free source that carries both
 * halves — a corpus of sentences written by people, each linked to human
 * translations of itself.
 *
 * Measured on 2026-08-16: 310 ms for `ephemeral`, about 2 s for `partition`
 * and `manifest`. That is slow enough that it must never gate the card, and
 * it does not: the card streams, so a late example arrives in a section that
 * was reserved for it.
 *
 * Coverage is uneven and honestly so. `ephemeral` has one sentence, `manifest`
 * two, and most technical vocabulary none at all. An empty answer removes the
 * section rather than showing an apology.
 */
import type { Provider, ProviderResult, SlotData } from '../types.ts';
import { toIso3 } from '../language.ts';

const SOURCE = 'tatoeba';

/**
 * Longest sentence worth showing.
 *
 * Tatoeba carries the whole Universal Declaration of Human Rights, one
 * article per sentence — the second result for `manifest` is 290 characters.
 * A sentence that long is not an example, it is a paragraph, and it teaches
 * nothing about the word that a short one does not.
 */
const MAX_SENTENCE_CHARS = 160;

/** Three is a pattern; more is a reading exercise. */
const MAX_EXAMPLES = 3;

type Sentence = {
  text?: string;
  correctness?: number;
  translations?: unknown;
};

type Response = { results?: Sentence[] };

/**
 * Translations arrive as an array of arrays — direct translations first, then
 * indirect ones through a third language. Both are flattened: an indirect
 * translation is still a human translation, and the card names the source.
 */
function translationIn(sentence: Sentence, language: string): string | undefined {
  const groups = Array.isArray(sentence.translations) ? sentence.translations : [];
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : [group]) {
      const row = item as { text?: string; lang?: string } | null;
      if (row?.lang === language && row.text?.trim()) return row.text.trim();
    }
  }
  return undefined;
}

/**
 * Whether the sentence actually shows the word.
 *
 * A search engine matches on a stem, so asking about `partition` returns
 * sentences carrying `partitioned` — which is wanted — but also, sometimes,
 * a sentence that matched on something else entirely. Requiring the first few
 * letters to appear keeps the useful inflections and drops the rest.
 */
export function showsWord(text: string, query: string): boolean {
  const stem = query.trim().toLowerCase().slice(0, Math.max(4, query.trim().length - 3));
  return stem.length > 0 && text.toLowerCase().includes(stem);
}

/**
 * The sentences worth showing, shortest first.
 *
 * Shortest rather than most relevant on purpose: every result already
 * contains the word, so the thing that separates a good example from a bad
 * one is whether it can be read in one glance.
 */
export function pickExamples(
  sentences: Sentence[],
  query: string,
  language: string | undefined,
): SlotData['examples'] {
  const usable = sentences
    .map((sentence) => ({ sentence, text: sentence.text?.trim() ?? '' }))
    .filter(({ sentence, text }) => {
      if (!text || text.length > MAX_SENTENCE_CHARS) return false;
      // Tatoeba marks sentences its community has flagged as wrong.
      if ((sentence.correctness ?? 0) < 0) return false;
      return showsWord(text, query);
    })
    .sort((a, b) => a.text.length - b.text.length)
    .slice(0, MAX_EXAMPLES);

  return usable.map(({ sentence, text }) => {
    const translation = language ? translationIn(sentence, language) : undefined;
    return { text, ...(translation ? { translation } : {}), source: SOURCE };
  });
}

export const tatoebaProvider: Provider = {
  id: 'tatoeba',
  label: 'Tatoeba',
  intents: ['word', 'phrase', 'foreign'],
  slots: ['examples'],
  // Above the slowest measured response, and well below the whole-lookup
  // budget. A source this slow earns its deadline by never blocking anything.
  deadlineMs: 2500,

  async run(request, context): Promise<ProviderResult | null> {
    const query = request.text.trim();
    if (!query || query.length > 60) return null;

    const from = toIso3(context.uiLang);
    if (!from) return null;
    // The gloss language decides which translation is asked for. Without one
    // the sentences still come, in the language being read.
    const to = request.glossLanguage ? toIso3(request.glossLanguage) : undefined;

    const url =
      'https://tatoeba.org/en/api_v0/search' +
      `?query=${encodeURIComponent(query)}` +
      `&from=${encodeURIComponent(from)}` +
      (to && to !== from ? `&to=${encodeURIComponent(to)}` : '') +
      '&sort=relevance&limit=10';

    const body = await context.http.json<Response>(url, { signal: context.signal });
    const examples = pickExamples(body.results ?? [], query, to);
    return examples.length ? { slots: { examples } } : null;
  },
};
