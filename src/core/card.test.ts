import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyResult, createCard, finalise, layoutFor, rankSenses } from './card.ts';
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

test('empty arrays do not mark a slot as filled', () => {
  const card = createCard('r1', 'ephemeral', 'word');
  applyResult(card, 'a', { slots: { senses: [] } });
  assert.equal(card.slots.senses?.state, 'pending');
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

test('finalise fills the gloss from the lead sense and empties the rest', () => {
  const card = createCard('r1', 'ephemeral', 'word');
  applyResult(card, 'a', { slots: { senses: [sense('Lasting a short time.', 'a')] } });
  finalise(card, []);
  assert.equal(card.slots.gloss?.data, 'Lasting a short time.');
  assert.equal(card.slots.pronunciation?.state, 'empty');
  assert.equal(card.done, true);
});
