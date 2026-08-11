import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpClient, LookupRequest, ProviderContext } from '../types.ts';
import { freeDictionaryProvider } from './free-dictionary.ts';
import { wiktionaryProvider } from './wiktionary.ts';
import { datamuseProvider } from './datamuse.ts';
import { chooseCandidate, wikipediaProvider } from './wikipedia.ts';
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

test('wikipedia candidate choice follows page context when it says something', () => {
  const pages = [
    { key: 'Wedding_planner', title: 'Wedding planner', description: 'person who organises weddings' },
    { key: 'Query_planner', title: 'Query planner', description: 'database query execution component' },
  ];
  assert.equal(chooseCandidate(pages, ['database', 'query', 'table'])?.key, 'Query_planner');
  // With no context, Wikipedia's own relevance order is respected.
  assert.equal(chooseCandidate(pages, [])?.key, 'Wedding_planner');
  // Context that matches nothing must not reorder anything.
  assert.equal(chooseCandidate(pages, ['zzzz'])?.key, 'Wedding_planner');
  assert.equal(chooseCandidate([], ['x']), undefined);
});

test('wikipedia skips disambiguation pages', async () => {
  const http = stubHttp([
    ['search/title', { pages: [{ key: 'Mercury' }] }],
    ['page/summary', { type: 'disambiguation', title: 'Mercury', extract: 'May refer to:' }],
  ]);
  assert.equal(await wikipediaProvider.run(request, context(http)), null);
});

test('wikipedia maps a summary into both the entity and extract slots', async () => {
  const http = stubHttp([
    ['search/title', { pages: [{ key: 'Alan_Turing', title: 'Alan Turing' }] }],
    [
      'page/summary',
      {
        type: 'standard',
        title: 'Alan Turing',
        description: 'English computer scientist (1912-1954)',
        extract: 'Alan Mathison Turing was an English mathematician and computer scientist.',
        thumbnail: { source: 'https://upload.wikimedia.org/turing.jpg' },
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Alan_Turing' } },
      },
    ],
  ]);

  const result = await wikipediaProvider.run(request, context(http));
  assert.equal(result?.slots.entity?.title, 'Alan Turing');
  assert.equal(result?.slots.entity?.imageUrl, 'https://upload.wikimedia.org/turing.jpg');
  assert.match(result?.slots.extract?.text ?? '', /^Alan Mathison Turing/);
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
