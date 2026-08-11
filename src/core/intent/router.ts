/**
 * Turns signals into an intent.
 *
 * The router is deliberately deterministic and never asks a model. A model
 * is only worth consulting when the deterministic answer is ambiguous, and
 * that decision is expressed here as `ambiguous` plus `alsoFetch` — the
 * caller can widen the fetch instead of waiting for a classification.
 *
 * Widening is cheap: providers run in parallel and merge into slots, so
 * fetching both the word and the technical path for `planner` on a
 * documentation site costs one extra request and produces a better card.
 */
import type { Intent } from '../types.ts';
import type { Signals } from './signals.ts';

export type Decision = {
  intent: Intent;
  /** Extra intents worth fetching alongside the primary one. */
  alsoFetch: Intent[];
  /** 0..1. Below `AMBIGUOUS_BELOW` the decision is a guess. */
  confidence: number;
  reasons: string[];
  ambiguous: boolean;
};

export const AMBIGUOUS_BELOW = 0.6;

/** Selections longer than this are treated as passages, not lookups. */
export const MAX_LOOKUP_TOKENS = 12;

function decide(
  intent: Intent,
  confidence: number,
  reason: string,
  alsoFetch: Intent[] = [],
): Decision {
  return {
    intent,
    alsoFetch,
    confidence,
    reasons: [reason],
    ambiguous: confidence < AMBIGUOUS_BELOW,
  };
}

export function routeIntent(s: Signals, uiLang = 'en'): Decision {
  if (s.charCount === 0) return decide('unknown', 1, 'empty selection');

  // Shape patterns first: these are unambiguous when they match at all.
  if (s.looksLikeDoi || s.looksLikeArxiv || s.looksLikeIsbn) {
    return decide('citation', 0.98, 'identifier matches a citation scheme');
  }
  if (s.quantity) {
    return decide('quantity', 0.9, 'number followed by a unit');
  }
  if (s.looksLikeHexColor || s.looksLikeIpAddress || s.looksLikePackageVersion) {
    return decide('technical', 0.95, 'matches a machine-readable format');
  }
  if (s.looksLikeUrl) {
    return decide('technical', 0.85, 'looks like a URL');
  }
  if (s.hasEpisodeCode || s.hasYearInParens) {
    return decide('entity', 0.9, 'carries a work or release marker');
  }
  if (s.hasHonorific) {
    return decide('entity', 0.9, 'carries an honorific');
  }

  // A non-Latin script in a Latin-language UI is almost always a translation
  // request. The reverse is handled by the language detector, not here.
  const uiIsLatin = !/^(?:ja|zh|ko|ru|uk|bg|el|ar|he|fa|hi|bn|ta|te|th)/.test(uiLang);
  if (uiIsLatin && s.script !== 'latin' && s.script !== 'other') {
    return decide('foreign', 0.85, `script is ${s.script}, UI language is ${uiLang}`);
  }

  if (s.tokenCount > MAX_LOOKUP_TOKENS) {
    return decide('phrase', 0.7, 'longer than a lookup, treated as a passage');
  }

  // Identifier conventions are strong evidence, but only when the token
  // could not equally be an ordinary word.
  if (s.identifierStyle !== 'none') {
    return decide('technical', 0.9, `identifier style: ${s.identifierStyle}`);
  }
  if (s.inCode) {
    return decide('technical', 0.85, 'selection sits inside a code element');
  }

  if (s.tokenCount === 1) {
    // A single capitalised token is the genuinely ambiguous case: `Mercury`,
    // `Iceberg`, `Turing`. Fetch both paths rather than guessing.
    if (s.titleCase && !s.allCaps) {
      return {
        intent: 'entity',
        alsoFetch: ['word'],
        confidence: 0.5,
        reasons: ['single capitalised token — could be a name or a sentence start'],
        ambiguous: true,
      };
    }
    if (s.allCaps && s.charCount <= 8) {
      return decide('technical', 0.7, 'short all-caps token reads as an acronym', ['entity']);
    }
    if (s.devHost || s.ecosystems.length > 0) {
      return {
        intent: 'word',
        alsoFetch: ['technical'],
        confidence: 0.55,
        reasons: [
          s.devHost
            ? 'single word, but the page is developer documentation'
            : `single word on a page about ${s.ecosystems[0]}`,
        ],
        ambiguous: true,
      };
    }
    return decide('word', 0.9, 'single lowercase token');
  }

  // Multi-token selections.
  if (s.titleCase) {
    return decide('entity', 0.8, 'title case across several tokens', ['technical']);
  }
  const technicalPage = s.devHost || s.ecosystems.length > 0;
  if (technicalPage || s.tokenCount <= 4) {
    return {
      intent: 'phrase',
      alsoFetch: technicalPage ? ['technical'] : [],
      confidence: 0.65,
      reasons: [technicalPage ? 'short phrase on a technical page' : 'short phrase'],
      ambiguous: false,
    };
  }

  return decide('phrase', 0.7, 'multi-word selection');
}
