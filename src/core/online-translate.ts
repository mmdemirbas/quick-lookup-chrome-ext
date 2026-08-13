/**
 * MyMemory — translation for machines that have no on-device model.
 *
 * Off by default and never used unless switched on, because it is the one
 * source that sends the selection to a third party. Everything else in this
 * extension either runs locally or asks about a word the reader chose to
 * look up; this asks a translation service to read the sentence.
 *
 * Limits are documented at https://mymemory.translated.net/doc/usagelimits.php
 * and measured here: 5,000 characters a day anonymously, 50,000 with a
 * contact address in the `de` parameter, counted in characters rather than
 * requests, and 500 characters per query.
 *
 * The trap this file exists to close: errors come back as HTTP 200 with the
 * error text in the translation field. A caller that trusts the transport
 * would show "QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS"
 * to the reader as though it were Turkish.
 */
import type { HttpClient } from './types.ts';

export const SOURCE = 'mymemory';

/** Documented maximum for one query. Longer is refused, never truncated. */
export const MAX_QUERY_CHARS = 500;

type Response = {
  responseStatus?: number | string;
  responseDetails?: string;
  responseData?: { translatedText?: string; match?: number };
};

/**
 * Messages the service returns in the translation field itself. Checked in
 * addition to the status, because the status is the thing most likely to
 * change shape and this is the text the reader would actually see.
 */
const NOT_A_TRANSLATION =
  /^\s*(?:MYMEMORY WARNING|QUERY LENGTH LIMIT|PLEASE SELECT|INVALID |AUTH |ALL AVAILABLE FREE TRANSLATIONS)/i;

/** The translated text, or nothing if the service reported a problem. */
export function readTranslation(body: Response): string | undefined {
  // The status arrives as a number on success and a string on failure.
  if (Number(body.responseStatus) !== 200) return undefined;
  const text = body.responseData?.translatedText?.trim();
  if (!text || NOT_A_TRANSLATION.test(text)) return undefined;
  return text;
}

export type OnlineTranslation = { text: string; source: string };

export async function translateOnline(
  http: HttpClient,
  options: {
    text: string;
    sourceLanguage: string;
    targetLanguage: string;
    /** Raises the daily allowance from 5,000 characters to 50,000. */
    email?: string;
    signal?: AbortSignal;
  },
): Promise<OnlineTranslation | undefined> {
  const text = options.text.trim();
  const { sourceLanguage, targetLanguage } = options;
  if (!text || text.length > MAX_QUERY_CHARS) return undefined;
  if (sourceLanguage === targetLanguage) return undefined;

  const url =
    'https://api.mymemory.translated.net/get' +
    `?q=${encodeURIComponent(text)}` +
    `&langpair=${encodeURIComponent(`${sourceLanguage}|${targetLanguage}`)}` +
    (options.email ? `&de=${encodeURIComponent(options.email)}` : '');

  try {
    const body = await http.json<Response>(url, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const translated = readTranslation(body);
    return translated ? { text: translated, source: SOURCE } : undefined;
  } catch {
    // An outage or a refusal removes the slot, exactly like any other source.
    return undefined;
  }
}
