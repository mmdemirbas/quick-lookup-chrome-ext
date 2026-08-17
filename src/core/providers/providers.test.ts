import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpClient, LookupRequest, ProviderContext } from '../types.ts';
import { freeDictionaryProvider, shortDialect } from './free-dictionary.ts';
import { wiktionaryProvider } from './wiktionary.ts';
import { datamuseProvider } from './datamuse.ts';
import {
  biasTerms,
  chooseCandidate,
  isAbout,
  moreSpecific,
  wikipediaProvider,
} from './wikipedia.ts';
import { linksFor } from './links.ts';
import { definitionText, stackExchangeProvider, tagCandidates } from './stackexchange.ts';
import { packageName, registryProvider } from './registry.ts';
import { mdnProvider, titleMatches } from './mdn.ts';
import { inContext } from './page.ts';

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

test('datamuse survives one of its requests failing', async () => {
  const http: HttpClient = {
    async json(url: string) {
      if (url.includes('rel_bgb=')) throw new Error('down');
      return [{ word: 'transitory', tags: ['syn'] }] as never;
    },
  };
  const result = await datamuseProvider.run(request, context(http));
  assert.equal(result?.slots.related?.length, 1);
});

test("the frequency shown is the selected word's own, or none", async () => {
  const http = stubHttp([
    ['ml=', []],
    ['rel_bgb=', []],
    ['sp=', [{ word: 'ephemeral', tags: ['adj', 'n', 'f:1.600203'] }]],
  ]);
  const result = await datamuseProvider.run(request, context(http));
  assert.deepEqual(result?.slots.frequency, {
    perMillion: 1.600203,
    band: 3,
    label: 'fairly common',
    source: 'datamuse',
  });
  // Worth its own request precisely because the other two cannot carry it:
  // `ml=` and `rel_bgb=` return *other* words, so their frequencies are
  // frequencies of the synonyms.
  assert.equal(result?.slots.related, undefined, 'and a frequency alone is still an answer');

  // `sp=` is a pattern search. A row for a near miss is a true frequency
  // about a different word, which is the kind of wrong that looks reasonable.
  const wrong = stubHttp([
    ['ml=', []],
    ['rel_bgb=', []],
    ['sp=', [{ word: 'ephemera', tags: ['f:0.4'] }]],
  ]);
  assert.equal(await datamuseProvider.run(request, context(wrong)), null);
});

test('a phrase is never asked about, because the corpus is indexed by word', async () => {
  const http = stubHttp([
    ['ml=', [{ word: 'isolation' }]],
    ['rel_bgb=', []],
  ]);
  const phrase: LookupRequest = { ...request, text: 'snapshot isolation' };
  const result = await datamuseProvider.run(phrase, context(http));
  assert.ok(result?.slots.related?.length);
  assert.ok(!http.calls.some((url) => url.includes('sp=')), 'no request was spent on it');
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
  // A title that resolved directly is certainly about the selection, and
  // composition prefers it over anything that had to be searched for.
  assert.equal(result?.slots.extract?.source, 'wikipedia');
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
  // Marked as searched-for, so a source that matched the term exactly owns
  // the paragraph instead of this one.
  assert.equal(result?.slots.extract?.source, 'wikipedia-search');
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

const FLOORING = {
  type: 'standard',
  title: 'Parquet',
  extract:
    'Parquet is a geometric mosaic of wood pieces used for decorative effect in flooring.',
};

const TABLE_PAGE = { topicTerms: ['iceberg', 'table', 'format', 'column'] };

test('an article that resolves is not always the article this page means', async () => {
  // The reported defect. `Parquet` has an article of its own — the flooring —
  // so on a page about table formats the fast path answered with it and the
  // biased search that knows about Apache Parquet was never reached. The
  // title resolving is what made it look like a hit.
  const http = stubHttp([
    ['page/summary', FLOORING],
    [
      'gsrsearch',
      searchPayload([
        {
          title: 'Apache Parquet',
          description: 'column-oriented data storage format',
          extract:
            'Apache Parquet is a free and open-source column-oriented data storage format in the Apache Hadoop ecosystem.',
        },
      ]),
    ],
  ]);

  const result = await wikipediaProvider.run(
    { ...request, text: 'Parquet', page: TABLE_PAGE },
    context(http),
  );

  assert.equal(result?.slots.entity?.title, 'Apache Parquet');
  // Searched for rather than resolved, so a source that matched the term
  // exactly still owns the paragraph over this one.
  assert.equal(result?.slots.extract?.source, 'wikipedia-search');
  assert.equal(http.calls.length, 2, 'the summary, then one biased search');
});

test('an article unrelated to the page is still the answer when nothing better names it', async () => {
  // The guard on the fix. Reading about table formats and looking up a
  // person: the direct hit has nothing in common with the page, and that is
  // not evidence it is wrong. A challenger that merely mentions the topic
  // must not take over an article Wikipedia resolved directly.
  const http = stubHttp([
    ['page/summary', TURING],
    [
      'gsrsearch',
      searchPayload([
        {
          title: 'Turing completeness',
          description: 'property of a computational system',
          extract:
            'Turing completeness is a property of a system of data-manipulation rules, such as a table of format rules.',
        },
      ]),
    ],
  ]);

  const result = await wikipediaProvider.run(
    { ...request, text: 'Alan Turing', page: TABLE_PAGE },
    context(http),
  );

  assert.equal(result?.slots.entity?.title, 'Alan Turing');
  assert.equal(result?.slots.extract?.source, 'wikipedia');
});

test('a challenger has to name the same thing, not merely mention it', () => {
  assert.ok(moreSpecific('Apache Parquet', 'Parquet'));
  assert.ok(moreSpecific('Second (unit)', 'second'));
  assert.ok(!moreSpecific('Turing completeness', 'Alan Turing'));
});

test('bias terms never repeat words from the selection itself', () => {
  const terms = biasTerms({ topicTerms: ['planner', 'database', 'query', 'table'] }, 'planner');
  assert.ok(!terms.includes('planner'));
  assert.deepEqual(terms, ['database', 'query', 'table']);
});

test('candidates are chosen by context, falling back to search rank', () => {
  // Both candidates are about a planner, which is what a real search for the
  // word returns. The topic is what decides which planner was meant.
  const candidates = [
    { title: 'Wedding planner', description: 'organises weddings', index: 0 },
    { title: 'Query planner', description: 'database query execution', index: 1 },
  ];
  assert.equal(
    chooseCandidate(candidates, ['database', 'query'], 'planner')?.candidate.title,
    'Query planner',
  );
  assert.equal(chooseCandidate(candidates, [], 'planner')?.candidate.title, 'Wedding planner');
  assert.equal(chooseCandidate([], ['x'], 'planner'), undefined);

  // A miss reports a zero score, which is how the caller detects that a
  // topic-biased search returned something unrelated to the page.
  const miss = chooseCandidate(candidates, ['zzzz'], 'planner');
  assert.equal(miss?.candidate.title, 'Wedding planner');
  assert.equal(miss?.score, 0);
});

test('a candidate that is only about the page is not an answer about the selection', () => {
  // The reported case: selecting "Schema" on iceberg.apache.org returned the
  // Apache Iceberg article, because the biased search asks for the selection
  // and the page topic together, and the page's own subject matches every
  // selection made on it. Topic overlap alone cannot tell the difference.
  const candidates = [
    {
      title: 'Apache Iceberg',
      description: 'open table format',
      extract:
        'Apache Iceberg is an open table format for very large analytic datasets. ' +
        'It supports schema evolution, hidden partitioning and time travel.',
      index: 0,
    },
  ];
  const topic = ['iceberg', 'table', 'format'];

  assert.equal(chooseCandidate(candidates, topic, 'schema'), undefined);
  assert.equal(
    chooseCandidate(candidates, topic, 'Apache Iceberg')?.candidate.title,
    'Apache Iceberg',
    'the article is still returned when it is what was selected',
  );
});

test('an article is about what it names, not about everything it mentions', () => {
  const iceberg = {
    title: 'Apache Iceberg',
    extract: 'Apache Iceberg is an open table format. Manifests list the data files.',
  };
  assert.ok(isAbout(iceberg, 'iceberg'), 'named in the title');
  assert.ok(isAbout(iceberg, 'Apache Iceberg table format'), 'the selection may be wider');
  assert.ok(!isAbout(iceberg, 'manifest'), 'mentioned in a later sentence is not about');
  assert.ok(!isAbout(iceberg, 'table'), 'a word after the verb describes, it does not name');

  const manifest = {
    title: 'Manifest file',
    extract: 'A manifest is a metadata file listing the data files of a snapshot.',
  };
  assert.ok(isAbout(manifest, 'manifests'), 'a plural selection matches the singular article');
  assert.ok(
    isAbout({ extract: 'A snapshot is the state of a table at a point in time.' }, 'snapshot'),
    'the lead sentence names the subject when there is no title match',
  );
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
        {
          title: 'Query planner',
          description: 'database query planning',
          extract: 'A query planner is the component that chooses an execution plan.',
        },
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
  assert.equal(result?.slots.entity?.title, 'Query planner');
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

/**
 * Excerpts as the API actually returned them, including the HTML entity and
 * the moderation notice that motivated the guidance filter.
 */
const SE_ICEBERG =
  'Apache Iceberg is a high-performance table format to enable analytics purposes. It allows engines to safely work with the same tables, at the same time.';
const SE_KUBERNETES =
  'KUBERNETES QUESTIONS MUST BE SPECIFICALLY RELATED TO SOFTWARE DEVELOPMENT. Configuration, deployment, and administration are off-topic here. If it&#39;s about programming issues within a pod, only use this tag if the environment is relevant.';

test('tag candidates cover the spellings a term might have, best first', () => {
  assert.deepEqual(tagCandidates('Apache Iceberg'), ['apache-iceberg', 'apacheiceberg']);
  // A single word has only one spelling; asking twice would waste the quota.
  assert.deepEqual(tagCandidates('Kubernetes'), ['kubernetes']);
  assert.deepEqual(tagCandidates('Node.js'), ['node.js']);
  assert.deepEqual(tagCandidates(''), []);
  // Anything a tag cannot contain, or that is too long to be one, is dropped
  // rather than sent and rejected.
  assert.deepEqual(tagCandidates('a selected sentence is never a tag, however technical'), []);
  assert.deepEqual(tagCandidates('naïve'), []);
});

test('advice to askers is separated from the definition, sentence by sentence', () => {
  assert.equal(definitionText(SE_ICEBERG), SE_ICEBERG);

  // Defines the term, then adds a note about the tag. Keep the first, drop
  // the second — this is the common shape.
  assert.equal(
    definitionText(
      'A manifest is a file containing metadata about an application, data file or assembly. Generally an ambiguous tag, try and use a more specific one.',
    ),
    'A manifest is a file containing metadata about an application, data file or assembly.',
  );

  // Opens with advice, so what follows continues it rather than defining
  // anything. The kubernetes wiki never says what Kubernetes is.
  assert.equal(definitionText(SE_KUBERNETES), undefined);
  assert.equal(definitionText('Use it.'), undefined, 'too short to be a definition');
});

test('stack exchange prefers the hyphenated tag and fills gloss, extract and a link', async () => {
  const http = stubHttp([
    [
      'api.stackexchange.com',
      { items: [{ tag_name: 'apacheiceberg', excerpt: 'A wrong one.' }, { tag_name: 'apache-iceberg', excerpt: SE_ICEBERG }] },
    ],
  ]);

  const result = await stackExchangeProvider.run(
    { ...request, text: 'Apache Iceberg' },
    context(http),
  );
  assert.ok(result);
  // Both spellings travel in one request rather than costing two.
  assert.equal(http.calls.length, 1);
  assert.match(http.calls[0] ?? '', /tags\/apache-iceberg;apacheiceberg\/wikis/);

  assert.equal(
    result.slots.gloss,
    'Apache Iceberg is a high-performance table format to enable analytics purposes.',
  );
  assert.match(result.slots.extract?.text ?? '', /same tables, at the same time\./);
  assert.equal(result.slots.links?.[0]?.url, 'https://stackoverflow.com/questions/tagged/apache-iceberg');
});

test('stack exchange drops a moderation notice instead of showing it as a definition', async () => {
  const http = stubHttp([
    ['api.stackexchange.com', { items: [{ tag_name: 'kubernetes', excerpt: SE_KUBERNETES }] }],
  ]);
  assert.equal(
    await stackExchangeProvider.run({ ...request, text: 'Kubernetes' }, context(http)),
    null,
  );
});

test('stack exchange returns nothing when no candidate spelling is a tag', async () => {
  const http = stubHttp([['api.stackexchange.com', { items: [] }]]);
  assert.equal(
    await stackExchangeProvider.run({ ...request, text: 'planner' }, context(http)),
    null,
  );
});

test('dictionary head-words are collected per sense, and only when asked for', async () => {
  const payload = {
    word: 'ephemeral',
    entries: [
      {
        language: { code: 'en' },
        partOfSpeech: 'adjective',
        senses: [
          {
            definition: 'Lasting for a short period of time.',
            translations: [
              { language: { code: 'tr' }, word: 'geçici' },
              { language: { code: 'hy' }, word: 'վաղանցիկ' },
              { language: { code: 'tr' }, word: 'gelip geçici' },
            ],
          },
          {
            definition: 'Existing for only one day.',
            translations: [{ language: { code: 'tr' }, word: 'geçici' }],
          },
        ],
      },
    ],
  };

  const asked = stubHttp([['freedictionaryapi.com', payload]]);
  const result = await freeDictionaryProvider.run(
    { ...request, glossLanguage: 'tr' },
    context(asked),
  );
  assert.match(asked.calls[0] ?? '', /\?translations=true$/);
  assert.deepEqual(
    result?.slots.translation?.equivalents?.map((e) => e.word),
    ['geçici', 'gelip geçici'],
    'other languages are ignored and a repeat across senses collapses',
  );
  // Something readable even when no translator exists on the machine.
  assert.equal(result?.slots.translation?.text, 'geçici, gelip geçici');

  // Translations roughly triple the payload, so an unasked-for one is not
  // paid for at all.
  const unasked = stubHttp([['freedictionaryapi.com', payload]]);
  const plain = await freeDictionaryProvider.run(request, context(unasked));
  assert.doesNotMatch(unasked.calls[0] ?? '', /translations/);
  assert.equal(plain?.slots.translation, undefined);
});

const NPM_PAGE = {
  host: 'blog.example.com',
  title: 'Bundling a React app',
  topicTerms: ['javascript', 'react', 'npm', 'bundler'],
};

test('a selection that could not be a package name is not one', () => {
  assert.equal(packageName('react-dom'), 'react-dom');
  assert.equal(packageName('@types/node'), '@types/node');
  assert.equal(packageName('Lodash'), 'lodash');
  assert.equal(packageName('two words'), undefined);
  assert.equal(packageName('a'), undefined);
  assert.equal(packageName('naïve'), undefined);
});

test('the registry asked follows the page, and its facts reach the card', async () => {
  const http = stubHttp([
    [
      'registry.npmjs.org',
      {
        name: 'react-dom',
        version: '19.2.8',
        description: 'React package for working with the DOM.',
        license: 'MIT',
        homepage: 'https://react.dev/',
      },
    ],
  ]);

  const result = await registryProvider.run(
    { ...request, text: 'react-dom', page: NPM_PAGE },
    context(http),
  );
  assert.ok(result);
  assert.match(http.calls[0] ?? '', /^https:\/\/registry\.npmjs\.org\/react-dom\/latest$/);
  assert.deepEqual(result.slots.facts, [
    { label: 'Version', value: '19.2.8', source: 'npm' },
    { label: 'License', value: 'MIT', source: 'npm' },
  ]);
  assert.equal(result.slots.extract?.text, 'React package for working with the DOM.');
  assert.deepEqual(
    result.slots.links?.map((l) => l.url),
    ['https://www.npmjs.com/package/react-dom', 'https://react.dev/'],
  );
});

test('no ecosystem signal means no registry is asked at all', async () => {
  const http = stubHttp([['registry.npmjs.org', { name: 'iceberg', version: '1.0.1' }]]);
  const result = await registryProvider.run(
    {
      ...request,
      text: 'iceberg',
      page: { host: 'iceberg.apache.org', title: 'Apache Iceberg table specification' },
    },
    context(http),
  );
  // The npm package "iceberg" exists and is unrelated. Not asking is the
  // only thing that keeps it off a card about the table format.
  assert.equal(result, null);
  assert.equal(http.calls.length, 0);
});

test('a fuzzy crates.io match is rejected rather than shown as a hit', async () => {
  const http = stubHttp([
    [
      'crates.io',
      { crates: [{ name: 'serde_json', max_stable_version: '1.0.0', description: 'JSON' }] },
    ],
  ]);
  const page = { host: 'docs.rs', title: 'serde' };
  assert.equal(
    await registryProvider.run({ ...request, text: 'serde', page }, context(http)),
    null,
  );
});

test('a registry that is down leaves the slot empty rather than failing the card', async () => {
  const http: HttpClient = {
    async json() {
      throw new Error('HTTP 404');
    },
  };
  assert.equal(
    await registryProvider.run({ ...request, text: 'nosuchpackage', page: NPM_PAGE }, context(http)),
    null,
  );
});

const WEB_PAGE = { host: 'developer.mozilla.org', title: 'CSS layout' };

test('an MDN title is a match when it contains the selection, not only when equal', () => {
  // Titles carry their context, so equality would reject most real hits.
  assert.ok(titleMatches('fetch', 'Window: fetch() method'));
  assert.ok(titleMatches('flexbox', 'Flexbox'));
  assert.ok(titleMatches('grid template areas', 'CSS grid-template-areas property'));
  assert.ok(!titleMatches('planner', 'Using CSS transitions'));
  assert.ok(!titleMatches('', 'Anything'));
});

test('mdn discards a loosely related document rather than presenting it as the answer', async () => {
  const http = stubHttp([
    [
      'developer.mozilla.org',
      {
        documents: [
          { title: 'Using CSS transitions', summary: 'Transitions…', mdn_url: '/en-US/docs/a' },
          { title: 'Window: fetch() method', summary: 'Starts a request.', mdn_url: '/en-US/docs/b' },
        ],
      },
    ],
  ]);

  const result = await mdnProvider.run({ ...request, text: 'fetch', page: WEB_PAGE }, context(http));
  assert.ok(result);
  assert.equal(result.slots.extract?.url, 'https://developer.mozilla.org/en-US/docs/b');
});

test('mdn is not asked outside the web and npm ecosystems', async () => {
  const http = stubHttp([['developer.mozilla.org', { documents: [] }]]);
  const page = { host: 'docs.python.org', title: 'The Python tutorial' };
  assert.equal(await mdnProvider.run({ ...request, text: 'range', page }, context(http)), null);
  assert.equal(http.calls.length, 0);
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

test('accent names are shortened to what a dictionary prints', () => {
  // Wiktionary spells them out, and three spelled-out accents beside their
  // transcriptions is two wrapped lines above the definition.
  assert.equal(shortDialect('Received Pronunciation'), 'RP');
  assert.equal(shortDialect('General American'), 'US');
  assert.equal(shortDialect('UK'), 'UK');
  // Short and unrecognised is passed through: it is probably a real accent.
  assert.equal(shortDialect('Scotland'), 'Scotland');
  // Long and unrecognised is more likely a usage note than an accent.
  assert.equal(shortDialect('chiefly in the north of England'), undefined);
  assert.equal(shortDialect(undefined), undefined);
  assert.equal(shortDialect('  '), undefined);
});

test('the sentence a word was met in is split around the word', () => {
  const split = inContext(
    'A manifest is a metadata file that lists the data files making up a snapshot.',
    'manifest',
  );
  assert.deepEqual(split, {
    before: 'A ',
    term: 'manifest',
    after: ' is a metadata file that lists the data files making up a snapshot.',
  });
});

test('an inflected form on the page still marks the word inside it', () => {
  // The reader selected `partition`; the page says `Partitions`. Marking the
  // stem inside it is right, and case never decides anything — readers select
  // the word as the page capitalised it.
  assert.deepEqual(inContext('Partitions were rewritten overnight.', 'partition'), {
    before: '',
    term: 'Partition',
    after: 's were rewritten overnight.',
  });
  assert.equal(inContext('Manifest files are small.', 'manifest')?.term, 'Manifest');
});

test('a sentence that cannot show the word at all is still worth keeping', () => {
  // A base form the page never spells out — reached by the pack's form
  // guessing, or by hover. The sentence is still where the reader met it.
  const split = inContext('He ran the query overnight.', 'run');
  assert.deepEqual(split, { before: 'He ran the query overnight.', term: '', after: '' });
});

test('a paragraph is not a sentence, and a word is not a context', () => {
  // Past the cap it is a paragraph with no full stop in it, and repeating a
  // paragraph the reader is looking at is noise.
  assert.equal(inContext('word '.repeat(60), 'word'), undefined);
  // A "sentence" that is only the word says nothing the card title does not.
  assert.equal(inContext('manifest', 'manifest'), undefined);
  assert.equal(inContext('   ', 'manifest'), undefined);
  assert.equal(inContext('A manifest file.', '  '), undefined);
});
