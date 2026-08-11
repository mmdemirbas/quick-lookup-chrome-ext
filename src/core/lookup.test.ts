import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankingContext, runLookup, selectProviders } from './lookup.ts';
import type { HttpClient, LookupRequest, Provider } from './types.ts';
import type { Decision } from './intent/router.ts';

const decision = (intent: Decision['intent'], alsoFetch: Decision['alsoFetch'] = []): Decision => ({
  intent,
  alsoFetch,
  confidence: 1,
  reasons: [],
  ambiguous: false,
});

const request = (overrides: Partial<LookupRequest> = {}): LookupRequest => ({
  id: 'r1',
  text: 'ephemeral',
  uiLang: 'en',
  page: {},
  ...overrides,
});

const noHttp: HttpClient = {
  json: async () => {
    throw new Error('the network should not be reached in this test');
  },
};

function fakeProvider(
  id: string,
  intents: Provider['intents'],
  run: Provider['run'],
  deadlineMs = 500,
): Provider {
  return { id, label: id, intents, slots: ['senses'], deadlineMs, run };
}

test('providers are selected for the primary intent and the widened ones', () => {
  const all = [
    fakeProvider('dict', ['word'], async () => null),
    fakeProvider('wiki', ['entity', 'technical'], async () => null),
    fakeProvider('cite', ['citation'], async () => null),
  ];
  const ids = selectProviders(all, decision('word', ['technical'])).map((p) => p.id);
  assert.deepEqual(ids, ['dict', 'wiki']);
});

test('a provider serving two wanted intents still runs once', () => {
  const all = [fakeProvider('both', ['word', 'technical'], async () => null)];
  assert.equal(selectProviders(all, decision('word', ['technical'])).length, 1);
});

test('results from several providers merge into one card', async () => {
  const providers = [
    fakeProvider('a', ['word'], async () => ({
      slots: { senses: [{ definition: 'From source A.', source: 'a' }] },
    })),
    fakeProvider('b', ['word'], async () => ({
      slots: { senses: [{ definition: 'From source B.', source: 'b' }] },
    })),
  ];
  const card = await runLookup(request(), decision('word'), { http: noHttp, providers });
  assert.equal(card.slots.senses?.data?.length, 2);
  assert.equal(card.done, true);
});

test('one provider failing does not remove the card', async () => {
  const providers = [
    fakeProvider('broken', ['word'], async () => {
      throw new Error('source is down');
    }),
    fakeProvider('working', ['word'], async () => ({
      slots: { senses: [{ definition: 'Still here.', source: 'working' }] },
    })),
  ];
  const card = await runLookup(request(), decision('word'), { http: noHttp, providers });
  assert.equal(card.slots.senses?.data?.length, 1);
  assert.ok(!card.sources.includes('broken'));
});

test('a provider past its deadline is abandoned, not awaited', async () => {
  const providers = [
    fakeProvider(
      'slow',
      ['word'],
      (_req, ctx) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('never')), 5_000);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
      20,
    ),
    fakeProvider('fast', ['word'], async () => ({
      slots: { senses: [{ definition: 'Arrived in time.', source: 'fast' }] },
    })),
  ];
  const started = Date.now();
  const card = await runLookup(request(), decision('word'), { http: noHttp, providers });
  assert.ok(Date.now() - started < 2_000, 'must not wait for the slow provider');
  assert.equal(card.slots.senses?.data?.length, 1);
});

test('aborting a lookup stops it finalising', async () => {
  const controller = new AbortController();
  const providers = [
    fakeProvider('a', ['word'], async () => {
      controller.abort('new selection');
      return { slots: { senses: [{ definition: 'Too late.', source: 'a' }] } };
    }),
  ];
  const card = await runLookup(request(), decision('word'), { http: noHttp, providers }, {
    signal: controller.signal,
  });
  assert.equal(card.done, false);
});

test('updates are emitted before, during and after the run', async () => {
  const providers = [
    fakeProvider('a', ['word'], async () => ({
      slots: { senses: [{ definition: 'One.', source: 'a' }] },
    })),
  ];
  const seen: boolean[] = [];
  await runLookup(request(), decision('word'), { http: noHttp, providers }, {
    onUpdate: (card) => seen.push(card.done),
  });
  assert.ok(seen.length >= 3, 'skeleton, provider landing, and completion');
  assert.equal(seen.at(-1), true);
});

test('quick links are always present even with no providers at all', async () => {
  const card = await runLookup(request(), decision('word'), { http: noHttp, providers: [] });
  assert.ok((card.slots.links?.data?.length ?? 0) > 0);
});

test('ranking context excludes the selected word itself', () => {
  const context = rankingContext(
    request({
      text: 'planner',
      page: { topicTerms: ['planner', 'iceberg', 'query'], title: 'Apache Iceberg' },
    }),
  );
  assert.ok(!context.includes('planner'), 'the selection cannot be its own context');
  assert.ok(context.includes('iceberg'));
});
