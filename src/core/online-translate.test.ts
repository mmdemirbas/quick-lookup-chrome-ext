import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_QUERY_CHARS,
  readGoogleTranslation,
  readMyMemoryTranslation,
  servicesFor,
  translateOnline,
  UNKNOWN_LANGUAGE,
} from './online-translate.ts';
import type { HttpClient } from './types.ts';

/** Payloads exactly as the services returned them, including the string status. */
const OK = { responseStatus: 200, responseData: { translatedText: 'geçici', match: 0.85 } };
const TOO_LONG = {
  responseStatus: '403',
  responseDetails: 'QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS',
  responseData: { translatedText: 'QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS' },
};
const SAME_LANGUAGE = {
  responseStatus: '403',
  responseDetails: 'PLEASE SELECT TWO DISTINCT LANGUAGES',
  responseData: { translatedText: 'PLEASE SELECT TWO DISTINCT LANGUAGES' },
};
const OUT_OF_QUOTA = {
  responseStatus: 200,
  responseData: {
    translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.',
  },
};

/** One sentence, captured from the live endpoint on 2026-08-16. */
const GOOGLE_OK = [
  [['Anlık görüntü izolasyon düzeyi kirli okumaları önler.', 'The snapshot isolation level prevents dirty reads.', null, null, 3]],
  null,
  'en',
];

/**
 * Google splits a multi-sentence request into one row per sentence, and
 * carries the separating space at the end of the row before. Captured live,
 * because concatenating rows the other way round would run the sentences
 * together and no test written from memory would have noticed.
 */
const GOOGLE_TWO_SENTENCES = [
  [
    ['Kısa bir süre sürer. ', 'It lasts a short time. ', null, null, 3],
    ['Sonra ortadan kayboluyor.', 'Then it disappears.', null, null, 3],
  ],
  null,
  'en',
];

const stub = (payload: unknown): HttpClient & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async json(url: string) {
      calls.push(url);
      return payload as never;
    },
  };
};

/** Answers each host with a different payload, so a fallback is observable. */
const routed = (byHost: Record<string, unknown>): HttpClient & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async json(url: string) {
      calls.push(url);
      const host = new URL(url).host;
      const payload = byHost[host];
      if (payload === undefined) throw new Error(`HTTP 503 for ${host}`);
      return payload as never;
    },
  };
};

test('a MyMemory error is never mistaken for a translation', () => {
  assert.equal(readMyMemoryTranslation(OK), 'geçici');
  // Every one of these arrives as HTTP 200 with the error in the field the
  // translation would occupy. Trusting the transport would print it.
  assert.equal(readMyMemoryTranslation(TOO_LONG), undefined);
  assert.equal(readMyMemoryTranslation(SAME_LANGUAGE), undefined);
  assert.equal(readMyMemoryTranslation(OUT_OF_QUOTA), undefined);
  assert.equal(
    readMyMemoryTranslation({ responseStatus: 200, responseData: { translatedText: '  ' } }),
    undefined,
  );
});

test("Google's nested array is read defensively at every level", () => {
  assert.equal(
    readGoogleTranslation(GOOGLE_OK),
    'Anlık görüntü izolasyon düzeyi kirli okumaları önler.',
  );
  // Sentences are joined rather than indexed, or a two-sentence selection
  // would silently lose its second half.
  assert.equal(
    readGoogleTranslation(GOOGLE_TWO_SENTENCES),
    'Kısa bir süre sürer. Sonra ortadan kayboluyor.',
  );
  // The shape is undocumented, so every way it could change has to end in an
  // absent slot rather than in "undefined" printed on the card.
  assert.equal(readGoogleTranslation(null), undefined);
  assert.equal(readGoogleTranslation({ error: 'quota' }), undefined);
  assert.equal(readGoogleTranslation([null, null, 'en']), undefined);
  assert.equal(readGoogleTranslation([[]]), undefined);
  assert.equal(readGoogleTranslation([[[null, 'x']]]), undefined);
});

test('the default order tries the service with no allowance to exhaust first', () => {
  assert.deepEqual(servicesFor('auto'), ['google', 'mymemory']);
  // Naming one is how the reader opts out of the undocumented endpoint.
  assert.deepEqual(servicesFor('mymemory'), ['mymemory']);
  assert.deepEqual(servicesFor('google'), ['google']);
  // Settings merge by type, so a name from another version reaches this far.
  // Indexing the service table with it would throw inside the lookup.
  assert.deepEqual(servicesFor('deepl' as never), ['google', 'mymemory']);
});

test('a translation carries its source so the card can say where it came from', async () => {
  const http = stub(OK);
  const result = await translateOnline(http, {
    text: 'Lasting for a short period of time.',
    sourceLanguage: 'en',
    targetLanguage: 'tr',
    preference: 'mymemory',
  });
  assert.deepEqual(result, { text: 'geçici', source: 'mymemory' });
  assert.match(http.calls[0] ?? '', /langpair=en%7Ctr/);
  assert.doesNotMatch(http.calls[0] ?? '', /[&?]de=/, 'no address is sent unless one was given');
});

test('a service that is down hands the selection to the next one', async () => {
  const http = routed({ 'api.mymemory.translated.net': OK });
  const result = await translateOnline(http, {
    text: 'Lasting for a short period of time.',
    sourceLanguage: 'en',
    targetLanguage: 'tr',
  });
  assert.deepEqual(result, { text: 'geçici', source: 'mymemory' });
  assert.equal(http.calls.length, 2, 'Google was asked first and MyMemory answered');
});

test('the leading service answering means the fallback is never asked', async () => {
  const http = routed({ 'translate.googleapis.com': GOOGLE_OK });
  const result = await translateOnline(http, {
    text: 'The snapshot isolation level prevents dirty reads.',
    sourceLanguage: 'en',
    targetLanguage: 'tr',
  });
  assert.equal(result?.source, 'google');
  assert.equal(http.calls.length, 1);
});

test('a contact address is passed through, because it raises the allowance', async () => {
  const http = stub(OK);
  await translateOnline(http, {
    text: 'ephemeral',
    sourceLanguage: 'en',
    targetLanguage: 'tr',
    email: 'reader@example.com',
    preference: 'mymemory',
  });
  assert.match(http.calls[0] ?? '', /de=reader%40example\.com/);
});

test('a selection past a service limit is refused, not truncated', async () => {
  const http = stub(OK);
  const result = await translateOnline(http, {
    text: 'x'.repeat(MAX_QUERY_CHARS + 1),
    sourceLanguage: 'en',
    targetLanguage: 'tr',
    preference: 'mymemory',
  });
  // Half a sentence translated and shown as the whole would be worse than
  // nothing, and it would spend the daily allowance to do it.
  assert.equal(result, undefined);
  assert.equal(http.calls.length, 0, 'and it never leaves the device');
});

test('being too long for one service is a reason to try the next, not to stop', async () => {
  const http = routed({ 'translate.googleapis.com': GOOGLE_OK });
  const long = 'word '.repeat(MAX_QUERY_CHARS / 4);
  assert.ok(long.length > MAX_QUERY_CHARS);
  const result = await translateOnline(http, {
    text: long,
    sourceLanguage: 'en',
    targetLanguage: 'tr',
  });
  assert.equal(result?.source, 'google');
  assert.equal(http.calls.length, 1, 'MyMemory was skipped rather than asked and refused');
});

/**
 * The defect this closes, measured against both live services on 2026-08-17.
 *
 * The caller used to say `en` whatever had been selected. Given the German
 * sentence "Der Schnee fiel die ganze Nacht und die Schulen blieben
 * geschlossen" and a Turkish target, `sl=en` returned that German sentence
 * back, unchanged, with HTTP 200 and no error field — and MyMemory did the
 * same for `en|tr`. With the source named correctly, both answered "Bütün
 * gece kar yağdı ve okullar kapalı kaldı". A wrong language is worse than
 * no language: it fails silently and looks like an answer.
 */
test('a service that cannot detect is not asked about a language nobody knows', async () => {
  const http = routed({ 'translate.googleapis.com': GOOGLE_OK });
  const result = await translateOnline(http, {
    text: 'The snapshot isolation level prevents dirty reads.',
    sourceLanguage: UNKNOWN_LANGUAGE,
    targetLanguage: 'tr',
  });

  assert.equal(result?.source, 'google');
  assert.equal(http.calls.length, 1);
  assert.match(http.calls[0] ?? '', /[?&]sl=auto\b/, 'Google is told to detect it');

  // MyMemory's langpair takes two codes and has no autodetecting form, so
  // asking it under an unknown source could only be asking it wrongly.
  const alone = stub(OK);
  assert.equal(
    await translateOnline(alone, {
      text: 'The snapshot isolation level prevents dirty reads.',
      sourceLanguage: UNKNOWN_LANGUAGE,
      targetLanguage: 'tr',
      preference: 'mymemory',
    }),
    undefined,
  );
  assert.equal(alone.calls.length, 0, 'no request, rather than a request naming the wrong language');
});

test('a region is not a translation', async () => {
  // `en-GB` to `en-US` would spend a request to be handed the input back.
  const http = stub(OK);
  assert.equal(
    await translateOnline(http, { text: 'colour', sourceLanguage: 'en-GB', targetLanguage: 'en' }),
    undefined,
  );
  assert.equal(http.calls.length, 0);
});

test('nothing is sent when the languages match, or when every service is down', async () => {
  const http = stub(OK);
  assert.equal(
    await translateOnline(http, { text: 'hello', sourceLanguage: 'en', targetLanguage: 'en' }),
    undefined,
  );
  assert.equal(http.calls.length, 0);

  const broken: HttpClient = {
    async json() {
      throw new Error('HTTP 503');
    },
  };
  assert.equal(
    await translateOnline(broken, { text: 'hello', sourceLanguage: 'en', targetLanguage: 'tr' }),
    undefined,
  );
});
