import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache, cardShape, lookupKey } from './cache.ts';

test('an entry survives until its time to live runs out', () => {
  let clock = 0;
  const cache = new LruCache<string>({ maxEntries: 4, ttlMs: 100, now: () => clock });
  cache.set('a', 'first');

  clock = 99;
  assert.equal(cache.get('a'), 'first');
  clock = 100;
  assert.equal(cache.get('a'), undefined, 'expiry is inclusive');
  assert.equal(cache.size, 0, 'an expired entry is dropped on read, not left behind');
});

test('the least recently used entry is the one evicted', () => {
  const cache = new LruCache<number>({ maxEntries: 2, ttlMs: 1000 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // 'b' is now the least recently used.
  cache.set('c', 3);

  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('the same word on two sites is two entries', () => {
  const on = (host: string) => lookupKey('planner', 'word', host, 'en');
  assert.notEqual(on('postgresql.org'), on('theknot.com'));
});

/**
 * The reported defect: translation was switched on and nothing changed.
 *
 * The words a reader tries first are the ones they have looked up before, so
 * every one of them was answered from a persistent cache entry composed
 * under the old settings. Reloading the page could not help — the code that
 * would have translated never ran.
 */
test('turning translation on does not reach a card cached without it', () => {
  const key = (shape: string) => lookupKey('snapshot', 'word', 'iceberg.apache.org', 'en', shape);

  const off = key(cardShape({}));
  const onDevice = key(cardShape({ glossLanguage: 'tr' }));
  const alsoOnline = key(cardShape({ glossLanguage: 'tr', onlineTranslation: true }));

  assert.notEqual(off, onDevice, 'asking for a Turkish gloss is a different card');
  assert.notEqual(onDevice, alsoOnline, 'allowing an online translator can fill a slot that was empty');
  assert.notEqual(off, alsoOnline);
});

test('a card is only re-fetched for settings that change what is in it', () => {
  // Theme and font size change how a card is drawn. Re-running every source
  // for those would be waste, so they are absent from the shape by design.
  assert.equal(cardShape({ glossLanguage: 'tr' }), cardShape({ glossLanguage: 'tr' }));
  assert.equal(cardShape({ glossLanguage: '' }), cardShape({}));
  assert.equal(
    cardShape({ onlineTranslation: true }),
    cardShape({}),
    'an online translator with no target language cannot add anything',
  );
});
