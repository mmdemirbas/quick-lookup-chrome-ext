import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageTag, sameLanguage, toIso1, toIso3 } from './language.ts';

test('the two code shapes convert both ways', () => {
  assert.equal(toIso1('tur'), 'tr');
  assert.equal(toIso1('tr'), 'tr');
  assert.equal(toIso3('tr'), 'tur');
  // Several three-letter codes reach one two-letter code; only one of them
  // can be the answer coming back.
  assert.equal(toIso1('ger'), 'de');
  assert.equal(toIso1('deu'), 'de');
  assert.equal(toIso3('de'), 'deu');
});

test('a code outside the table is unknown rather than guessed at', () => {
  assert.equal(toIso1('klingon'), undefined);
  assert.equal(toIso3('xyz'), undefined);
});

test('a declared language is only believed when it is shaped like one', () => {
  assert.equal(languageTag('de'), 'de');
  assert.equal(languageTag('en-GB'), 'en-GB');
  assert.equal(languageTag('zh-Hant-TW'), 'zh-Hant-TW');
  // What `lang` attributes actually contain when an author is careless.
  assert.equal(languageTag(''), undefined);
  assert.equal(languageTag('   '), undefined);
  assert.equal(languageTag('English'), undefined);
  assert.equal(languageTag(null), undefined);
  assert.equal(languageTag(undefined), undefined);
});

test('region and script do not make two languages', () => {
  // The point of this: a translator asked to turn en-GB into en-US spends a
  // request and hands back the input.
  assert.ok(sameLanguage('en-GB', 'en-US'));
  assert.ok(sameLanguage('EN', 'en'));
  assert.ok(sameLanguage('zh-Hant-TW', 'zh'));
  assert.ok(!sameLanguage('de', 'en'));
  assert.ok(!sameLanguage('', 'en'), 'nothing is not the same language as something');
});
