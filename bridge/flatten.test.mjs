import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten } from './server.mjs';

test('content blocks are joined, page before question', () => {
  const prompt = flatten([
    { role: 'user', content: [{ type: 'text', text: '<page>body</page>' }, { type: 'text', text: 'Why?' }] },
  ]);
  assert.equal(prompt, 'User:\n<page>body</page>\n\nWhy?');
});

test('who said what survives the flattening', () => {
  // The CLI takes one string, so the turn markers are the only thing left
  // telling the model where the reader stops and the page starts.
  const prompt = flatten([
    { role: 'user', content: 'First' },
    { role: 'assistant', content: 'Answer' },
    { role: 'user', content: 'Follow-up' },
  ]);
  assert.equal(prompt, 'User:\nFirst\n\n---\n\nAssistant:\nAnswer\n\n---\n\nUser:\nFollow-up');
});

test('empty turns are dropped rather than sent as blank markers', () => {
  assert.equal(flatten([{ role: 'user', content: '   ' }, { role: 'user', content: 'Real' }]),
    'User:\nReal');
});

test('a missing or empty message list yields nothing, not a crash', () => {
  assert.equal(flatten(undefined), '');
  assert.equal(flatten([]), '');
});
