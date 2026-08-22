import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstKnownForm, packProvider } from './pack.ts';
import { parseEntryText, type PackHit, type PackLookup, type PackMeta } from '../packs.ts';
import type { LookupRequest, ProviderContext } from '../types.ts';

const meta = (over: Partial<PackMeta>): PackMeta => ({
  id: 'eng-tur',
  name: 'English-Turkish FreeDict',
  source: 'en',
  target: 'tr',
  format: 'dictd',
  entries: 36589,
  installedAt: 0,
  ...over,
});

/** A pack index over a plain object, recording what was asked for. */
const packsOf = (
  entries: Record<string, Array<{ pack: PackMeta; text: string }>>,
): PackLookup & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    refresh() {},
    async signature() {
      return Object.keys(entries).join(',');
    },
    async entries(headword: string): Promise<PackHit[]> {
      asked.push(headword);
      return (entries[headword] ?? []).map(({ pack, text }) => ({
        pack,
        entry: parseEntryText(headword, text),
      }));
    },
  };
};

const request = (text: string, glossLanguage?: string): LookupRequest => ({
  id: 'r',
  text,
  uiLang: 'en',
  page: {},
  ...(glossLanguage ? { glossLanguage } : {}),
});

const context = (packs?: PackLookup): ProviderContext => ({
  http: { async json() { throw new Error('a pack must never reach the network'); } },
  signal: new AbortController().signal,
  uiLang: 'en',
  ...(packs ? { packs } : {}),
});

test('with no packs installed the provider is not a source at all', async () => {
  assert.equal(await packProvider.run(request('partition', 'tr'), context()), null);
});

test('the selected form is answered before any guess at its base form', async () => {
  const packs = packsOf({
    caught: [{ pack: meta({}), text: 'caught /kˈɔːt/\n1. (bak.) catch.' }],
    catch: [{ pack: meta({}), text: 'catch /kætʃ/\n1. yakalamak.' }],
  });
  const result = await packProvider.run(request('caught', 'tr'), context(packs));
  assert.equal(result?.slots.translation?.text, '(bak.) catch');
  assert.deepEqual(packs.asked, ['caught'], 'and the base form is never asked for');
});

test('a word only present in its base form is still found', async () => {
  const packs = packsOf({ partition: [{ pack: meta({}), text: 'partition\n1. bölme, bölüm.' }] });
  const result = await packProvider.run(request('partitions', 'tr'), context(packs));
  assert.equal(result?.slots.translation?.text, 'bölme, bölüm');
  assert.deepEqual(packs.asked, ['partitions', 'partition']);
});

test('meanings keep their grouping, and their words become chips', async () => {
  const packs = packsOf({
    bank: [{ pack: meta({}), text: 'bank /bæŋk/\n1. banka.\n2. kıyı, sahil.\n3. yığın.' }],
  });
  const result = await packProvider.run(request('bank', 'tr'), context(packs));
  // Semicolons between meanings and commas inside one is how a printed
  // dictionary separates "bank, riverbank" from "bank; riverbank".
  assert.equal(result?.slots.translation?.text, 'banka; kıyı, sahil; yığın');
  assert.deepEqual(
    result?.slots.translation?.equivalents?.map((e) => e.word),
    ['banka', 'kıyı', 'sahil', 'yığın'],
  );
  assert.deepEqual(result?.slots.pronunciation, [{ ipa: 'bæŋk' }]);
  assert.equal(result?.slots.senses, undefined, 'Turkish must not land in the English senses list');
});

test('a pack answering in another language than the one asked for stays quiet', async () => {
  const packs = packsOf({
    partition: [
      { pack: meta({ id: 'eng-deu', name: 'English-German', target: 'de' }), text: 'partition\n1. Trennwand.' },
      { pack: meta({}), text: 'partition\n1. bölme.' },
    ],
  });
  const result = await packProvider.run(request('partition', 'tr'), context(packs));
  // Both packs know the word. Taking both would put a German line and Turkish
  // chips on one card, each correct and together nonsense.
  assert.equal(result?.slots.translation?.text, 'bölme');
  assert.equal(result?.slots.translation?.lang, 'tr');
});

test('a pack whose source is not the language being read is not consulted', async () => {
  const packs = packsOf({
    bank: [{ pack: meta({ id: 'tur-eng', name: 'Turkish-English', source: 'tr', target: 'en' }), text: 'bank\n1. bench.' }],
  });
  assert.equal(await packProvider.run(request('bank', 'en'), context(packs)), null);
});

test('a monolingual pack writes definitions, not a translation', async () => {
  const packs = packsOf({
    snapshot: [
      {
        pack: meta({ id: 'iceberg', name: 'Iceberg glossary', source: 'en', target: 'en' }),
        text: 'snapshot\n1. The state of a table at some time.\n2. A manifest list plus its manifests.',
      },
    ],
  });
  const result = await packProvider.run(request('snapshot', 'tr'), context(packs));
  assert.equal(result?.slots.translation, undefined);
  assert.deepEqual(result?.slots.senses?.map((s) => s.definition), [
    'The state of a table at some time.',
    'A manifest list plus its manifests.',
  ]);
  assert.equal(result?.slots.senses?.[0]?.source, 'Iceberg glossary');
  // A pack is a file on this device. There is no page to send a reader to,
  // and the card must not invent one — an empty link would be worse than
  // none, and the licence link the online dictionaries owe does not apply.
  assert.equal(result?.slots.senses?.[0]?.url, undefined);
});

test('a long entry is capped rather than turning the card into a wall', async () => {
  // FreeDict's real `partition` has seven numbered meanings and runs to about
  // 190 characters, which is dense but still one glanceable line. Both caps
  // sit above that, so each needs its own case to fire.
  const short = Array.from({ length: 14 }, (_, i) => `${i + 1}. kısa anlam ${i}.`);
  const capped = await packProvider.run(
    request('x', 'tr'),
    context(packsOf({ x: [{ pack: meta({}), text: `x\n${short.join('\n')}` }] })),
  );
  assert.equal(capped?.slots.translation?.text.split('; ').length, 8, 'meanings are capped');

  const long = Array.from({ length: 8 }, (_, i) => `${i + 1}. ${'uzun anlam '.repeat(10)}${i}.`);
  const cut = await packProvider.run(
    request('y', 'tr'),
    context(packsOf({ y: [{ pack: meta({}), text: `y\n${long.join('\n')}` }] })),
  );
  assert.ok((cut?.slots.translation?.text.length ?? 0) <= 300);
  assert.ok(cut?.slots.translation?.text.endsWith('…'), 'and it says it was cut');
});

test('a word no pack knows costs one read per form and then gives up', async () => {
  const packs = packsOf({});
  assert.deepEqual(await firstKnownForm(packs, 'queries'), []);
  // Four local reads, in the order the guesses are worth making. `queri` is
  // not a word; a guess that finds nothing costs the same as not guessing.
  assert.deepEqual(packs.asked, ['queries', 'query', 'queri', 'querie']);
});
