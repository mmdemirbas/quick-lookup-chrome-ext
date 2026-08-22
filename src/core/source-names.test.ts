import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceName, namedSources } from './source-names.ts';
import { PROVIDERS } from './providers/all.ts';

test('every provider that can appear in a card has a name a reader would recognise', () => {
  // The table is written by hand because the card and the export may not
  // import the providers — that would put every provider's code into the
  // content script. This is what stops the two drifting apart.
  const named = new Set(namedSources());
  const missing = PROVIDERS.map((provider) => provider.id).filter((id) => !named.has(id));
  assert.deepEqual(missing, [], 'a provider whose id would be printed raw');
});

test('the source that asks to be named by name is named by name', () => {
  // freedictionaryapi.com serves Wiktionary data under CC BY-SA 4.0 and asks
  // for a visible attribution to itself. `free-dictionary` is the id it is
  // wired under here and names nothing.
  assert.equal(sourceName('free-dictionary'), 'FreeDictionaryAPI.com');
});

test('a source nobody named is still printed', () => {
  // A pack's own name reaches this, and so would a provider added tomorrow.
  assert.equal(sourceName('English-Turkish FreeDict'), 'English-Turkish FreeDict');
});
