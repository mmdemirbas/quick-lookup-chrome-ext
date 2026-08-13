import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUERY_CHARS, readTranslation, translateOnline } from './online-translate.ts';
import type { HttpClient } from './types.ts';

/** Payloads exactly as the service returned them, including the string status. */
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

test('an error is never mistaken for a translation', () => {
  assert.equal(readTranslation(OK), 'geçici');
  // Every one of these arrives as HTTP 200 with the error in the field the
  // translation would occupy. Trusting the transport would print it.
  assert.equal(readTranslation(TOO_LONG), undefined);
  assert.equal(readTranslation(SAME_LANGUAGE), undefined);
  assert.equal(readTranslation(OUT_OF_QUOTA), undefined);
  assert.equal(readTranslation({ responseStatus: 200, responseData: { translatedText: '  ' } }), undefined);
});

test('a translation carries its source so the card can say where it came from', async () => {
  const http = stub(OK);
  const result = await translateOnline(http, {
    text: 'Lasting for a short period of time.',
    sourceLanguage: 'en',
    targetLanguage: 'tr',
  });
  assert.deepEqual(result, { text: 'geçici', source: 'mymemory' });
  assert.match(http.calls[0] ?? '', /langpair=en%7Ctr/);
  assert.doesNotMatch(http.calls[0] ?? '', /[&?]de=/, 'no address is sent unless one was given');
});

test('a contact address is passed through, because it raises the allowance', async () => {
  const http = stub(OK);
  await translateOnline(http, {
    text: 'ephemeral',
    sourceLanguage: 'en',
    targetLanguage: 'tr',
    email: 'reader@example.com',
  });
  assert.match(http.calls[0] ?? '', /de=reader%40example\.com/);
});

test('a selection past the documented limit is refused, not truncated', async () => {
  const http = stub(OK);
  const result = await translateOnline(http, {
    text: 'x'.repeat(MAX_QUERY_CHARS + 1),
    sourceLanguage: 'en',
    targetLanguage: 'tr',
  });
  // Half a sentence translated and shown as the whole would be worse than
  // nothing, and it would spend the daily allowance to do it.
  assert.equal(result, undefined);
  assert.equal(http.calls.length, 0, 'and it never leaves the device');
});

test('nothing is sent when the languages match, or when the service is down', async () => {
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
