import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateForms,
  decodeDictdNumber,
  languagePairFromName,
  parseDictdIndex,
  parseEntryText,
  parseStarDictIdx,
  parseStarDictIfo,
  parseTsv,
  splitEquivalents,
} from './packs.ts';

/**
 * Lines copied out of FreeDict's English-Turkish 0.3 `.index`, unchanged.
 *
 * The metadata rows are at the top of every dictd file in existence, so a
 * fixture without them would not be the format.
 */
const FREEDICT_INDEX = [
  '00databasealphabet\tSacV\ts',
  '00databasedictfmt1121\tB\tb',
  '00databaseinfo\tc\tgt',
  '00databaseshort\thJ\tt',
  'caught\tCVHA\tj',
  'moreover\tGnAG\tBB',
].join('\n');

test('a dictd offset is a base-64 number, not base-64 data', () => {
  // Decoding CVHA with atob gives four bytes of plausible nonsense, which
  // points somewhere inside another entry and prints a garbled definition
  // rather than raising anything.
  assert.equal(decodeDictdNumber('CVHA'), 610752);
  assert.equal(decodeDictdNumber('j'), 35);
  assert.equal(decodeDictdNumber('B'), 1);
  assert.ok(Number.isNaN(decodeDictdNumber('')));
  assert.ok(Number.isNaN(decodeDictdNumber('has spaces')));
});

test('the dictionary\'s own metadata rows are not words to look up', () => {
  const records = parseDictdIndex(FREEDICT_INDEX);
  assert.deepEqual(
    records.map((r) => r.headword),
    ['caught', 'moreover'],
  );
  // Length 35 is exactly the entry measured in the real file: the head line
  // with its IPA, a newline, and one numbered meaning.
  assert.deepEqual(records[0], { headword: 'caught', offset: 610752, length: 35 });
});

test('a truncated or malformed index line is skipped, not guessed at', () => {
  const records = parseDictdIndex(
    ['good\tB\tb', 'nooffset', 'bad\t???\tb', 'empty\tB\tA', '', 'also good\tC\tb'].join('\n'),
  );
  // A zero length would address an empty slice and render as a blank card.
  assert.deepEqual(records.map((r) => r.headword), ['good', 'also good']);
});

test('a StarDict index is head-word bytes, a zero, then two big-endian numbers', () => {
  const build = (entries: Array<[string, number, number]>): Uint8Array => {
    const parts: number[] = [];
    for (const [word, offset, length] of entries) {
      parts.push(...new TextEncoder().encode(word), 0);
      const numbers = new DataView(new ArrayBuffer(8));
      numbers.setUint32(0, offset, false);
      numbers.setUint32(4, length, false);
      parts.push(...new Uint8Array(numbers.buffer));
    }
    return new Uint8Array(parts);
  };

  const records = parseStarDictIdx(build([['bölme', 0, 42], ['snapshot', 42, 7]]));
  assert.deepEqual(records, [
    // A multi-byte head-word must not be measured in characters: the zero
    // terminator is found by byte, and the word decoded as UTF-8.
    { headword: 'bölme', offset: 0, length: 42 },
    { headword: 'snapshot', offset: 42, length: 7 },
  ]);
});

test('a StarDict index cut off mid-record stops rather than reading past the end', () => {
  const complete = new Uint8Array([...new TextEncoder().encode('word'), 0, 0, 0, 0, 5, 0, 0, 0, 9]);
  assert.equal(parseStarDictIdx(complete).length, 1);
  // Every prefix of a valid file is a file that a download can produce.
  for (let cut = 1; cut < complete.length; cut++) {
    assert.equal(parseStarDictIdx(complete.subarray(0, cut)).length, 0, `cut at ${cut}`);
  }
});

test('the ifo file says how wide the offsets are, and it is believed', () => {
  const ifo = parseStarDictIfo(
    ["StarDict's dict ifo file", 'version=3.0.0', 'bookname=English-Turkish', 'wordcount=36589', 'idxoffsetbits=64'].join('\n'),
  );
  assert.equal(ifo.bookname, 'English-Turkish');
  assert.equal(ifo.idxoffsetbits, '64');

  const bytes = new Uint8Array([...new TextEncoder().encode('a'), 0, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 3]);
  // Reading a 64-bit file as 32-bit resolves every entry to the wrong place,
  // so this is not a case where the common setting is a safe default.
  assert.deepEqual(parseStarDictIdx(bytes, 64), [{ headword: 'a', offset: 7, length: 3 }]);
  assert.notDeepEqual(parseStarDictIdx(bytes, 32), [{ headword: 'a', offset: 7, length: 3 }]);
});

test('a tab-separated pack carries byte offsets, not character offsets', () => {
  const { records, blob } = parseTsv(
    ['# a comment', 'bölme\tpartition', 'snapshot\tanlık görüntü', 'malformed line', ''].join('\n'),
  );
  assert.deepEqual(records.map((r) => r.headword), ['bölme', 'snapshot']);
  assert.equal(records[0]?.offset, 0);
  assert.equal(records[0]?.length, 9);
  // "anlık görüntü" is 13 characters and 17 bytes. Using the character count
  // would truncate every definition after the first non-ASCII one.
  assert.equal(records[1]?.offset, 9);
  assert.equal(records[1]?.length, 17);
  assert.equal(new TextEncoder().encode(blob).length, 26);
});

test('an entry is split into its head line and its numbered meanings', () => {
  // Exactly as it comes out of FreeDict's English-Turkish 0.3.
  const entry = parseEntryText('moreover', 'moreover /mɔːɹˈəʊvə/\n1. bundan başka, bundan fazla, üstelik.');
  assert.equal(entry.ipa, 'mɔːɹˈəʊvə');
  assert.deepEqual(entry.senses, ['bundan başka, bundan fazla, üstelik.']);

  const many = parseEntryText('bank', 'bank /bæŋk/\n1. banka.\n2. kıyı, sahil.\n3. yığın.');
  assert.deepEqual(many.senses, ['banka.', 'kıyı, sahil.', 'yığın.']);
});

test('two entries merged under one head-word do not print the word as a meaning', () => {
  // One spelling with a noun entry and a verb entry is stored as a single
  // record, so a second head line lands in the middle of the text. Left in,
  // it renders as a meaning whose entire content is the word itself.
  const merged = parseEntryText(
    'bank',
    'bank /bæŋk/\n1. banka.\nbank /bæŋk/\n1. yatırmak, güvenmek.',
  );
  assert.equal(merged.ipa, 'bæŋk');
  assert.deepEqual(merged.senses, ['banka.', 'yatırmak, güvenmek.']);

  // A definition that happens to open with the word is a definition.
  const opens = parseEntryText('bank', 'bank is where money is kept');
  assert.deepEqual(opens.senses, ['bank is where money is kept']);
});

test('a pack that follows neither convention still answers', () => {
  // No head line, no numbering: the whole block is one meaning, which is
  // what the reader would have seen in the source dictionary anyway.
  const plain = parseEntryText('snapshot', 'A read-consistent view of a table at a point in time.');
  assert.equal(plain.ipa, undefined);
  assert.deepEqual(plain.senses, ['A read-consistent view of a table at a point in time.']);

  // A wrapped line continues the meaning above it rather than opening a new one.
  const wrapped = parseEntryText('manifest', 'manifest\n1. a metadata file listing\nthe data files in a snapshot');
  assert.deepEqual(wrapped.senses, ['a metadata file listing the data files in a snapshot']);
});

test('a bilingual meaning is several equivalents, unless it is prose', () => {
  assert.deepEqual(splitEquivalents('bundan başka, bundan fazla, üstelik.'), [
    'bundan başka',
    'bundan fazla',
    'üstelik',
  ]);
  // Splitting a sentence on its commas produces fragments, so length decides.
  const prose = 'Bir tablonun belirli bir andaki tutarlı görünümü, yani o an var olan veri dosyalarının listesi.';
  assert.deepEqual(splitEquivalents(prose), [prose]);
  assert.deepEqual(splitEquivalents('   '), []);
});

test('the form on the page is looked up before the form in the dictionary', () => {
  // Readers select what is written, and dictionaries index base forms.
  assert.ok(candidateForms('partitions').includes('partition'));
  assert.ok(candidateForms('queries').includes('query'));
  assert.ok(candidateForms('running').includes('run'));
  assert.ok(candidateForms('stopped').includes('stop'));
  assert.ok(candidateForms('merged').includes('merge'));
  // The selected form always comes first: when it is itself a head-word, a
  // guess must never displace it.
  assert.equal(candidateForms('Caught')[0], 'caught');
  assert.deepEqual(candidateForms(''), []);
  // `class` is not a plural. Stripping the s would answer with `clas`.
  assert.ok(!candidateForms('class').includes('clas'));
});

test('a file name suggests the language pair, and is only ever a suggestion', () => {
  assert.deepEqual(languagePairFromName('freedict-eng-tur-0.3.index'), { source: 'en', target: 'tr' });
  assert.deepEqual(languagePairFromName('deu-tur.dict.dz'), { source: 'de', target: 'tr' });
  assert.deepEqual(languagePairFromName('en-tr.tsv'), { source: 'en', target: 'tr' });
  assert.equal(languagePairFromName('my-favourite-words.tsv'), undefined);
});
