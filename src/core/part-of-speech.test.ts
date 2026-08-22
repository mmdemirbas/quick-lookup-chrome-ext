import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partOfSpeech, partOfSpeechGroups } from './part-of-speech.ts';

test('the spellings the sources actually send all land in the right group', () => {
  // Wiktionary sends the long forms, the other dictionaries the short ones,
  // and one of the three sends them capitalised.
  assert.equal(partOfSpeech('noun')?.group, 'noun');
  assert.equal(partOfSpeech('Proper noun')?.group, 'noun');
  assert.equal(partOfSpeech('adj.')?.group, 'adjective');
  assert.equal(partOfSpeech(' VERB ')?.group, 'verb');
  assert.equal(partOfSpeech('adverb')?.group, 'adverb');
});

test('pronouns, prepositions and determiners are one class', () => {
  // A reader placing a word needs "this is a function word", not which kind.
  const groups = ['pronoun', 'preposition', 'conjunction', 'determiner', 'article'].map(
    (name) => partOfSpeech(name)?.group,
  );
  assert.deepEqual(new Set(groups), new Set(['function']));
});

test('a part of speech outside the five keeps the neutral colour', () => {
  // Not a failure: interjections and prefixes are a long tail nobody scans
  // for, and a hue each would spend the palette on the cases that do not
  // need it.
  assert.equal(partOfSpeech('interjection'), undefined);
  assert.equal(partOfSpeech('prefix'), undefined);
  assert.equal(partOfSpeech(''), undefined);
  assert.equal(partOfSpeech(undefined), undefined);
});

test('the five are far enough apart to tell apart', () => {
  const hues = partOfSpeechGroups().map((g) => g.hue);
  for (const a of hues) {
    for (const b of hues) {
      if (a >= b) continue;
      const apart = Math.abs(a - b);
      assert.ok(Math.min(apart, 360 - apart) >= 25, `${a}° and ${b}° are too close`);
    }
  }
});

test('noun and verb are the pair furthest apart', () => {
  // The distinction being drawn most often gets the most separation.
  const round = (a: number, b: number) => {
    const apart = Math.abs(a - b);
    return Math.min(apart, 360 - apart);
  };
  const hue = (name: string) => partOfSpeech(name)?.hue ?? 0;
  const nounVerb = round(hue('noun'), hue('verb'));
  for (const [x, y] of [
    ['noun', 'adjective'],
    ['verb', 'adjective'],
    ['noun', 'adverb'],
    ['verb', 'adverb'],
  ]) {
    assert.ok(nounVerb >= round(hue(x ?? ''), hue(y ?? '')), `${x}/${y} beat noun/verb`);
  }
});
