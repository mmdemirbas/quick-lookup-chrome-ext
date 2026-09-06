import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentenceAround } from './page-context.ts';

// The string the card shows as "where you met it", the string a note quotes,
// and the string the senses are ranked against are all this one.

test('the sentence is the one the selection is in, not the first one that mentions it', () => {
  const text = 'A manifest lists data files. Each manifest belongs to a snapshot.';
  const second = text.indexOf('manifest', 30);

  assert.equal(sentenceAround(text, 'manifest', second), 'Each manifest belongs to a snapshot.');
  assert.equal(sentenceAround(text, 'manifest', text.indexOf('manifest')), 'A manifest lists data files.');
});

test('a question ends a sentence', () => {
  const text = 'What is a manifest? A manifest lists the data files.';
  const inAnswer = text.indexOf('manifest', 20);

  assert.equal(sentenceAround(text, 'manifest', inAnswer), 'A manifest lists the data files.');
});

test('an exclamation ends one too', () => {
  const text = 'Read the spec! A manifest lists the data files.';
  assert.equal(
    sentenceAround(text, 'manifest', text.indexOf('manifest')),
    'A manifest lists the data files.',
  );
});

test('prose with no terminator is cut at a space, never mid-word', () => {
  const vocabulary = ['a', 'manifest', 'and', 'some', 'more', 'prose'];
  const text = `a manifest ${'and some more prose '.repeat(30)}`;
  const cut = sentenceAround(text, 'manifest', text.indexOf('manifest'));

  assert.ok(cut);
  assert.ok(cut.length <= 320, `bounded, got ${cut.length}`);
  assert.ok(text.startsWith(cut), 'still begins where the text does');
  const last = cut.split(' ').at(-1);
  assert.ok(vocabulary.includes(last ?? ''), `ends on a whole word, got ${JSON.stringify(last)}`);
});

test('a sentence that adds nothing to the word tells the reader nothing', () => {
  assert.equal(sentenceAround('manifest', 'manifest', 0), undefined);
});

test('a position outside the text has no sentence', () => {
  assert.equal(sentenceAround('A manifest.', 'manifest', -1), undefined);
  assert.equal(sentenceAround('A manifest.', 'manifest', 99), undefined);
});
