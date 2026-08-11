import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpClient, LookupRequest, ProviderContext } from '../types.ts';
import { freeDictionaryProvider } from './free-dictionary.ts';
import { wiktionaryProvider } from './wiktionary.ts';
import { datamuseProvider } from './datamuse.ts';
import { biasTerms, chooseCandidate, wikipediaProvider } from './wikipedia.ts';
import { linksFor } from './links.ts';

/** Serves canned payloads by URL substring, and records what was requested. */
function stubHttp(routes: Array<[string, unknown]>): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async json(url: string) {
      calls.push(url);
      for (const [needle, payload] of routes) {
        if (url.includes(needle)) return payload as never;
      }
      throw new Error(`no stub for ${url}`);
    },
  };
}

const context = (http: HttpClient): ProviderContext => ({
  http,
  signal: new AbortController().signal,
  uiLang: 'en',
});

const request: LookupRequest = { id: 'r1', text: 'ephemeral', uiLang: 'en', page: {} };

test('free dictionary maps senses, pronunciation and related words', async () => {
  const http = stubHttp([
    [
      'freedictionaryapi.com',
      {
        word: 'ephemeral',
        entries: [
          {
            language: { code: 'en' },
            partOfSpeech: 'adjective',
            pronunciations: [
              { type: 'ipa', text: '/ɛˈfɛ.mə.ɹəl/', tags: ['UK'] },
              { type: 'audio', text: 'ignored' },
            ],
            senses: [
              {
                definition: 'Lasting for a short period of time.',
                examples: ['1821, Vicesimus Knox, Remarks: the ephemeral fashions of the day'],
                synonyms: ['transient'],
                antonyms: ['permanent'],
              },
            ],
            synonyms: ['fleeting'],
          },
        ],
      },
    ],
  ]);

  const result = await freeDictionaryProvider.run(request, context(http));
  assert.ok(result);
  assert.equal(result.slots.headword, 'ephemeral');
  assert.deepEqual(result.slots.pronunciation, [{ ipa: '/ɛˈfɛ.mə.ɹəl/', dialect: 'UK' }]);

  const senses = result.slots.senses ?? [];
  assert.equal(senses.length, 1);
  assert.equal(senses[0]?.partOfSpeech, 'adjective');
  // The bibliographic prefix is stripped so the example reads as an example.
  assert.equal(senses[0]?.example, 'the ephemeral fashions of the day');

  const related = result.slots.related ?? [];
  assert.deepEqual(
    related.map((r) => `${r.kind}:${r.word}`),
    ['synonym:transient', 'antonym:permanent', 'synonym:fleeting'],
  );
});

test('free dictionary returns nothing rather than an empty card', async () => {
  const http = stubHttp([['freedictionaryapi.com', { word: 'zzz', entries: [] }]]);
  assert.equal(await freeDictionaryProvider.run(request, context(http)), null);
});

test('wiktionary definitions are stripped of markup', async () => {
  const http = stubHttp([
    [
      'wiktionary.org',
      {
        en: [
          {
            partOfSpeech: 'Adjective',
            definitions: [
              {
                definition:
                  'Lasting for a <a rel="mw:WikiLink" href="/wiki/short">short</a> period of time.',
                examples: ['<i>An</i> ephemeral victory.'],
              },
              { definition: '' },
            ],
          },
        ],
      },
    ],
  ]);

  const result = await wiktionaryProvider.run(request, context(http));
  const senses = result?.slots.senses ?? [];
  assert.equal(senses.length, 1, 'the empty definition is dropped');
  assert.equal(senses[0]?.definition, 'Lasting for a short period of time.');
  assert.equal(senses[0]?.example, 'An ephemeral victory.');
  assert.equal(senses[0]?.partOfSpeech, 'adjective');
});

test('datamuse splits its tab-encoded definitions and keeps its tags', async () => {
  const http = stubHttp([
    ['ml=', [{ word: 'transitory', tags: ['syn'], defs: ['adj\tLasting only a short time.'] }]],
    ['rel_bgb=', [{ word: 'nature' }]],
  ]);

  const result = await datamuseProvider.run(request, context(http));
  const related = result?.slots.related ?? [];
  assert.deepEqual(related[0], {
    word: 'transitory',
    kind: 'synonym',
    definition: 'Lasting only a short time.',
    source: 'datamuse',
  });
  assert.equal(related[1]?.kind, 'collocation');
});

test('datamuse survives one of its two requests failing', async () => {
  const http: HttpClient = {
    async json(url: string) {
      if (url.includes('rel_bgb=')) throw new Error('down');
      return [{ word: 'transitory', tags: ['syn'] }] as never;
    },
  };
  const result = await datamuseProvider.run(request, context(http));
  assert.equal(result?.slots.related?.length, 1);
});

const TURING = {
  type: 'standard',
  title: 'Alan Turing',
  description: 'English computer scientist (1912-1954)',
  extract: 'Alan Mathison Turing was an English mathematician and computer scientist.',
  thumbnail: { source: 'https://upload.wikimedia.org/turing.jpg' },
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Alan_Turing' } },
};

test('wikipedia answers from the cached summary without touching search', async () => {
  // Search is rate limited far more aggressively than the summary endpoint,
  // so the common case must not reach it at all.
  const http = stubHttp([['page/summary', TURING]]);
  const result = await wikipediaProvider.run(
    { ...request, text: 'Alan Turing' },
    context(http),
  );

  assert.equal(result?.slots.entity?.title, 'Alan Turing');
  assert.equal(result?.slots.entity?.imageUrl, 'https://upload.wikimedia.org/turing.jpg');
  assert.match(result?.slots.extract?.text ?? '', /^Alan Mathison Turing/);
  assert.equal(http.calls.length, 1, 'exactly one request for a direct hit');
  assert.match(http.calls[0] ?? '', /page\/summary\/Alan_Turing$/);
});

/** Action API `generator=search` shape: candidates carry their own extract. */
const searchPayload = (pages: Array<Record<string, unknown>>) => ({
  query: { pages: Object.fromEntries(pages.map((p, i) => [String(i), { index: i, ...p }])) },
});

test('a missing article falls back to one search that carries the extract', async () => {
  const http: HttpClient & { calls: string[] } = {
    calls: [],
    async json(url: string) {
      this.calls.push(url);
      if (url.includes('page/summary')) throw new Error('HTTP 404');
      return searchPayload([
        {
          title: 'Alan Turing',
          description: 'English computer scientist',
          extract: 'Alan Mathison Turing was an English mathematician.',
          thumbnail: { source: 'https://upload.wikimedia.org/turing.jpg' },
        },
      ]) as never;
    },
  };

  const result = await wikipediaProvider.run({ ...request, text: 'the turing man' }, context(http));
  assert.equal(result?.slots.entity?.title, 'Alan Turing');
  assert.equal(result?.slots.entity?.imageUrl, 'https://upload.wikimedia.org/turing.jpg');
  // No follow-up summary request: the search already returned the extract.
  assert.equal(http.calls.length, 2, 'direct summary, then one search');
});

test('page topic biases the search query, and over-constraining retries plain', async () => {
  const queries: string[] = [];
  const http: HttpClient = {
    async json(url: string) {
      if (url.includes('page/summary')) throw new Error('HTTP 404');
      const term = decodeURIComponent(/gsrsearch=([^&]*)/.exec(url)?.[1] ?? '');
      queries.push(term);
      // The biased query is too specific and finds nothing, as measured
      // against the real API with four or more terms.
      if (term.includes('iceberg')) return searchPayload([]) as never;
      return searchPayload([{ title: 'Manifest', extract: 'A manifest is a document.' }]) as never;
    },
  };

  await wikipediaProvider.run(
    {
      ...request,
      text: 'manifest',
      page: { topicTerms: ['iceberg', 'table', 'metadata', 'query', 'partition'] },
    },
    context(http),
  );

  assert.equal(queries.length, 2, 'biased first, then plain');
  assert.equal(queries[0], 'manifest iceberg table metadata', 'at most three bias terms');
  assert.equal(queries[1], 'manifest');
});

test('bias terms never repeat words from the selection itself', () => {
  const terms = biasTerms({ topicTerms: ['planner', 'database', 'query', 'table'] }, 'planner');
  assert.ok(!terms.includes('planner'));
  assert.deepEqual(terms, ['database', 'query', 'table']);
});

test('candidates are chosen by context, falling back to search rank', () => {
  const candidates = [
    { title: 'Wedding planner', description: 'organises weddings', index: 0 },
    { title: 'Query optimization', description: 'database query execution', index: 1 },
  ];
  assert.equal(chooseCandidate(candidates, ['database', 'query'])?.candidate.title, 'Query optimization');
  assert.equal(chooseCandidate(candidates, [])?.candidate.title, 'Wedding planner');
  assert.equal(chooseCandidate([], ['x']), undefined);

  // A miss reports a zero score, which is how the caller detects that a
  // topic-biased search returned something unrelated to the page.
  const miss = chooseCandidate(candidates, ['zzzz']);
  assert.equal(miss?.candidate.title, 'Wedding planner');
  assert.equal(miss?.score, 0);
});

test('a biased search that returns unrelated results is retried without bias', async () => {
  // Measured behaviour: searching "planner iceberg" returns a Toyota model.
  // The bias misfires by being confidently wrong, not by being empty.
  const queries: string[] = [];
  const http: HttpClient = {
    async json(url: string) {
      if (url.includes('page/summary')) throw new Error('HTTP 404');
      const term = decodeURIComponent(/gsrsearch=([^&]*)/.exec(url)?.[1] ?? '');
      queries.push(term);
      if (term.includes('iceberg')) {
        return searchPayload([
          { title: 'Toyota FJ Cruiser', description: 'sport utility vehicle', extract: 'A mid-size SUV.' },
        ]) as never;
      }
      return searchPayload([
        { title: 'Query optimization', description: 'database query planning', extract: 'Choosing an execution plan for a database query.' },
      ]) as never;
    },
  };

  const result = await wikipediaProvider.run(
    {
      ...request,
      text: 'planner',
      page: { topicTerms: ['iceberg', 'table', 'query', 'database', 'execution'] },
    },
    context(http),
  );

  assert.equal(queries.length, 2, 'the irrelevant biased result triggers a plain retry');
  assert.equal(result?.slots.entity?.title, 'Query optimization');
});

test('a disambiguation article is rejected from either path', async () => {
  const http: HttpClient = {
    async json(url: string) {
      if (url.includes('page/summary')) {
        return { type: 'disambiguation', title: 'Planner', extract: 'Planner may refer to:' } as never;
      }
      return searchPayload([{ title: 'Planner', extract: 'Planner may refer to: a person…' }]) as never;
    },
  };
  assert.equal(await wikipediaProvider.run({ ...request, text: 'planner' }, context(http)), null);
});

test('wikipedia returns nothing rather than throwing when everything fails', async () => {
  const http: HttpClient = {
    async json() {
      throw new Error('HTTP 429');
    },
  };
  assert.equal(await wikipediaProvider.run(request, context(http)), null);
});

test('quick links differ by intent and are all absolute https URLs', () => {
  const word = linksFor('word', 'ephemeral', 'en').map((l) => l.id);
  const technical = linksFor('technical', 'merge into', 'en').map((l) => l.id);
  assert.ok(word.includes('wiktionary'));
  assert.ok(technical.includes('mdn'));
  assert.notDeepEqual(word, technical);

  for (const link of linksFor('entity', 'Alan Turing & Co', 'en')) {
    assert.match(link.url, /^https:\/\//);
    assert.ok(!link.url.includes(' '), 'the query must be encoded');
  }
});
