import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickExamples, showsWord, tatoebaProvider } from './tatoeba.ts';
import type { HttpClient, LookupRequest, ProviderContext } from '../types.ts';

/**
 * Sentences as Tatoeba returned them on 2026-08-16, including the one that
 * makes the length cap necessary: it carries Article 18 of the Universal
 * Declaration of Human Rights, which is a paragraph, not an example.
 */
const MANIFEST = [
  {
    text: 'What will happen in the eternal future that seems to have no purpose, but clearly just manifested by fate?',
    translations: [[{ lang: 'tur', text: 'Hiçbir amacı yokmuş gibi görünen bir gelecekte neler olacak?' }], []],
  },
  {
    text: 'Everyone has the right to freedom of thought, conscience and religion; this right includes freedom to change his religion or belief, and freedom, either alone or in community with others and in public or private, to manifest his religion or belief in teaching, practice, worship and observance.',
    translations: [[{ lang: 'tur', text: 'Herkesin fikir, vicdan ve din hürriyeti hakkı vardır.' }], []],
  },
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

const context = (http: HttpClient, uiLang = 'en'): ProviderContext => ({
  http,
  signal: new AbortController().signal,
  uiLang,
});

const request = (text: string, glossLanguage?: string): LookupRequest => ({
  id: 'r',
  text,
  uiLang: 'en',
  page: {},
  ...(glossLanguage ? { glossLanguage } : {}),
});

test('a paragraph is not an example, however well it uses the word', () => {
  const picked = pickExamples(MANIFEST, 'manifest', 'tur');
  assert.equal(picked.length, 1);
  assert.match(picked[0]?.text ?? '', /^What will happen/);
  assert.equal(picked[0]?.translation, 'Hiçbir amacı yokmuş gibi görünen bir gelecekte neler olacak?');
});

test('the shortest sentences win, because an example is read at a glance', () => {
  const picked = pickExamples(
    [
      { text: 'The partition of the estate took several years and a great deal of argument.' },
      { text: 'The disk has one partition.' },
      { text: 'Brazil is partitioned into states.' },
    ],
    'partition',
    undefined,
  );
  assert.deepEqual(picked.map((e) => e.text), [
    'The disk has one partition.',
    'Brazil is partitioned into states.',
    'The partition of the estate took several years and a great deal of argument.',
  ]);
  assert.equal(picked[0]?.translation, undefined, 'and no translation is invented');
});

test('a sentence that does not show the word is not an example of it', () => {
  // The search matches on a stem, which is wanted for inflections and not
  // wanted for whatever else the engine decided was related.
  assert.ok(showsWord('Brazil is partitioned into states.', 'partition'));
  assert.ok(showsWord('Love is ephemeral.', 'ephemeral'));
  assert.ok(!showsWord('The disk was formatted yesterday.', 'partition'));

  const picked = pickExamples(
    [{ text: 'The disk was formatted yesterday.' }, { text: 'One partition failed.' }],
    'partition',
    undefined,
  );
  assert.deepEqual(picked.map((e) => e.text), ['One partition failed.']);
});

test('a sentence the community flagged as wrong is not shown', () => {
  const picked = pickExamples(
    [
      { text: 'A partition is wall.', correctness: -1 },
      { text: 'A partition is a wall.', correctness: 0 },
    ],
    'partition',
    undefined,
  );
  assert.deepEqual(picked.map((e) => e.text), ['A partition is a wall.']);
});

test('an indirect translation still counts, and a missing one is simply absent', () => {
  // Tatoeba splits direct translations from those routed through a third
  // language. Both are human translations; the card names the source either way.
  const indirect = pickExamples(
    [{ text: 'Love is ephemeral.', translations: [[], [{ lang: 'tur', text: 'Aşk geçicidir.' }]] }],
    'ephemeral',
    'tur',
  );
  assert.equal(indirect[0]?.translation, 'Aşk geçicidir.');

  const other = pickExamples(
    [{ text: 'Love is ephemeral.', translations: [[{ lang: 'deu', text: 'Liebe ist flüchtig.' }]] }],
    'ephemeral',
    'tur',
  );
  assert.equal(other[0]?.translation, undefined);
});

test('the request names both languages in the form the service uses', async () => {
  const http = stub({ results: [{ text: 'Love is ephemeral.' }] });
  await tatoebaProvider.run(request('ephemeral', 'tr'), context(http));
  // Settings and browsers say `en` and `tr`; this service says `eng` and
  // `tur`, and a wrong code returns a confident answer about another language.
  assert.match(http.calls[0] ?? '', /from=eng/);
  assert.match(http.calls[0] ?? '', /to=tur/);

  // Without a gloss language the sentences still come, untranslated.
  const noGloss = stub({ results: [{ text: 'Love is ephemeral.' }] });
  await tatoebaProvider.run(request('ephemeral'), context(noGloss));
  assert.doesNotMatch(noGloss.calls[0] ?? '', /[&?]to=/);
});

test('a language the service does not name is not asked about at all', async () => {
  const http = stub({ results: [] });
  assert.equal(await tatoebaProvider.run(request('word'), context(http, 'xx')), null);
  assert.equal(http.calls.length, 0);
});

test('no usable sentence removes the section rather than showing an apology', async () => {
  const http = stub({ results: [] });
  assert.equal(await tatoebaProvider.run(request('idempotent', 'tr'), context(http)), null);
});
