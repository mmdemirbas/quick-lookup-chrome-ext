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
  technical: ['gloss', 'extract', 'facts', 'entity', 'senses', 'links'],
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

/** How much a sense can be promoted by carrying a usage example. */
const EXAMPLE_BONUS = 0.002;

/** Cost of each position of distance from the source's own ordering. */
const POSITION_STEP = 0.02;

/**
 * Orders senses so the one that fits this page comes first.
 *
 * The weights are deliberately far apart, because they are not equally
 * trustworthy:
 *
 * 1. Overlap with the page topic dominates. It is the only signal that
 *    knows anything about what the reader is reading.
 * 2. The source's own order is next. Dictionaries list the common sense
 *    first, and that is a much better default than anything computed here.
 * 3. Carrying an example is the weakest signal, and must never outrank the
 *    source's order — an obscure geology sense with a quotation attached
 *    would otherwise displace the everyday meaning of the word.
 */
export function rankSenses(senses: Sense[], context: string[]): Sense[] {
  const scored = senses.map((sense, index) => {
    const haystack = `${sense.definition} ${sense.example ?? ''}`;
    const relevance = overlapScore(haystack, context);
    const example = sense.example ? EXAMPLE_BONUS : 0;
    return { sense, index, score: relevance - index * POSITION_STEP + example };
  });
  // A stable tiebreak on the original index keeps equal scores in source order.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.sense);
}

const RELATED_PRIORITY: Record<Related['kind'], number> = {
  synonym: 0,
  antonym: 1,
  collocation: 2,
  related: 3,
};

/**
 * Which source owns `extract` when more than one can fill it.
 *
 * Several providers can write a paragraph about a technical term, and
 * without a rule the winner would be whichever request happened to return
 * first — so the same lookup would show a different paragraph on a slow
 * network than on a fast one. An article whose title resolved directly
 * leads, because its summary is the fuller prose and it is certainly about
 * the selection. A Wikipedia *search* result comes last: it is whatever the
 * search engine judged related, which for a package name is usually the
 * general article about the language, and any source that matched the term
 * exactly says more.
 */
const EXTRACT_PRIORITY = [
  'wikipedia',
  'stackexchange',
  'mdn',
  'npm',
  'pypi',
  'crates',
  'wikipedia-search',
];

function extractRank(source: string): number {
  const at = EXTRACT_PRIORITY.indexOf(source);
  return at === -1 ? EXTRACT_PRIORITY.length : at;
}

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
    case 'extract': {
      const held = existing as SlotData['extract'];
      const offered = incoming as SlotData['extract'];
      return (extractRank(offered.source) < extractRank(held.source)
        ? offered
        : held) as SlotData[K];
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

/** Below this a summary adds nothing worth its own heading. */
const MIN_EXTRACT_CHARS = 40;

/** Words only, so punctuation and the ellipsis from truncation do not count. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * What a summary adds beyond the gloss above it, or `undefined` if it does
 * not begin with that gloss at all.
 *
 * Two sources routinely say the same thing first. A tag wiki's gloss *is*
 * the opening sentence of its own paragraph, and an npm description is
 * often word for word the tag wiki's opening. Printed unchanged the card
 * says the same sentence twice, which reads as a bug.
 */
export function withoutLead(text: string, lead: string): string | undefined {
  const wanted = normalise(lead);
  if (wanted.length < 20) return undefined;

  for (let cut = 1; cut <= text.length; cut++) {
    const prefix = normalise(text.slice(0, cut));
    if (prefix === wanted) return text.slice(cut).replace(/^[\s.,;:—–-]+/, '');
    if (prefix.length > wanted.length) return undefined;
  }
  return normalise(text) === wanted ? '' : undefined;
}

/** Marks every still-pending slot as empty. Called when all providers settle. */
export function finalise(card: Card, context: string[] = []): Card {
  const senses = card.slots.senses?.data;
  if (senses && senses.length > 0) {
    const ranked = rankSenses(senses, context);
    card.slots.senses = { id: 'senses', state: 'filled', data: ranked };
    // The lead sense doubles as the one-line gloss when nothing else set one.
    // It must come from the ranked list, or the headline contradicts the list
    // directly beneath it.
    if (!card.slots.gloss?.data && card.order.includes('gloss')) {
      const lead = ranked[0];
      if (lead) card.slots.gloss = { id: 'gloss', state: 'filled', data: lead.definition };
    }
  }
  // A summary that opens with the gloss shows only what it adds; one that
  // is the gloss and nothing more is dropped.
  const gloss = card.slots.gloss?.data;
  const extract = card.slots.extract?.data;
  if (gloss && extract) {
    const rest = withoutLead(extract.text, gloss);
    if (rest !== undefined) {
      if (rest.length < MIN_EXTRACT_CHARS) setSlot(card, 'extract', 'empty');
      else setSlot(card, 'extract', 'filled', { ...extract, text: rest });
    }
  }

  for (const id of card.order) {
    const slot = getSlot(card, id);
    if (!slot || slot.state === 'pending') setSlot(card, id, 'empty');
  }
  card.done = true;
  return card;
}
