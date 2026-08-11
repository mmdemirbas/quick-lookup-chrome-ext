import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSignals } from './signals.ts';
import { routeIntent } from './router.ts';
import type { PageContext } from '../types.ts';

const route = (text: string, page: PageContext = {}, uiLang = 'en') =>
  routeIntent(extractSignals(text, page), uiLang);

test('a plain lowercase word routes to word with confidence', () => {
  const d = route('ephemeral');
  assert.equal(d.intent, 'word');
  assert.equal(d.ambiguous, false);
});

test('identifiers and code context route to technical', () => {
  assert.equal(route('hiddenPartitioning').intent, 'technical');
  assert.equal(route('merge_into').intent, 'technical');
  assert.equal(route('planner', { inCode: true }).intent, 'technical');
  assert.equal(route('#3f51b5').intent, 'technical');
});

test('citations are recognised before anything else', () => {
  assert.equal(route('10.1145/3292500.3330648').intent, 'citation');
  assert.equal(route('arXiv:2301.07041').intent, 'citation');
});

test('names and works route to entity', () => {
  assert.equal(route('Alan Turing').intent, 'entity');
  assert.equal(route('Blade Runner (1982)').intent, 'entity');
  assert.equal(route('Dr. Grace Hopper').intent, 'entity');
});

test('a single capitalised token is ambiguous and widens the fetch', () => {
  const d = route('Mercury');
  assert.equal(d.ambiguous, true);
  assert.equal(d.intent, 'entity');
  assert.ok(d.alsoFetch.includes('word'), 'should also fetch the dictionary path');
});

test('a word on a documentation site widens to the technical path', () => {
  // This is the `planner` case: an ordinary English word whose useful sense
  // on this page is the technical one.
  const d = route('planner', { host: 'iceberg.apache.org' });
  assert.equal(d.intent, 'word');
  assert.ok(d.alsoFetch.includes('technical'));
  assert.equal(d.ambiguous, true);

  // The same word elsewhere stays a plain dictionary lookup.
  const plain = route('planner', { host: 'www.bbc.co.uk' });
  assert.equal(plain.intent, 'word');
  assert.deepEqual(plain.alsoFetch, []);
});

test('non-latin script in a latin UI routes to translation', () => {
  assert.equal(route('儚い').intent, 'foreign');
  assert.equal(route('эфемерный').intent, 'foreign');
  // Turkish is Latin script, so it must not be caught by the script rule.
  assert.equal(route('geçici').intent, 'word');
});

test('long selections are passages, not lookups', () => {
  const passage = Array.from({ length: 20 }, () => 'word').join(' ');
  assert.equal(route(passage).intent, 'phrase');
});

test('an empty selection is unknown rather than an error', () => {
  assert.equal(route('   ').intent, 'unknown');
});
