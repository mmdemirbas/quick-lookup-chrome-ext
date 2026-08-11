import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIdentifierStyle, detectScript, extractSignals } from './signals.ts';

test('identifier styles are recognised', () => {
  assert.equal(detectIdentifierStyle('hiddenPartitioning'), 'camel');
  assert.equal(detectIdentifierStyle('MergeInto'), 'pascal');
  assert.equal(detectIdentifierStyle('merge_into'), 'snake');
  assert.equal(detectIdentifierStyle('org.apache.iceberg'), 'dotted');
  assert.equal(detectIdentifierStyle('copy-on-write-mode'), 'kebab');
});

test('ordinary words and compounds are not treated as identifiers', () => {
  // The common false positive: a plain word, and a normal English compound.
  assert.equal(detectIdentifierStyle('planner'), 'none');
  assert.equal(detectIdentifierStyle('Ephemeral'), 'none');
  assert.equal(detectIdentifierStyle('well-known'), 'none');
  assert.equal(detectIdentifierStyle('two words'), 'none');
});

test('script detection covers the languages the router branches on', () => {
  assert.equal(detectScript('ephemeral'), 'latin');
  assert.equal(detectScript('儚い'), 'cjk');
  assert.equal(detectScript('эфемерный'), 'cyrillic');
  assert.equal(detectScript('سريع الزوال'), 'arabic');
  // Turkish uses Latin script; it must not be mistaken for something exotic.
  assert.equal(detectScript('geçici'), 'latin');
});

test('quantities are parsed with their unit', () => {
  assert.deepEqual(extractSignals('42 km').quantity, { value: 42, unit: 'km' });
  assert.deepEqual(extractSignals('98.6°F').quantity, { value: 98.6, unit: '°F' });
  assert.deepEqual(extractSignals('15%').quantity, { value: 15, unit: '%' });
  assert.equal(extractSignals('ephemeral').quantity, null);
});

test('title case allows lowercase connecting words inside a name', () => {
  assert.equal(extractSignals('Alan Turing').titleCase, true);
  assert.equal(extractSignals('Ludwig van Beethoven').titleCase, true);
  assert.equal(extractSignals('the query planner').titleCase, false);
});

test('shape patterns are detected', () => {
  assert.equal(extractSignals('10.1145/3292500.3330648').looksLikeDoi, true);
  assert.equal(extractSignals('2301.07041').looksLikeArxiv, true);
  assert.equal(extractSignals('#3f51b5').looksLikeHexColor, true);
  assert.equal(extractSignals('192.168.1.1').looksLikeIpAddress, true);
  assert.equal(extractSignals('react@18.2.0').looksLikePackageVersion, true);
  assert.equal(extractSignals('Blade Runner (1982)').hasYearInParens, true);
  assert.equal(extractSignals('Severance S01E03').hasEpisodeCode, true);
  assert.equal(extractSignals('Dr. Grace Hopper').hasHonorific, true);
});

test('developer hosts are matched including subdomains', () => {
  assert.equal(extractSignals('planner', { host: 'iceberg.apache.org' }).devHost, true);
  assert.equal(extractSignals('planner', { host: 'docs.github.com' }).devHost, true);
  assert.equal(extractSignals('planner', { host: 'www.bbc.co.uk' }).devHost, false);
});

test('tokenizing strips surrounding punctuation but keeps the word', () => {
  assert.deepEqual(extractSignals('"ephemeral,"').tokens, ['ephemeral']);
  assert.equal(extractSignals('  ephemeral  ').text, 'ephemeral');
});
