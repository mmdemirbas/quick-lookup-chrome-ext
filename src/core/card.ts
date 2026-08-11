/**
 * Card construction and slot merging.
 *
 * The layout is decided before any data arrives so the card can reserve
 * height per slot and never move content that is already on screen. Several
 * providers may write the same slot; merge rules are per slot rather than
 * per provider, which is what lets sources be mixed instead of ranked.
 */
import type {
  Card,
  Intent,
  ProviderResult,
  Related,
  Sense,
  Slot,
  SlotData,
  SlotId,
  SlotState,
} from './types.ts';
import { dedupeBy, overlapScore } from './text.ts';

/**
 * The one place a slot is written under a key that is only known at runtime.
 *
 * `Card['slots']` is a mapped type so that reads stay precise — `slots.senses`
 * is `Sense[]`, not `unknown`. That precision cannot survive a write through a
 * `SlotId`-typed variable, so the cast lives here, once, instead of at every
 * call site.
 */
function setSlot(card: Card, id: SlotId, state: SlotState, data?: unknown): void {
  const slots = card.slots as Record<SlotId, Slot>;
  slots[id] = data === undefined ? { id, state } : ({ id, state, data } as Slot);
}

/** Reading under a runtime key. Returns the erased shape on purpose. */
function getSlot(card: Card, id: SlotId): { state: SlotState; data?: unknown } | undefined {
  return (card.slots as Record<SlotId, Slot | undefined>)[id];
}

/** Render order per intent. The first slot is the one the eye lands on. */
const LAYOUT: Record<Intent, SlotId[]> = {
  word: ['headword', 'pronunciation', 'gloss', 'senses', 'related', 'translation', 'links'],
  phrase: ['gloss', 'senses', 'extract', 'translation', 'links'],
  entity: ['entity', 'facts', 'extract', 'translation', 'links'],
  technical: ['gloss', 'extract', 'entity', 'senses', 'links'],
  citation: ['facts', 'extract', 'links'],
  quantity: ['gloss', 'facts', 'links'],
  foreign: ['translation', 'headword', 'senses', 'links'],
  unknown: ['gloss', 'extract', 'entity', 'links'],
};

export function layoutFor(intent: Intent): SlotId[] {
  return LAYOUT[intent] ?? LAYOUT.unknown;
}

export function createCard(requestId: string, query: string, intent: Intent): Card {
  const order = layoutFor(intent);
  const card: Card = {
    requestId,
    query,
    intent,
    order,
    slots: {},
    sources: [],
    elapsedMs: 0,
    done: false,
  };
  for (const id of order) setSlot(card, id, 'pending');
  return card;
}

/**
 * Orders senses so the one that fits this page comes first.
 *
 * Ranking is by overlap with the page topic and the enclosing sentence,
 * with a small bonus for having an example. Sources are interleaved rather
 * than concatenated, so a card never shows six senses from one source
 * before the first sense from another.
 */
export function rankSenses(senses: Sense[], context: string[]): Sense[] {
  const scored = senses.map((sense, index) => {
    const haystack = `${sense.definition} ${sense.example ?? ''}`;
    const relevance = overlapScore(haystack, context);
    const hasExample = sense.example ? 0.05 : 0;
    // Original order is a weak signal that sources already rank by frequency.
    const positionPenalty = index * 0.001;
    return { sense, score: relevance + hasExample - positionPenalty };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.sense);
}

const RELATED_PRIORITY: Record<Related['kind'], number> = {
  synonym: 0,
  antonym: 1,
  collocation: 2,
  related: 3,
};

function mergeSlot<K extends SlotId>(
  id: K,
  existing: SlotData[K] | undefined,
  incoming: SlotData[K],
): SlotData[K] {
  if (existing === undefined) return incoming;

  switch (id) {
    case 'senses': {
      const merged = [...(existing as Sense[]), ...(incoming as Sense[])];
      return dedupeBy(merged, (s) =>
        s.definition.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
      ) as SlotData[K];
    }
    case 'related': {
      const merged = [...(existing as Related[]), ...(incoming as Related[])];
      const unique = dedupeBy(merged, (r) => `${r.kind}:${r.word.toLowerCase()}`);
      unique.sort((a, b) => RELATED_PRIORITY[a.kind] - RELATED_PRIORITY[b.kind]);
      return unique as SlotData[K];
    }
    case 'pronunciation': {
      const merged = [
        ...(existing as SlotData['pronunciation']),
        ...(incoming as SlotData['pronunciation']),
      ];
      return dedupeBy(merged, (p) => p.ipa ?? p.audio ?? '') as SlotData[K];
    }
    case 'links':
    case 'facts': {
      const merged = [...(existing as unknown[]), ...(incoming as unknown[])];
      return dedupeBy(merged, (item) => JSON.stringify(item)) as SlotData[K];
    }
    default:
      // Scalars and single objects: first writer wins, so the fastest
      // provider owns the slot and a slower one cannot rewrite the card.
      return existing;
  }
}

/** Applies a provider result to a card in place and returns the card. */
export function applyResult(card: Card, providerId: string, result: ProviderResult): Card {
  for (const [key, value] of Object.entries(result.slots)) {
    const id = key as SlotId;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;

    const merged = mergeSlot(id, getSlot(card, id)?.data as never, value as never);
    setSlot(card, id, 'filled', merged);

    // A provider may fill a slot the layout did not anticipate.
    if (!card.order.includes(id)) card.order.push(id);
  }
  if (!card.sources.includes(providerId)) card.sources.push(providerId);
  return card;
}

/** Marks every still-pending slot as empty. Called when all providers settle. */
export function finalise(card: Card, context: string[] = []): Card {
  const senses = card.slots.senses?.data;
  if (senses && senses.length > 0) {
    card.slots.senses = { id: 'senses', state: 'filled', data: rankSenses(senses, context) };
    // The lead sense doubles as the one-line gloss when nothing else set one.
    if (!card.slots.gloss?.data && card.order.includes('gloss')) {
      const lead = senses[0];
      if (lead) card.slots.gloss = { id: 'gloss', state: 'filled', data: lead.definition };
    }
  }
  for (const id of card.order) {
    const slot = getSlot(card, id);
    if (!slot || slot.state === 'pending') setSlot(card, id, 'empty');
  }
  card.done = true;
  return card;
}
