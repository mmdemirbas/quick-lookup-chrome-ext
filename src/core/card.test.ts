import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyResult, createCard, finalise, layoutFor, rankSenses, withoutLead } from './card.ts';
import type { Sense } from './types.ts';

const sense = (definition: string, source: string, example?: string): Sense => ({
  definition,
  source,
  ...(example ? { example } : {}),
});

test('a new card has every slot of its layout pending', () => {
  const card = createCard('r1', 'ephemeral', 'word');
  assert.deepEqual(card.order, layoutFor('word'));
  for (const id of card.order) {
    assert.equal(card.slots[id]?.state, 'pending', `${id} should start pending`);
  }
});

test('senses from two sources merge and duplicates collapse', () => {
  const card = createCard('r1', 'ephemeral', 'word');
  applyResult(card, 'a', { slots: { senses: [sense('Lasting a short time.', 'a')] } });
  applyResult(card, 'b', {
    slots: {
      senses: [
        // Same definition, different punctuation and case: one sense, not two.
        sense('lasting a short time', 'b'),
        sense('Something short-lived.', 'b'),
      ],
    },
  });
  const senses = card.slots.senses?.data ?? [];
  assert.equal(senses.length, 2);
  assert.deepEqual(card.sources, ['a', 'b']);
});

test('related words deduplicate per kind and sort synonyms first', () => {
  const card = createCard('r1', 'fast', 'word');
  applyResult(card, 'a', {
    slots: {
      related: [
        { word: 'quickly', kind: 'collocation', source: 'a' },
        { word: 'rapid', kind: 'synonym', source: 'a' },
      ],
    },
  });
  applyResult(card, 'b', {
    slots: {
      related: [
        { word: 'Rapid', kind: 'synonym', source: 'b' },
        { word: 'slow', kind: 'antonym', source: 'b' },
      ],
    },
  });
  const related = card.slots.related?.data ?? [];
  assert.deepEqual(
    related.map((r) => `${r.kind}:${r.word}`),
    ['synonym:rapid', 'antonym:slow', 'collocation:quickly'],
  );
});

test('a scalar slot keeps its first writer so the card cannot rewrite itself', () => {
  const card = createCard('r1', 'ephemeral', 'word');
  applyResult(card, 'fast', { slots: { headword: 'ephemeral' } });
  applyResult(card, 'slow', { slots: { headword: 'EPHEMERAL' } });
  assert.equal(card.slots.headword?.data, 'ephemeral');
});

test('the extract slot is owned by source priority, not by who answered first', () => {
  const wikipedia = { text: 'Apache Iceberg is a high-performance format for huge tables.', source: 'wikipedia' };
  const stack = { text: 'Apache Iceberg is a table format for analytics.', source: 'stackexchange' };

  // The same two sources in either arrival order must produce the same card,
  // or the paragraph shown would depend on the network rather than the term.
  const slow = createCard('r1', 'Apache Iceberg', 'technical');
  applyResult(slow, 'stackexchange', { slots: { extract: stack } });
  applyResult(slow, 'wikipedia', { slots: { extract: wikipedia } });

  const fast = createCard('r2', 'Apache Iceberg', 'technical');
  applyResult(fast, 'wikipedia', { slots: { extract: wikipedia } });
  applyResult(fast, 'stackexchange', { slots: { extract: stack } });

  assert.equal(slow.slots.extract?.data?.source, 'wikipedia');
  assert.deepEqual(fast.slots.extract?.data, slow.slots.extract?.data);
});

test('an exactly matched source outranks a Wikipedia search result', () => {
  // Searching Wikipedia for "react-dom" returns the general article about
  // JavaScript libraries. It is related, and it is not what was selected.
  const card = createCard('r1', 'react-dom', 'technical');
  applyResult(card, 'wikipedia', {
    slots: { extract: { text: 'A JavaScript library is pre-written code.', source: 'wikipedia-search' } },
  });
  applyResult(card, 'registry', {
    slots: { extract: { text: 'React package for working with the DOM.', source: 'npm' } },
  });
  assert.equal(card.slots.extract?.data?.source, 'npm');
});

test('a summary that opens with the gloss keeps only what it adds', () => {
  // The tag wiki gloss is the first sentence of the tag wiki paragraph, so
  // this pair is the normal case rather than an edge one.
  assert.equal(
    withoutLead(
      'Webpack is a module bundler. Its main purpose is to bundle JavaScript files.',
      'Webpack is a module bundler.',
    ),
    'Its main purpose is to bundle JavaScript files.',
  );
  // Same sentence, different punctuation: nothing is added.
  assert.equal(withoutLead('React package for working with the DOM', 'React package for working with the DOM.'), '');
  // A summary about something else is left alone.
  assert.equal(
    withoutLead('Kubernetes automates deployment of containerised applications.', 'Webpack is a module bundler.'),
    undefined,
  );
  // Too short to be worth matching on at all.
  assert.equal(withoutLead('A bundler for the web.', 'A bundler.'), undefined);
});

test('the same sentence is never shown as both the gloss and the summary', () => {
  const card = createCard('r1', 'react-dom', 'technical');
  applyResult(card, 'stackexchange', { slots: { gloss: 'React package for working with the DOM.' } });
  applyResult(card, 'registry', {
    slots: { extract: { text: 'React package for working with the DOM', source: 'npm' } },
  });
  finalise(card);
  assert.equal(card.slots.extract?.state, 'empty');

  // A summary that genuinely says more than the gloss is kept — even though
  // it opens with the gloss word for word, which is how that gloss was
  // derived in the first place.
  const fuller = createCard('r2', 'webpack', 'technical');
  applyResult(fuller, 'stackexchange', { slots: { gloss: 'Webpack is a module bundler.' } });
  applyResult(fuller, 'stackexchange', {
    slots: {
      extract: {
        text: 'Webpack is a module bundler. Its main purpose is to bundle JavaScript files for usage in a browser, yet it can also transform, bundle, or package just about any resource or asset.',
        source: 'stackexchange',
      },
    },
  });
  finalise(fuller);
  assert.equal(fuller.slots.extract?.state, 'filled');
  assert.match(fuller.slots.extract?.data?.text ?? '', /^Its main purpose/);
});

test('empty arrays do not mark a slot as filled', () => {
  const card = createCard('r1', 'ephemeral', 'word');
  applyResult(card, 'a', { slots: { senses: [] } });
  assert.equal(card.slots.senses?.state, 'pending');
});

test('a usage example never outranks the source ordering', () => {
  // The defect this guards: a dictionary's rare first-listed-last sense
  // carrying a quotation displaced the everyday meaning of "ephemeral".
  const senses = [
    sense('Lasting for a short period of time.', 'a'),
    sense('(geology) Usually dry, but filling with water briefly.', 'a', 'an ephemeral stream'),
  ];
  const ranked = rankSenses(senses, []);
  assert.match(ranked[0]?.definition ?? '', /^Lasting for a short period/);
});

test('page context still outranks source ordering', () => {
  const senses = [
    sense('Lasting for a short period of time.', 'a'),
    sense('(geology) Usually dry, but filling with water briefly.', 'a'),
  ];
  const ranked = rankSenses(senses, ['geology', 'water', 'stream', 'river']);
  assert.match(ranked[0]?.definition ?? '', /geology/);
});

test('senses are ranked by overlap with page context', () => {
  const senses = [
    sense('A person who organises events such as weddings.', 'a'),
    sense('A component that chooses how to execute a database query.', 'a'),
  ];
  const ranked = rankSenses(senses, ['database', 'query', 'execution', 'table']);
  assert.match(ranked[0]?.definition ?? '', /database query/);

  // With no context the original order is preserved.
  const neutral = rankSenses(senses, []);
  assert.match(neutral[0]?.definition ?? '', /weddings/);
});

test('the gloss comes from the ranked lead, not the source order', () => {
  // Otherwise the one-line headline contradicts the list directly beneath it.
  const card = createCard('r1', 'manifest', 'word');
  applyResult(card, 'a', {
    slots: {
      senses: [
        sense('Evident to the senses; apparent.', 'a'),
        sense('(computing) A file containing metadata describing other files.', 'a'),
      ],
    },
  });
  finalise(card, ['metadata', 'file', 'table', 'computing']);
  assert.match(String(card.slots.gloss?.data), /^\(computing\)/);
  assert.equal(card.slots.senses?.data?.[0]?.definition, card.slots.gloss?.data);
});

test('finalise fills the gloss from the lead sense and empties the rest', () => {
  const card = createCard('r1', 'ephemeral', 'word');
  applyResult(card, 'a', { slots: { senses: [sense('Lasting a short time.', 'a')] } });
  finalise(card, []);
  assert.equal(card.slots.gloss?.data, 'Lasting a short time.');
  assert.equal(card.slots.pronunciation?.state, 'empty');
  assert.equal(card.done, true);
});
