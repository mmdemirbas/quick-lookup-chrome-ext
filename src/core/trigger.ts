/**
 * What a selection should cause. Pure, so the guards can be tested.
 *
 * This answers "open, offer, or stay quiet". Timing guards — the dwell, the
 * copy shortcut, the mouse still being down — live in the content script
 * because they are about event order rather than about the selection.
 */
import type { Settings, TriggerMode } from './settings.ts';

export type SelectionFacts = {
  text: string;
  wordCount: number;
  /** The selection is inside an input, textarea or editable region. */
  inEditable: boolean;
  /** The selection is inside the extension's own card. */
  insideOwnUi: boolean;
  modifierHeld: boolean;
};

export type TriggerAction =
  /** Open the card. */
  | 'open'
  /** Show the handle only; opening needs a deliberate action. */
  | 'handle'
  /** Do nothing at all. */
  | 'ignore';

export type TriggerDecision = { action: TriggerAction; reason: string };

export function selectionFacts(
  text: string,
  parts: Omit<SelectionFacts, 'text' | 'wordCount'>,
): SelectionFacts {
  return {
    text,
    wordCount: text.trim().split(/\s+/).filter(Boolean).length,
    ...parts,
  };
}

export function decideTrigger(
  facts: SelectionFacts,
  settings: Settings,
  mode: TriggerMode,
): TriggerDecision {
  const trimmed = facts.text.trim();

  if (trimmed.length === 0) return { action: 'ignore', reason: 'empty selection' };
  if (facts.insideOwnUi) {
    // Selecting the answer in order to copy it must not re-trigger a lookup.
    return { action: 'ignore', reason: 'selection is inside the card' };
  }
  if (trimmed.length > settings.limits.maxSelectionChars) {
    return { action: 'ignore', reason: 'selection is longer than a lookup' };
  }
  if (facts.inEditable && !settings.trigger.inEditable) {
    return { action: 'ignore', reason: 'selection is in an editable field' };
  }

  switch (mode) {
    case 'off':
      return { action: 'ignore', reason: 'lookup on selection is off for this site' };
    case 'modifier':
      return facts.modifierHeld
        ? { action: 'open', reason: 'modifier held' }
        : { action: 'ignore', reason: 'modifier not held' };
    case 'handle':
      return { action: 'handle', reason: 'handle-only mode' };
    case 'auto':
      // A long selection is nearly always a quote or a copy, so it gets the
      // offer rather than the card.
      return facts.wordCount > settings.trigger.maxWords
        ? { action: 'handle', reason: 'selection is long enough to read as a quote' }
        : { action: 'open', reason: 'selection settled' };
    default:
      return { action: 'ignore', reason: 'unknown mode' };
  }
}

/**
 * Tracks dismissals so a site where the card is never wanted can offer to
 * quieten itself, rather than waiting to be found in the options page.
 */
export class DismissalTracker {
  readonly #counts = new Map<string, number>();
  readonly #threshold: number;

  constructor(threshold = 3) {
    this.#threshold = threshold;
  }

  /** Returns true when this host has just crossed the threshold. */
  recordDismissal(host: string): boolean {
    const next = (this.#counts.get(host) ?? 0) + 1;
    this.#counts.set(host, next);
    return next === this.#threshold;
  }

  /** Any interaction means the card was wanted after all. */
  recordEngagement(host: string): void {
    this.#counts.delete(host);
  }

  count(host: string): number {
    return this.#counts.get(host) ?? 0;
  }
}
