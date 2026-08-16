import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compoundAt, resizeSpan, sliceSpan, wordAt, wordCount, words } from './span.ts';

const TEXT = 'The query planner chooses an execution plan.';

test('word segmentation ignores punctuation and whitespace', () => {
  assert.deepEqual(
    words(TEXT).map((s) => sliceSpan(TEXT, s)),
    ['The', 'query', 'planner', 'chooses', 'an', 'execution', 'plan'],
  );
});

test('the word at an offset is found from anywhere inside it', () => {
  const at = (offset: number) => {
    const span = wordAt(TEXT, offset);
    return span ? sliceSpan(TEXT, span) : undefined;
  };
  assert.equal(at(TEXT.indexOf('planner')), 'planner');
  assert.equal(at(TEXT.indexOf('planner') + 3), 'planner');
  // The boundary just past the last letter still belongs to the word: that
  // is where the caret sits when pointing at the end of it.
  assert.equal(at(TEXT.indexOf('planner') + 'planner'.length), 'planner');
});

test('an offset in whitespace belongs to no word', () => {
  const spaceAfterThe = 3;
  assert.equal(wordAt('The  query', spaceAfterThe + 1), undefined);
});

test('a span grows to the right one word at a time', () => {
  let span = wordAt(TEXT, TEXT.indexOf('query'))!;
  assert.equal(sliceSpan(TEXT, span), 'query');

  span = resizeSpan(TEXT, span, 1, 0);
  assert.equal(sliceSpan(TEXT, span), 'query planner');

  span = resizeSpan(TEXT, span, 1, 0);
  assert.equal(sliceSpan(TEXT, span), 'query planner chooses');
});

test('a span grows to the left and shrinks back', () => {
  const base = wordAt(TEXT, TEXT.indexOf('planner'))!;
  const wider = resizeSpan(TEXT, base, 0, 1);
  assert.equal(sliceSpan(TEXT, wider), 'query planner');

  const widest = resizeSpan(TEXT, wider, 0, 1);
  assert.equal(sliceSpan(TEXT, widest), 'The query planner');

  const narrowed = resizeSpan(TEXT, widest, -1, 0);
  assert.equal(sliceSpan(TEXT, narrowed), 'The query');
});

test('a span never collapses to nothing or runs off the end', () => {
  const base = wordAt(TEXT, TEXT.indexOf('planner'))!;
  // Shrinking far past zero leaves one word rather than an empty span.
  const shrunk = resizeSpan(TEXT, base, -99, -99);
  assert.ok(sliceSpan(TEXT, shrunk).length > 0);

  // Growing far past the end stops at the last word rather than throwing.
  const grown = resizeSpan(TEXT, base, 99, 99);
  assert.equal(sliceSpan(TEXT, grown), 'The query planner chooses an execution plan');
});

test('scripts without spaces segment into words, not one long run', () => {
  // A regex on whitespace would return the whole string here.
  const japanese = '東京都に住んでいます';
  const segments = words(japanese, 'ja').map((s) => sliceSpan(japanese, s));
  assert.ok(segments.length > 1, `expected several words, got ${JSON.stringify(segments)}`);

  const span = wordAt(japanese, 0, 'ja');
  assert.ok(span && sliceSpan(japanese, span).length < japanese.length);
});

test('word count reports the size of a span', () => {
  const base = wordAt(TEXT, TEXT.indexOf('query'))!;
  assert.equal(wordCount(TEXT, base), 1);
  assert.equal(wordCount(TEXT, resizeSpan(TEXT, base, 2, 0)), 3);
});

test('an empty string yields no words and no crash', () => {
  assert.deepEqual(words(''), []);
  assert.equal(wordAt('', 0), undefined);
});

/** Pointing at any part of a name means the name, not the part. */
const compoundOf = (text: string, at: number): string => {
  const base = wordAt(text, at);
  return base ? sliceSpan(text, compoundAt(text, base)) : '';
};

test('a dotted or hyphenated identifier is one name, wherever it is pointed at', () => {
  // The reported case: hovering this flag in the Iceberg documentation asked
  // about "metadata", because the segmenter reads it as four words.
  const line = 'Set write.metadata.compression-codec to gzip for smaller files.';
  const flag = 'write.metadata.compression-codec';
  for (const part of ['write', 'metadata', 'compression', 'codec']) {
    assert.equal(compoundOf(line, line.indexOf(part) + 1), flag, `pointing at ${part}`);
  }
});

test('punctuation used as punctuation does not join words', () => {
  // A full stop before a space ends a sentence; one between two letters does
  // not. That single condition is the whole guard, so it is the whole test.
  const prose = 'Planning ends here. Writers commit afterwards.';
  assert.equal(compoundOf(prose, prose.indexOf('here')), 'here');
  assert.equal(compoundOf(prose, prose.indexOf('Writers')), 'Writers');

  const list = 'first, second - third';
  assert.equal(compoundOf(list, list.indexOf('second')), 'second');

  const ellipsis = 'and so on...then it stops';
  assert.equal(compoundOf(ellipsis, ellipsis.indexOf('then')), 'then');
});

test('a file name, a path and a namespaced table read as one name', () => {
  const cases: Array<[string, string, string]> = [
    ['Open config.yaml first.', 'config', 'config.yaml'],
    ['Query db.schema.orders today.', 'schema', 'db.schema.orders'],
    ['A well-known result.', 'known', 'well-known'],
    // Two joiners in a row end the walk, which is what keeps `on...then`
    // apart. A URL scheme pays for that rule: the path is still one name,
    // and `s3` on its own was never the interesting half.
    ['Read s3://bucket/warehouse now.', 'warehouse', 'bucket/warehouse'],
  ];
  for (const [text, point, expected] of cases) {
    assert.equal(compoundOf(text, text.indexOf(point) + 1), expected, text);
  }
});
