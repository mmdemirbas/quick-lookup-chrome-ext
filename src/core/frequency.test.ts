import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frequencyBand, hasFrequency, readFrequencyTag, zipf } from './frequency.ts';

/**
 * Occurrences per million, read from Datamuse on 2026-08-16. Kept as real
 * figures rather than round numbers, because the bands were cut to fit this
 * distribution and a fixture of tidy values could not tell whether they still
 * do.
 */
const MEASURED: Array<[word: string, perMillion: number, band: number]> = [
  ['of', 23375.750574, 5],
  ['work', 521.783568, 5],
  ['the', 407.210664, 5],
  ['table', 226.456414, 5],
  ['manifest', 11.15482, 4],
  ['commit', 9.453945, 3],
  ['query', 8.871231, 3],
  ['partition', 7.775945, 3],
  ['schema', 5.385915, 3],
  ['ephemeral', 1.600203, 3],
  ['iceberg', 0.929917, 2],
  ['obsequious', 0.291383, 2],
  ['serializable', 0.180289, 2],
  ['idempotent', 0.063447, 1],
  ['defenestrate', 0.000912, 1],
];

test('the scale spaces ordinary vocabulary out instead of pinning it to zero', () => {
  // On a linear bar `of` is 14,600 times `ephemeral`, so every word worth
  // looking up sits at the bottom and looks identical to every other.
  assert.ok(zipf(23375.750574) / zipf(1.600203) < 3);
  assert.equal(Math.round(zipf(407.210664) * 10) / 10, 5.6);
  // `defenestrate` sits at the very bottom of the scale, just below zero.
  assert.ok(Math.abs(zipf(0.000912)) < 0.05);
  // A word the corpus never saw is not a word that occurs zero times, but if
  // one is asked about anyway it must not produce -Infinity.
  assert.equal(zipf(0), 0);
});

test('the bands put everyday words, working vocabulary and rare words apart', () => {
  for (const [word, perMillion, expected] of MEASURED) {
    assert.equal(frequencyBand(perMillion).band, expected, `${word} (${perMillion}/M)`);
  }
  assert.equal(frequencyBand(407.210664).label, 'everyday');
  assert.equal(frequencyBand(0.063447).label, 'rare');
});

test('frequency is told apart from part of speech only by its prefix', () => {
  // Datamuse returns both in one array of strings.
  assert.equal(readFrequencyTag(['adj', 'n', 'f:1.600203']), 1.600203);
  assert.equal(readFrequencyTag(['adv', 'f:407.210664']), 407.210664);
  // Absent and "never occurs" are different, and only one is worth drawing.
  assert.equal(readFrequencyTag(['n']), undefined);
  assert.equal(readFrequencyTag(undefined), undefined);
  assert.equal(readFrequencyTag(['f:']), undefined);
  assert.equal(readFrequencyTag(['f:0']), undefined);
  assert.equal(readFrequencyTag(['f:not-a-number']), undefined);
});

test('only a single word can have a frequency worth showing', () => {
  assert.ok(hasFrequency('ephemeral'));
  assert.ok(hasFrequency("don't"));
  assert.ok(hasFrequency('well-known'));
  // The corpus is indexed by word, so a phrase returns nothing at all.
  assert.ok(!hasFrequency('snapshot isolation'));
  // An identifier's frequency would be the frequency of some other spelling.
  assert.ok(!hasFrequency('write.metadata.compression-codec'));
  assert.ok(!hasFrequency('42'));
  assert.ok(!hasFrequency('a'));
  assert.ok(!hasFrequency(''));
});
