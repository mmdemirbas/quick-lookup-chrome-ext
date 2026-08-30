/**
 * Settings shape and defaults. Pure, so the merge logic is testable.
 *
 * Defaults encode the product decisions rather than leaving them to the
 * options page: the card opens on selection, editable fields are excluded,
 * and nothing requires a key or an account.
 */
import type { TranslationPreference } from './online-translate.ts';
import { DEFAULT_CONTEXT_CHARS, DEFAULT_MODEL } from './chat.ts';

/** How a selection turns into a card on a given site. */
export type TriggerMode =
  /** Card opens by itself after the selection settles. The default. */
  | 'auto'
  /** A handle appears; the card opens only when it is used. */
  | 'handle'
  /** Nothing appears unless the modifier is held. */
  | 'modifier'
  /** Selection does nothing; the shortcut and context menu still work. */
  | 'off';

export type Modifier = 'alt' | 'ctrl' | 'meta' | 'shift';

export type Settings = {
  trigger: {
    mode: TriggerMode;
    modifier: Modifier;
    /** Milliseconds the selection must be stable before the card opens. */
    dwellMs: number;
    /** Above this many words, show the handle instead of opening. */
    maxWords: number;
    /** Look up inside inputs, textareas and editable regions. */
    inEditable: boolean;
    /** Hold the modifier and point at a word, with no selection. */
    hoverEnabled: boolean;
  };
  appearance: {
    theme: 'auto' | 'light' | 'dark';
    /** Show a translation of the lead sense into `glossLanguage`. */
    showGloss: boolean;
    glossLanguage: string;
    /**
     * Allow an online translator when the browser has none.
     *
     * Off by default, and the only setting that changes where the selection
     * goes: everything else is answered locally or by looking up a word the
     * reader chose. Turning it on sends the sentence to a third party.
     */
    onlineTranslation: boolean;
    /**
     * Which online service answers. `auto` tries the keyless endpoint first
     * and falls back to MyMemory; naming one is how to opt out of the other.
     */
    translationService: TranslationPreference;
    /**
     * Optional contact address sent with MyMemory requests. That service
     * raises the daily allowance tenfold in exchange for one.
     */
    translationEmail: string;
  };
  limits: {
    /** Whole-lookup budget. Individual providers have their own deadlines. */
    timeoutMs: number;
    cacheTtlHours: number;
    maxSelectionChars: number;
  };
  chat: {
    /**
     * Which model a new conversation starts on. The panel changes it per
     * conversation, so this is the starting point rather than the rule.
     */
    model: string;
    /**
     * Characters of page text sent with a question. Lower is cheaper and
     * blinder; the panel shows when a page was clipped by it.
     */
    contextChars: number;
  };
  /** Per-site overrides, keyed by host. */
  sites: Record<string, { mode?: TriggerMode }>;
};

export const DEFAULT_SETTINGS: Settings = {
  trigger: {
    mode: 'auto',
    modifier: 'alt',
    dwellMs: 250,
    maxWords: 12,
    inEditable: false,
    hoverEnabled: true,
  },
  appearance: {
    theme: 'auto',
    showGloss: true,
    glossLanguage: 'tr',
    onlineTranslation: false,
    translationService: 'auto',
    translationEmail: '',
  },
  limits: {
    timeoutMs: 4000,
    cacheTtlHours: 168,
    maxSelectionChars: 300,
  },
  chat: {
    model: DEFAULT_MODEL,
    contextChars: DEFAULT_CONTEXT_CHARS,
  },
  sites: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges stored settings over the defaults, one level deep.
 *
 * Stored settings are whatever an older version wrote, so unknown keys are
 * dropped and missing ones take the current default. That makes adding a
 * setting a non-event for anyone who already has the extension installed.
 */
export function mergeSettings(stored: unknown): Settings {
  if (!isRecord(stored)) return structuredClone(DEFAULT_SETTINGS);
  const out = structuredClone(DEFAULT_SETTINGS);

  for (const key of ['trigger', 'appearance', 'limits', 'chat'] as const) {
    const group = stored[key];
    if (!isRecord(group)) continue;
    for (const [field, value] of Object.entries(group)) {
      if (!(field in out[key])) continue;
      const target = out[key] as Record<string, unknown>;
      if (typeof value === typeof target[field]) target[field] = value;
    }
  }

  if (isRecord(stored.sites)) {
    for (const [host, value] of Object.entries(stored.sites)) {
      if (isRecord(value) && typeof value.mode === 'string') {
        out.sites[host] = { mode: value.mode as TriggerMode };
      }
    }
  }
  return out;
}

/** The effective trigger mode for a host, honouring any per-site override. */
export function triggerModeFor(settings: Settings, host: string): TriggerMode {
  return settings.sites[host]?.mode ?? settings.trigger.mode;
}
