/**
 * Cheap, local features of a selection.
 *
 * Everything here is string inspection — no network, no model, no async.
 * The router turns these into an intent; keeping extraction separate means
 * the signals can be tested and displayed without running the router.
 */
import type { PageContext } from '../types.ts';
import { detectEcosystems, type Ecosystem } from '../ecosystem.ts';

export type Script = 'latin' | 'cyrillic' | 'greek' | 'cjk' | 'arabic' | 'hebrew' | 'other';

export type IdentifierStyle = 'camel' | 'pascal' | 'snake' | 'kebab' | 'dotted' | 'none';

export type Signals = {
  text: string;
  tokens: string[];
  tokenCount: number;
  charCount: number;
  script: Script;
  allLower: boolean;
  allCaps: boolean;
  titleCase: boolean;
  hasDigit: boolean;
  identifierStyle: IdentifierStyle;
  looksLikeUrl: boolean;
  looksLikeDoi: boolean;
  looksLikeArxiv: boolean;
  looksLikeIsbn: boolean;
  looksLikeHexColor: boolean;
  looksLikeIpAddress: boolean;
  looksLikePackageVersion: boolean;
  hasYearInParens: boolean;
  hasEpisodeCode: boolean;
  hasHonorific: boolean;
  /**
   * The selection opens its sentence, so its capital letter is grammar
   * rather than evidence of a name.
   */
  atSentenceStart: boolean;
  quantity: { value: number; unit: string } | null;
  inCode: boolean;
  devHost: boolean;
  /**
   * Software ecosystems the page shows evidence of. Wider than `devHost`,
   * which only knows a list of sites: an article about React on a personal
   * blog is a technical page too, and that is where most reading happens.
   */
  ecosystems: Ecosystem[];
};

const HONORIFICS =
  /\b(?:Mr|Mrs|Ms|Dr|Prof|Sir|Dame|Rev|Hon|St|Lord|Lady|Capt|Gen|Sen|Pres)\.?\s/i;

const DEV_HOSTS = [
  'github.com',
  'gitlab.com',
  'stackoverflow.com',
  'stackexchange.com',
  'developer.mozilla.org',
  'docs.rs',
  'pkg.go.dev',
  'npmjs.com',
  'pypi.org',
  'readthedocs.io',
  'apache.org',
  'kubernetes.io',
  'rust-lang.org',
  'iceberg.apache.org',
];

const UNIT_PATTERN =
  /^([+-]?\d+(?:[.,]\d+)?)\s*(%|°[CF]?|[a-zA-Z]{1,12}|\$|€|£|₺)$/u;

/** Splits on whitespace, dropping surrounding punctuation but keeping internal marks. */
export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}$€£₺#@/.]+|[^\p{L}\p{N}%)]+$/gu, ''))
    .filter(Boolean);
}

export function detectScript(text: string): Script {
  if (/[一-鿿぀-ヿ가-힯]/.test(text)) return 'cjk';
  if (/[Ѐ-ӿ]/.test(text)) return 'cyrillic';
  if (/[؀-ۿ]/.test(text)) return 'arabic';
  if (/[֐-׿]/.test(text)) return 'hebrew';
  if (/[Ͱ-Ͽ]/.test(text)) return 'greek';
  if (/\p{Script=Latin}/u.test(text)) return 'latin';
  return 'other';
}

/**
 * Recognises the naming conventions that mark a programming identifier.
 *
 * Deliberately conservative: a plain lowercase word and an ordinary
 * hyphenated English compound must not be classified as code, because
 * both are far more common in prose than as identifiers.
 */
export function detectIdentifierStyle(text: string): IdentifierStyle {
  if (/\s/.test(text)) return 'none';
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(text)) return 'snake';
  if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(text)) return 'camel';
  if (/^(?:[A-Z][a-z0-9]+){2,}$/.test(text)) return 'pascal';
  if (/^[a-z][a-z0-9]*(?:\.[a-z0-9]+){1,}$/i.test(text)) return 'dotted';
  if (/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(text)) return 'kebab';
  return 'none';
}

function parseQuantity(text: string): { value: number; unit: string } | null {
  const match = UNIT_PATTERN.exec(text.trim());
  if (!match) return null;
  const raw = match[1];
  const unit = match[2];
  if (raw === undefined || unit === undefined) return null;
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) ? { value, unit } : null;
}

function isTitleCase(tokens: string[]): boolean {
  const words = tokens.filter((t) => /^\p{L}/u.test(t));
  if (words.length === 0) return false;
  // Short function words inside a name are allowed to stay lowercase.
  const minor = new Set(['of', 'the', 'de', 'van', 'von', 'da', 'del', 'and', 'bin', 'al']);
  return words.every((w, i) => {
    if (i > 0 && minor.has(w.toLowerCase())) return true;
    return /^\p{Lu}/u.test(w);
  });
}

/**
 * Whether the selection is the opening of its own sentence.
 *
 * Every sentence begins with a capital, so the capital on its first word
 * says nothing about whether that word is a name. Reading it as one is how
 * selecting `First` at the head of a paragraph produced the article for a
 * nineteenth-century watch manufacturer.
 */
export function startsSentence(text: string, sentence?: string): boolean {
  const around = sentence?.trim();
  if (!around || around.length <= text.length) return false;
  return around.startsWith(text);
}

export function extractSignals(text: string, page: PageContext = {}): Signals {
  const trimmed = text.trim();
  const tokens = tokenize(trimmed);
  const host = (page.host ?? '').toLowerCase();

  return {
    text: trimmed,
    tokens,
    tokenCount: tokens.length,
    charCount: trimmed.length,
    script: detectScript(trimmed),
    allLower: trimmed === trimmed.toLowerCase() && /\p{Ll}/u.test(trimmed),
    allCaps: trimmed === trimmed.toUpperCase() && /\p{Lu}/u.test(trimmed),
    titleCase: isTitleCase(tokens),
    hasDigit: /\d/.test(trimmed),
    identifierStyle: detectIdentifierStyle(trimmed),
    looksLikeUrl: /^(?:https?:\/\/|www\.)\S+$/i.test(trimmed),
    looksLikeDoi: /^(?:doi:)?10\.\d{4,9}\/\S+$/i.test(trimmed),
    looksLikeArxiv: /^(?:arxiv:)?\d{4}\.\d{4,5}(?:v\d+)?$/i.test(trimmed),
    looksLikeIsbn: /^(?:isbn[- ]?)?(?:\d[- ]?){9}[\dxX]$|^(?:\d[- ]?){13}$/i.test(trimmed),
    looksLikeHexColor: /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed),
    looksLikeIpAddress: /^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed),
    looksLikePackageVersion: /^[@\w][\w./-]*@\d[\w.-]*$/.test(trimmed),
    hasYearInParens: /\((?:1[5-9]|20)\d{2}\)/.test(trimmed),
    hasEpisodeCode: /\bS\d{1,2}E\d{1,2}\b/i.test(trimmed),
    hasHonorific: HONORIFICS.test(trimmed),
    atSentenceStart: startsSentence(trimmed, page.sentence),
    quantity: parseQuantity(trimmed),
    inCode: page.inCode === true,
    devHost: DEV_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)),
    ecosystems: detectEcosystems(page),
  };
}
