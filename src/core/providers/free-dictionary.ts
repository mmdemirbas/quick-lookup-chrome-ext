/**
 * freedictionaryapi.com — Wiktionary data, no key, 1000 requests/hour/IP.
 *
 * This is the richest of the three dictionary sources: it carries
 * pronunciation, examples, synonyms and antonyms per sense. It is also the
 * slowest measured, so it is never allowed to gate the first paint.
 */
import type { Provider, ProviderResult, Related, Sense } from '../types.ts';
import { dedupeBy, truncate } from '../text.ts';
import { onePerDialect } from '../card.ts';

const SOURCE = 'freedictionaryapi.com';

/**
 * Head-words shown beside a translation. More than a few is a thesaurus,
 * not an answer.
 */
const MAX_EQUIVALENTS = 5;

type Response = {
  word?: string;
  /**
   * The API's own attribution block. `url` is the Wiktionary page this entry
   * was extracted from, which is the link its CC BY-SA licence asks for.
   */
  source?: { url?: string };
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
      translations?: Array<{ language?: { code?: string }; word?: string }>;
    }>;
    synonyms?: string[];
    antonyms?: string[];
  }>;
};

/**
 * Accent names, shortened to the abbreviations dictionaries print.
 *
 * Wiktionary spells them out — "Received Pronunciation", "General American" —
 * and three of those beside their transcriptions is two wrapped lines above
 * the definition, for a label nobody reads twice. Anything not in the table
 * is passed through if it is short and dropped if it is not: an unrecognised
 * long tag is more likely to be a usage note than an accent.
 */
const DIALECTS: Record<string, string> = {
  'received pronunciation': 'RP',
  'general american': 'US',
  'general australian': 'AU',
  american: 'US',
  britain: 'UK',
  british: 'UK',
  england: 'UK',
  uk: 'UK',
  us: 'US',
};

const MAX_DIALECT_CHARS = 14;

export function shortDialect(tag: string | undefined): string | undefined {
  const text = tag?.trim();
  if (!text) return undefined;
  const known = DIALECTS[text.toLowerCase()];
  if (known) return known;
  return text.length <= MAX_DIALECT_CHARS ? text : undefined;
}

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
  slots: ['headword', 'pronunciation', 'senses', 'related', 'translation'],
  deadlineMs: 1200,

  async run(request, context): Promise<ProviderResult | null> {
    const lang = context.uiLang.split('-')[0] || 'en';
    const target = request.glossLanguage;

    // Translations roughly triple the payload — 2.8 KB to 9.9 KB for
    // "ephemeral" — so they are only requested when one was asked for.
    const wantsTranslations = Boolean(target) && target !== lang;
    const url =
      `https://freedictionaryapi.com/api/v1/entries/${encodeURIComponent(lang)}` +
      // Trimmed, like every sibling provider does. A drag-selection or a
      // triple-click carries a trailing space, and this endpoint 404s on the
      // encoded one — silently losing the richest source on the card
      // (headword, pronunciation, senses, related and translation) while the
      // others still answered.
      `/${encodeURIComponent(request.text.trim().toLowerCase())}` +
      (wantsTranslations ? '?translations=true' : '');

    const body = await context.http.json<Response>(url, { signal: context.signal });
    const entries = body.entries ?? [];
    if (entries.length === 0) return null;

    const senses: Sense[] = [];
    const related: Related[] = [];
    const pronunciations: Array<{ ipa: string; dialect?: string }> = [];
    const equivalents: Array<{ word: string; source: string }> = [];

    for (const entry of entries) {
      if (entry.language?.code && entry.language.code !== lang) continue;

      for (const p of entry.pronunciations ?? []) {
        if (p.type === 'ipa' && p.text) {
          const dialect = shortDialect(p.tags?.[0]);
          pronunciations.push({ ipa: p.text, ...(dialect ? { dialect } : {}) });
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
          // Taken from the response rather than built from the word: the API
          // resolves redirects and spelling variants, so the page it names is
          // the page the text actually came from.
          ...(body.source?.url ? { url: body.source.url } : {}),
        });
        // Attached per sense, so these are the head-words for this meaning
        // rather than for the spelling. Senses arrive in dictionary order,
        // which puts the common meaning's word first.
        if (target) {
          for (const t of sense.translations ?? []) {
            if (t.language?.code === target && t.word) {
              equivalents.push({ word: t.word, source: SOURCE });
            }
          }
        }

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

    const words = dedupeBy(equivalents, (e) => e.word.toLowerCase()).slice(0, MAX_EQUIVALENTS);

    return {
      slots: {
        headword: body.word ?? request.text,
        pronunciation: onePerDialect(pronunciations),
        senses,
        related: dedupeBy(related, (r) => `${r.kind}:${r.word.toLowerCase()}`),
        // `text` doubles as the answer when no translator is available, so
        // the reader still gets something in their language.
        ...(target && words.length
          ? {
              translation: {
                text: words.map((w) => w.word).join(', '),
                lang: target,
                source: SOURCE,
                equivalents: words,
              },
            }
          : {}),
      },
    };
  },
};
