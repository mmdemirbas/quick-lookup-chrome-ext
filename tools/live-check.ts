/**
 * Smoke test against the real sources.
 *
 * Unit tests use canned payloads, so they keep passing when a source goes
 * down or changes shape. That is exactly how the previous build shipped a
 * dictionary provider whose API had started returning 502. This script runs
 * the real pipeline against the real endpoints and fails loudly.
 *
 * Run with `npm run smoke`. It is not part of `npm run check`, because a
 * network outage is not a reason to block a commit.
 */
import { extractSignals } from '../src/core/intent/signals.ts';
import { routeIntent } from '../src/core/intent/router.ts';
import { runLookup } from '../src/core/lookup.ts';
import { freeDictionaryProvider } from '../src/core/providers/free-dictionary.ts';
import { wiktionaryProvider } from '../src/core/providers/wiktionary.ts';
import { datamuseProvider } from '../src/core/providers/datamuse.ts';
import { wikipediaProvider } from '../src/core/providers/wikipedia.ts';
import type { Card, HttpClient, PageContext } from '../src/core/types.ts';

const UA = 'QuickLookup/0.2.0 (https://github.com/mmdemirbas/quick-lookup-chrome-ext)';

const http: HttpClient = {
  async json<T>(url: string, init: { signal?: AbortSignal } = {}): Promise<T> {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'Api-User-Agent': UA },
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
    return (await response.json()) as T;
  },
};

const providers = [wikipediaProvider, freeDictionaryProvider, wiktionaryProvider, datamuseProvider];

type Case = {
  text: string;
  page: PageContext;
  /** What must be true for this case to count as working. */
  expect: (card: Card) => string | undefined;
};

const CASES: Case[] = [
  {
    text: 'ephemeral',
    page: { host: 'en.wikipedia.org', title: 'Reading' },
    expect: (card) =>
      (card.slots.senses?.data?.length ?? 0) >= 2
        ? undefined
        : 'expected at least two senses for a common English word',
  },
  {
    text: 'planner',
    page: {
      host: 'iceberg.apache.org',
      title: 'Apache Iceberg table specification',
      topicTerms: ['iceberg', 'table', 'query', 'partition', 'metadata', 'database', 'spark'],
    },
    expect: (card) =>
      card.slots.senses?.data?.length ? undefined : 'expected definitions for a common word',
  },
  {
    text: 'Alan Turing',
    page: { host: 'news.example.com', title: 'Computing history' },
    expect: (card) =>
      card.slots.entity?.data?.title
        ? undefined
        : 'expected an entity card for a well known person',
  },
  {
    // The context-biasing mechanism end to end: "manifest" alone returns a
    // general article, but with the page topic it resolves to the sense the
    // reader is actually looking at.
    text: 'manifest',
    page: {
      host: 'iceberg.apache.org',
      title: 'Apache Iceberg table specification',
      topicTerms: ['iceberg', 'table', 'metadata', 'partition', 'snapshot', 'query'],
    },
    expect: (card) =>
      /iceberg/i.test(card.slots.entity?.data?.title ?? '')
        ? undefined
        : `page context did not steer the article (got "${card.slots.entity?.data?.title ?? 'nothing'}")`,
  },
];

let failures = 0;

for (const testCase of CASES) {
  const decision = routeIntent(extractSignals(testCase.text, testCase.page), 'en');
  const started = Date.now();
  let firstEvidenceMs = 0;

  const card = await runLookup(
    { id: 'smoke', text: testCase.text, uiLang: 'en', page: testCase.page },
    decision,
    { http, providers },
    {
      onUpdate: (partial) => {
        if (!firstEvidenceMs && partial.sources.some((s) => s !== 'links')) {
          firstEvidenceMs = Date.now() - started;
        }
      },
    },
  );

  const problem = testCase.expect(card);
  const mark = problem ? 'FAIL' : 'ok  ';
  if (problem) failures++;

  console.log(`\n${mark} "${testCase.text}" @ ${testCase.page.host}`);
  console.log(
    `     intent=${decision.intent}` +
      (decision.alsoFetch.length ? ` +[${decision.alsoFetch.join(',')}]` : '') +
      `  sources=${card.sources.filter((s) => s !== 'links').join(',') || 'none'}` +
      `  firstEvidence=${firstEvidenceMs || '—'}ms  total=${card.elapsedMs}ms`,
  );
  if (problem) console.log(`     ${problem}`);

  const gloss = card.slots.gloss?.data;
  if (gloss) console.log(`     gloss: ${gloss}`);

  for (const [i, sense] of (card.slots.senses?.data ?? []).slice(0, 3).entries()) {
    console.log(
      `     ${i + 1}. [${sense.partOfSpeech ?? '—'}] ${sense.definition.slice(0, 92)} (${sense.source})`,
    );
  }

  const related = card.slots.related?.data ?? [];
  if (related.length) {
    console.log(
      `     related: ${related.slice(0, 8).map((r) => `${r.word}·${r.kind[0]}`).join('  ')}`,
    );
  }

  const entity = card.slots.entity?.data;
  if (entity) {
    console.log(
      `     entity: ${entity.title} — ${entity.description ?? '(no description)'}` +
        ` image=${entity.imageUrl ? 'yes' : 'no'}`,
    );
  }
}

console.log(`\n${failures === 0 ? 'All sources responded as expected.' : `${failures} case(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
