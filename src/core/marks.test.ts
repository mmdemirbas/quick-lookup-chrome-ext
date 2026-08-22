import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markFor, namedMarks } from './marks.ts';

test('a site looks the same wherever it appears', () => {
  // The chip that links to Wiktionary and the footer line saying the answer
  // came from Wiktionary are one site. If these ever drift, the colour stops
  // meaning anything and becomes decoration.
  const chip = markFor('wiktionary', 'https://en.wiktionary.org/wiki/manifest');
  const source = markFor('wiktionary');
  assert.deepEqual(chip, source);
});

test('a link the table never named is recognised by where it points', () => {
  // Providers mint their own link ids: one per Stack Overflow tag, and
  // `mdn-doc` for a page MDN actually has. Neither is in the table.
  const tagged = markFor('so-tag-javascript', 'https://stackoverflow.com/questions/tagged/javascript');
  assert.deepEqual(tagged, markFor('stackoverflow'));

  const doc = markFor('mdn-doc', 'https://developer.mozilla.org/en-US/docs/Web/API/fetch');
  assert.deepEqual(doc, markFor('mdn'));
});

test('a Google property is not mistaken for Google', () => {
  // `translate.google.com` ends with `google.com`, so a shortest-match
  // lookup would give the search engine's mark to the translator.
  const translate = markFor('translate', 'https://translate.google.com/?text=x');
  assert.notEqual(translate.hue, markFor('google').hue);
  assert.deepEqual(markFor('gt-link', 'https://translate.google.com/?text=x'), translate);
  assert.deepEqual(markFor('anything', 'https://www.google.com/search?q=x'), markFor('google'));
});

test('a site no one has heard of still gets a mark, and the same one twice', () => {
  const first = markFor('unknown-source');
  const second = markFor('unknown-source');
  assert.deepEqual(first, second, 'a colour that changed between renders would be noise');
  assert.equal(first.letter, 'US');
  assert.ok(first.hue >= 0 && first.hue < 360);
});

test('a broken URL costs the mark nothing', () => {
  const mark = markFor('somewhere', 'not a url');
  assert.deepEqual(mark, markFor('somewhere'));
  assert.ok(mark.letter.length > 0);
});

test('the hand-set marks stay far enough apart to tell apart', () => {
  const marks = namedMarks();

  const letters = marks.map(([, mark]) => mark.letter);
  assert.equal(new Set(letters).size, letters.length, 'two sites with one monogram');

  // Equal hues are allowed and mean "same site family" — Stack Overflow and
  // the wider Stack Exchange network share both. Anything else has to be
  // separable at a glance.
  for (const [idA, a] of marks) {
    for (const [idB, b] of marks) {
      if (idA >= idB) continue;
      const apart = Math.abs(a.hue - b.hue);
      const round = Math.min(apart, 360 - apart);
      assert.ok(round === 0 || round >= 15, `${idA} and ${idB} are ${round}° apart`);
    }
  }
});

test('a source that is not a website is toned down', () => {
  // The page you are already reading is the one source that cost no request.
  // It sits in the same row as the ones that did, and should not shout.
  assert.ok(markFor('page').sat < markFor('wikipedia').sat);
});

test('a source named by its host reaches the same mark as the chip pointing at it', () => {
  // Providers name themselves the way a reader would recognise them —
  // `en.wiktionary.org`, not `wiktionary`. That name is what a sense carries,
  // and the mark beside the sense has to match the chip in the link row.
  assert.deepEqual(markFor('en.wiktionary.org'), markFor('wiktionary'));
  assert.deepEqual(markFor('freedictionaryapi.com'), markFor('free-dictionary'));
});
