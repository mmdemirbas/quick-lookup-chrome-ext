/**
 * freedictionaryapi.com — Wiktionary data, no key, 1000 requests/hour/IP.
 *
 * This is the richest of the three dictionary sources: it carries
 * pronunciation, examples, synonyms and antonyms per sense. It is also the
 * slowest measured, so it is never allowed to gate the first paint.
 */
import type { Provider, ProviderResult, Related, Sense } from '../types.ts';
import { dedupeBy, truncate } from '../text.ts';

const SOURCE = 'freedictionaryapi.com';

type Response = {
  word?: string;
  entries?: Array<{
    language?: { code?: string };
    partOfSpeech?: string;
    pronunciations?: Array<{ type?: string; text?: string; tags?: string[] }>;
    senses?: Array<{
      definition?: string;
      tags?: string[];
      examples?: string[];
      synonyms?: string[];
      antonyms?: string[];
    }>;
    synonyms?: string[];
    antonyms?: string[];
  }>;
};

/** Wiktionary example strings often begin with a bibliographic citation. */
function cleanExample(raw: string): string | undefined {
  const withoutCitation = raw.replace(/^\s*\d{4}[^,]*,\s*[^:]{0,80}:\s*/, '');
  const text = withoutCitation.trim();
  return text.length >= 8 ? truncate(text, 180) : undefined;
}

export const freeDictionaryProvider: Provider = {
  id: 'free-dictionary',
  label: 'Wiktionary via freedictionaryapi.com',
  intents: ['word', 'phrase'],
  slots: ['headword', 'pronunciation', 'senses', 'related'],
  deadlineMs: 1200,

  async run(request, context): Promise<ProviderResult | null> {
    const lang = context.uiLang.split('-')[0] || 'en';
    const url = `https://freedictionaryapi.com/api/v1/entries/${encodeURIComponent(
      lang,
    )}/${encodeURIComponent(request.text.toLowerCase())}`;

    const body = await context.http.json<Response>(url, { signal: context.signal });
    const entries = body.entries ?? [];
    if (entries.length === 0) return null;

    const senses: Sense[] = [];
    const related: Related[] = [];
    const pronunciations: Array<{ ipa: string; dialect?: string }> = [];

    for (const entry of entries) {
      if (entry.language?.code && entry.language.code !== lang) continue;

      for (const p of entry.pronunciations ?? []) {
        if (p.type === 'ipa' && p.text) {
          pronunciations.push({ ipa: p.text, dialect: p.tags?.[0] });
        }
      }

      for (const sense of entry.senses ?? []) {
        if (!sense.definition) continue;
        const example = (sense.examples ?? []).map(cleanExample).find(Boolean);
        senses.push({
          partOfSpeech: entry.partOfSpeech,
          definition: sense.definition,
          ...(example ? { example } : {}),
          ...(sense.tags?.length ? { labels: sense.tags } : {}),
          source: SOURCE,
        });
        for (const word of sense.synonyms ?? []) {
          related.push({ word, kind: 'synonym', source: SOURCE });
        }
        for (const word of sense.antonyms ?? []) {
          related.push({ word, kind: 'antonym', source: SOURCE });
        }
      }

      for (const word of entry.synonyms ?? []) {
        related.push({ word, kind: 'synonym', source: SOURCE });
      }
      for (const word of entry.antonyms ?? []) {
        related.push({ word, kind: 'antonym', source: SOURCE });
      }
    }

    if (senses.length === 0) return null;

    return {
      slots: {
        headword: body.word ?? request.text,
        pronunciation: dedupeBy(pronunciations, (p) => p.ipa),
        senses,
        related: dedupeBy(related, (r) => `${r.kind}:${r.word.toLowerCase()}`),
      },
    };
  },
};
