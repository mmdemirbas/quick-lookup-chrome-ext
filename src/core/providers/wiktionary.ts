/**
 * Wiktionary's own REST endpoint.
 *
 * Same underlying data as the freedictionaryapi provider but a completely
 * separate path: different operator, different infrastructure, different
 * failure mode. When one is down the card still has definitions.
 *
 * Definitions arrive as HTML fragments, so they are stripped before use.
 */
import type { Provider, ProviderResult, Sense } from '../types.ts';
import { stripHtml } from '../text.ts';

const SOURCE = 'en.wiktionary.org';

type Response = Record<
  string,
  Array<{
    partOfSpeech?: string;
    language?: string;
    definitions?: Array<{ definition?: string; examples?: string[] }>;
  }>
>;

export const wiktionaryProvider: Provider = {
  id: 'wiktionary',
  label: 'Wiktionary',
  intents: ['word', 'phrase'],
  slots: ['senses'],
  deadlineMs: 1200,

  async run(request, context): Promise<ProviderResult | null> {
    const lang = context.uiLang.split('-')[0] || 'en';
    // The REST path wants underscores rather than spaces, like article titles.
    const title = request.text.trim().replace(/\s+/g, '_');
    const url = `https://${lang}.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(
      title,
    )}`;
    // Where a reader goes, as opposed to where the data comes from. The
    // content is CC BY-SA and the licence asks for the link back.
    const page = `https://${lang}.wiktionary.org/wiki/${encodeURIComponent(title)}`;

    const body = await context.http.json<Response>(url, { signal: context.signal });
    const groups = body[lang];
    if (!Array.isArray(groups) || groups.length === 0) return null;

    const senses: Sense[] = [];
    for (const group of groups) {
      for (const entry of group.definitions ?? []) {
        const definition = stripHtml(entry.definition ?? '');
        if (definition.length < 2) continue;
        const example = (entry.examples ?? [])
          .map(stripHtml)
          .find((e) => e.length >= 8);
        senses.push({
          partOfSpeech: group.partOfSpeech?.toLowerCase(),
          definition,
          ...(example ? { example } : {}),
          source: SOURCE,
          url: page,
        });
      }
    }

    if (senses.length === 0) return null;
    return { slots: { senses } };
  },
};
