import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersistentStore, type KeyValueStore } from './store.ts';

/** In-memory stand-in for extension storage, with call counting. */
function memoryStore(): KeyValueStore & { data: Map<string, unknown>; reads: number } {
  const data = new Map<string, unknown>();
  return {
    data,
    reads: 0,
    async get<T>(keys: string[]) {
      this.reads++;
      const out: Record<string, T | undefined> = {};
      for (const key of keys) out[key] = data.get(key) as T | undefined;
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys: string[]) {
      for (const key of keys) data.delete(key);
    },
  };
}

const HOUR = 60 * 60 * 1000;

function build(now: () => number, over: Partial<ConstructorParameters<typeof PersistentStore>[1]> = {}) {
  const store = memoryStore();
  const persistent = new PersistentStore<string>(store, {
    maxEntries: 3,
    ttlMs: 24 * HOUR,
    maxHistory: 3,
    now,
    ...over,
  });
  return { store, persistent };
}

test('a written value reads back', async () => {
  const { persistent } = build(() => 1000);
  await persistent.write('a', 'first');
  assert.equal(await persistent.read('a'), 'first');
  assert.equal(await persistent.read('missing'), undefined);
});

test('an entry past its time to live is dropped on read', async () => {
  let clock = 0;
  const { persistent, store } = build(() => clock);
  await persistent.write('a', 'first');

  clock = 23 * HOUR;
  assert.equal(await persistent.read('a'), 'first');

  clock = 25 * HOUR;
  assert.equal(await persistent.read('a'), undefined);
  assert.equal(store.data.has('c:a'), false, 'the stale entry is removed, not just hidden');
});

test('the oldest entry is evicted once the cap is passed', async () => {
  let clock = 0;
  const { persistent, store } = build(() => clock);
  for (const key of ['a', 'b', 'c', 'd']) {
    clock += 1000;
    await persistent.write(key, key);
  }
  assert.equal(await persistent.read('a'), undefined, 'a was the oldest');
  assert.equal(await persistent.read('d'), 'd');
  assert.equal(store.data.has('c:a'), false, 'the evicted payload is deleted too');
});

test('rewriting a key refreshes it rather than adding a second index row', async () => {
  let clock = 0;
  const { persistent } = build(() => clock);
  for (const key of ['a', 'b', 'c']) {
    clock += 1000;
    await persistent.write(key, key);
  }
  clock += 1000;
  await persistent.write('a', 'refreshed');
  clock += 1000;
  await persistent.write('d', 'd');

  // "b" is now the oldest, because "a" was touched after it.
  assert.equal(await persistent.read('b'), undefined);
  assert.equal(await persistent.read('a'), 'refreshed');
});

test('reading a cached value costs one storage read', async () => {
  const { persistent, store } = build(() => 1000);
  await persistent.write('a', 'first');
  store.reads = 0;
  await persistent.read('a');
  assert.equal(store.reads, 1, 'the index must not be read on the hot path');
});

test('pruning removes only what has expired', async () => {
  let clock = 0;
  const { persistent } = build(() => clock);
  await persistent.write('old', 'x');
  clock = 20 * HOUR;
  await persistent.write('new', 'y');

  clock = 30 * HOUR;
  assert.equal(await persistent.prune(), 1);
  assert.equal(await persistent.read('new'), 'y');
});

test('history keeps the newest first and moves a repeat to the top', async () => {
  let clock = 0;
  const { persistent } = build(() => clock);
  const record = (query: string, host = 'a.com') =>
    persistent.recordLookup({ query, intent: 'word', host, at: (clock += 1000) });

  await record('alpha');
  await record('beta');
  await record('alpha');

  const items = await persistent.history();
  assert.deepEqual(items.map((i) => i.query), ['alpha', 'beta']);
  assert.equal(items.length, 2, 'a repeat moves, it does not duplicate');
});

test('the same word on two sites is two entries', async () => {
  const { persistent } = build(() => 1000);
  await persistent.recordLookup({ query: 'planner', intent: 'word', host: 'a.com', at: 1 });
  await persistent.recordLookup({ query: 'planner', intent: 'word', host: 'b.com', at: 2 });
  assert.equal((await persistent.history()).length, 2);
});

test('history is capped, and starred entries survive the cap', async () => {
  let clock = 0;
  const { persistent } = build(() => clock);
  const record = (query: string) =>
    persistent.recordLookup({ query, intent: 'word', host: 'a.com', at: (clock += 1000) });

  await record('one');
  await persistent.toggleStar('one', 'a.com');
  for (const q of ['two', 'three', 'four', 'five']) await record(q);

  const items = await persistent.history();
  assert.ok(items.some((i) => i.query === 'one' && i.starred), 'a starred entry is kept');
  assert.equal(items.filter((i) => !i.starred).length, 3, 'unstarred entries respect the cap');
});

test('a star survives the same query being looked up again', async () => {
  const { persistent } = build(() => 1000);
  await persistent.recordLookup({ query: 'alpha', intent: 'word', host: 'a.com', at: 1 });
  await persistent.toggleStar('alpha', 'a.com');
  await persistent.recordLookup({ query: 'alpha', intent: 'word', host: 'a.com', at: 2 });
  assert.equal((await persistent.history())[0]?.starred, true);
});

test('clearing history keeps starred entries', async () => {
  const { persistent } = build(() => 1000);
  await persistent.recordLookup({ query: 'keep', intent: 'word', host: 'a.com', at: 1 });
  await persistent.toggleStar('keep', 'a.com');
  await persistent.recordLookup({ query: 'drop', intent: 'word', host: 'a.com', at: 2 });

  await persistent.clearHistory();
  assert.deepEqual((await persistent.history()).map((i) => i.query), ['keep']);
});

test('clear removes every entry and the index with it', async () => {
  const { persistent, store } = build(() => 1000);
  await persistent.write('a', 'x');
  await persistent.write('b', 'y');
  await persistent.clear();
  assert.equal([...store.data.keys()].filter((k) => k.startsWith('c:')).length, 0);
  assert.equal(store.data.has('cacheIndex'), false);
});
