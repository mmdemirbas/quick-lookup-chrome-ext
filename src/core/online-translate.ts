/**
 * Online translation, for browsers that have no translator of their own.
 *
 * Off by default and never used unless switched on, because these are the
 * only sources that send the selection to a third party. Everything else in
 * this extension either runs locally or asks about a word the reader chose
 * to look up; this asks a translation service to read the sentence.
 *
 * Two services, tried in order, because they fail in different ways:
 *
 * - **Google.** The endpoint the Google Translate web widget calls. No key,
 *   no published quota, and by far the better Turkish. It is also
 *   undocumented, so it can change or start refusing without notice — which
 *   is exactly why it is a chain rather than a single source.
 * - **MyMemory.** Documented and stable, but allowances are counted in
 *   characters and run out under daily use: 5,000 a day anonymously, 50,000
 *   with a contact address in the `de` parameter, 500 per query. Limits from
 *   https://mymemory.translated.net/doc/usagelimits.php
 *
 * The trap this file exists to close: neither service reports failure with a
 * status code alone. MyMemory returns HTTP 200 with the error text sitting
 * in the translation field, so a caller that trusts the transport would show
 * "QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS" to the reader
 * as though it were Turkish. Google returns a nested array whose shape has
 * no schema at all, so every level of it is checked before it is believed.
 */
import type { HttpClient } from './types.ts';
import { sameLanguage } from './language.ts';

/** A service that can answer. Also the source name shown on the card. */
export type TranslationService = 'google' | 'mymemory';

/**
 * What to pass as the source language when it is genuinely unknown.
 *
 * Naming a language that is not the text's own is worse than naming none:
 * measured against both services, `sl=en` on German text returns the German
 * back, unchanged and with no error — a translation the reader would have to
 * read to discover was never made. Only a service that can detect for itself
 * may be asked under this.
 */
export const UNKNOWN_LANGUAGE = 'auto';

/** What the reader picked in settings. `auto` tries each in turn. */
export type TranslationPreference = 'auto' | TranslationService;

export type OnlineTranslation = { text: string; source: TranslationService };

/** MyMemory's documented maximum for one query. Longer is refused, never truncated. */
export const MAX_QUERY_CHARS = 500;

/**
 * Google's cap here is ours, not theirs: the text travels in a query string,
 * and a URL long enough to be refused by an intermediary would fail in a way
 * that looks like an outage. Selections are capped at 300 characters, so
 * this only ever binds on a long definition being glossed.
 */
const MAX_GOOGLE_CHARS = 1800;

type MyMemoryResponse = {
  responseStatus?: number | string;
  responseDetails?: string;
  responseData?: { translatedText?: string; match?: number };
};

/**
 * Messages MyMemory returns in the translation field itself. Checked in
 * addition to the status, because the status is the thing most likely to
 * change shape and this is the text the reader would actually see.
 */
const NOT_A_TRANSLATION =
  /^\s*(?:MYMEMORY WARNING|QUERY LENGTH LIMIT|PLEASE SELECT|INVALID |AUTH |ALL AVAILABLE FREE TRANSLATIONS)/i;

/** The translated text, or nothing if MyMemory reported a problem. */
export function readMyMemoryTranslation(body: MyMemoryResponse): string | undefined {
  // The status arrives as a number on success and a string on failure.
  if (Number(body.responseStatus) !== 200) return undefined;
  const text = body.responseData?.translatedText?.trim();
  if (!text || NOT_A_TRANSLATION.test(text)) return undefined;
  return text;
}

/**
 * The translated text out of Google's nested array.
 *
 * The payload is `[[[translated, original, …], …], null, sourceLang, …]`:
 * one row per sentence, which is why the pieces are joined rather than
 * indexed. Nothing about that shape is promised anywhere, so each level is
 * checked rather than asserted — a change in it must produce an empty slot,
 * not a card showing `undefined`.
 */
export function readGoogleTranslation(body: unknown): string | undefined {
  const rows = Array.isArray(body) ? body[0] : undefined;
  if (!Array.isArray(rows)) return undefined;

  let out = '';
  for (const row of rows) {
    const piece = Array.isArray(row) ? row[0] : undefined;
    if (typeof piece === 'string') out += piece;
  }
  return out.trim() || undefined;
}

type Options = {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** Raises MyMemory's daily allowance from 5,000 characters to 50,000. */
  email?: string;
};

type Spec = {
  maxChars: number;
  /** Whether the service works out the source language itself. */
  detects: boolean;
  url(options: Options): string;
  read(body: unknown): string | undefined;
};

const SPECS: Record<TranslationService, Spec> = {
  google: {
    maxChars: MAX_GOOGLE_CHARS,
    // `sl=auto` is what the web widget itself sends.
    detects: true,
    url: ({ text, sourceLanguage, targetLanguage }) =>
      'https://translate.googleapis.com/translate_a/single' +
      `?client=gtx&sl=${encodeURIComponent(sourceLanguage)}` +
      `&tl=${encodeURIComponent(targetLanguage)}` +
      // `dt=t` asks for the translation and nothing else. The other data
      // types return transliteration and dictionary entries, which this
      // extension already has better sources for.
      `&dt=t&q=${encodeURIComponent(text)}`,
    read: readGoogleTranslation,
  },
  mymemory: {
    maxChars: MAX_QUERY_CHARS,
    // `langpair` takes two codes and has no autodetecting form.
    detects: false,
    url: ({ text, sourceLanguage, targetLanguage, email }) =>
      'https://api.mymemory.translated.net/get' +
      `?q=${encodeURIComponent(text)}` +
      `&langpair=${encodeURIComponent(`${sourceLanguage}|${targetLanguage}`)}` +
      (email ? `&de=${encodeURIComponent(email)}` : ''),
    read: (body) => readMyMemoryTranslation(body as MyMemoryResponse),
  },
};

/**
 * Which services to try, in order.
 *
 * Google leads under `auto` because it has no allowance to exhaust and
 * answers Turkish better. Naming a single service is a way to opt out of
 * the undocumented one, not only a preference.
 */
export function servicesFor(preference: TranslationPreference): TranslationService[] {
  if (preference === 'google' || preference === 'mymemory') return [preference];
  // Anything else — `auto`, or a name written by a version that knew about a
  // service this one does not — falls back to the whole chain. Settings are
  // merged by type rather than by value, so an unknown string does reach
  // here, and indexing the table with it would throw inside the lookup.
  return ['google', 'mymemory'];
}

export async function translateOnline(
  http: HttpClient,
  options: Options & {
    preference?: TranslationPreference;
    signal?: AbortSignal;
  },
): Promise<OnlineTranslation | undefined> {
  const text = options.text.trim();
  if (!text) return undefined;
  const unknownSource = options.sourceLanguage === UNKNOWN_LANGUAGE;
  // Region and script do not make a translation: `en-GB` to `en-US` would
  // spend a request to be handed the input back.
  if (!unknownSource && sameLanguage(options.sourceLanguage, options.targetLanguage)) {
    return undefined;
  }

  for (const service of servicesFor(options.preference ?? 'auto')) {
    const spec = SPECS[service];
    // Too long for this service is a reason to try the next one, not to
    // give up: their limits differ by more than three times.
    if (text.length > spec.maxChars) continue;
    // As is a service that would have to be told a language nobody knows.
    if (unknownSource && !spec.detects) continue;

    try {
      const body = await http.json<unknown>(spec.url({ ...options, text }), {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const translated = spec.read(body);
      if (translated) return { text: translated, source: service };
    } catch {
      // An outage or a refusal moves to the next service. When none answer
      // the slot is absent, exactly like any other source that failed.
    }
    if (options.signal?.aborted) return undefined;
  }
  return undefined;
}
