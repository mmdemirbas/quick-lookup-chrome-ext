/**
 * What the page says about the selection.
 *
 * Profiled once per page and reused, because the expensive part — reading
 * headings and metadata — does not change while the reader scrolls. The
 * per-selection part is cheap and computed each time.
 *
 * Nothing here reads `innerText`, which would force a layout on every
 * lookup. Headings and metadata are enough to tell a database page from a
 * wedding page, which is the whole job.
 */
import type { PageContext } from '../core/types.ts';
import { contentWords } from '../core/text.ts';
import { findDefinitions } from '../core/page-definition.ts';
import { languageTag } from '../core/language.ts';

const MAX_TOPIC_TERMS = 24;

/**
 * Enough of a long page to contain its definitions, and bounded so a
 * pathological one cannot cost megabytes.
 */
const MAX_PAGE_CHARS = 200_000;

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

/**
 * Elements that end a sentence by ending a block.
 *
 * A heading does not finish with a full stop, so without this the heading
 * and the paragraph under it read as one sentence — which pushes the term
 * far enough from the start that it stops looking like the subject of its
 * own definition. Text inside one block is joined with a space, text across
 * two with a newline, and the extractor treats a newline as a sentence end.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

function blockOf(node: Node): Element | null {
  let el = node.parentElement;
  while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
  return el;
}

let pageTextCache: string | undefined;
let pageTextFor = '';

/**
 * The readable text of the page, built once and reused.
 *
 * A `TreeWalker` over text nodes rather than `innerText`, which would force
 * a layout. Built lazily on the first lookup, so a page the reader never
 * looks anything up on pays nothing at all.
 */
export function pageText(): string {
  if (pageTextCache !== undefined && pageTextFor === location.href) return pageTextCache;

  const walker = document.createTreeWalker(document.body ?? document, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      // The extension's own UI is not part of the page.
      if (parent.closest('quick-lookup-card, quick-lookup-hover, quick-lookup-handle')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const parts: string[] = [];
  let total = 0;
  let previousBlock: Element | null | undefined;
  while (total < MAX_PAGE_CHARS) {
    const node = walker.nextNode();
    if (!node) break;
    // Markup wraps prose at arbitrary points, so whitespace inside one text
    // node is never a sentence boundary. Collapsing it here is what lets a
    // newline mean "new block" downstream.
    const text = node.nodeValue?.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const block = blockOf(node);
    if (parts.length > 0) parts.push(block === previousBlock ? ' ' : '\n');
    previousBlock = block;
    parts.push(text);
    total += text.length + 1;
  }

  pageTextCache = parts.join('');
  pageTextFor = location.href;
  return pageTextCache;
}

function meta(name: string): string | undefined {
  const el =
    document.querySelector(`meta[name="${name}"]`) ??
    document.querySelector(`meta[property="og:${name}"]`);
  return el?.getAttribute('content')?.trim() || undefined;
}

/**
 * The distinctive vocabulary of the page.
 *
 * Terms are counted across the title, headings and description, so a word
 * that appears in several headings outranks one that appears once. The
 * result is small on purpose: it is used for overlap scoring, not search.
 */
function topicTerms(title: string, headings: string[], description?: string): string[] {
  const counts = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const word of contentWords(text)) {
      counts.set(word, (counts.get(word) ?? 0) + weight);
    }
  };
  add(title, 3);
  for (const heading of headings) add(heading, 2);
  if (description) add(description, 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOPIC_TERMS)
    .map(([word]) => word);
}

let cached: PageContext | undefined;
let cachedFor = '';

export function pageProfile(): PageContext {
  if (cached && cachedFor === location.href) return cached;

  const headings = [...document.querySelectorAll('h1, h2')]
    .slice(0, 20)
    .map((h) => h.textContent?.trim() ?? '')
    .filter(Boolean);

  const title = document.title || headings[0] || '';
  const description = meta('description');
  const siteName = meta('site_name');

  cached = {
    url: location.href,
    host: location.hostname,
    title,
    ...(siteName ? { siteName } : {}),
    ...(description ? { description } : {}),
    topicTerms: topicTerms(title, headings, description),
  };
  cachedFor = location.href;
  return cached;
}

/** Invalidates the profile. Single-page apps change the page without a reload. */
export function resetPageProfile(): void {
  cached = undefined;
  cachedFor = '';
  pageTextCache = undefined;
  pageTextFor = '';
}

function isCodeElement(node: Node | null): boolean {
  let el = node instanceof Element ? node : node?.parentElement;
  while (el) {
    const tag = el.tagName;
    if (tag === 'CODE' || tag === 'PRE' || tag === 'KBD' || tag === 'SAMP') return true;
    el = el.parentElement;
  }
  return false;
}

function nearestHeading(node: Node | null): string | undefined {
  let el = node instanceof Element ? node : node?.parentElement;
  while (el) {
    let sibling: Element | null = el.previousElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName)) {
        const text = sibling.textContent?.trim();
        if (text) return text;
      }
      sibling = sibling.previousElementSibling;
    }
    el = el.parentElement;
  }
  return undefined;
}

/**
 * What ends a sentence. A question and an exclamation are sentences too.
 *
 * Only the full stop counted before, so "What is a manifest? A manifest
 * lists data files." came back whole for a selection in the second half.
 */
const SENTENCE_END = new Set(['.', '?', '!']);

/**
 * The sentence around a known position in a string.
 *
 * Separated from the DOM so it can be tested against the strings it is
 * actually wrong on. `at` is a position, not a search: the caller knows
 * where the selection starts and this must not go looking for the first
 * occurrence of the same word.
 */
export function sentenceAround(text: string, selected: string, at: number): string | undefined {
  if (at < 0 || at >= text.length) return undefined;

  let start = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    if (SENTENCE_END.has(text[i] ?? '')) {
      start = i + 1;
      break;
    }
  }

  let end = -1;
  for (let i = at + selected.length; i < text.length; i += 1) {
    if (SENTENCE_END.has(text[i] ?? '')) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) {
    // No terminator at all, so this is a run of prose without punctuation.
    // Cut at a space rather than mid-word: the fragment is shown to a reader
    // and quoted into their notes.
    const limit = Math.min(text.length, at + 300);
    const space = text.lastIndexOf(' ', limit);
    end = space > at + selected.length ? space : limit;
  }

  const sentence = text.slice(start, end).trim();
  return sentence.length > selected.length ? sentence : undefined;
}

/** The sentence around the selection, bounded so a long node stays cheap. */
function enclosingSentence(
  node: Node | null,
  selected: string,
  offset?: number,
): string | undefined {
  const text = node?.textContent;
  if (!text || text.length > 4000) return undefined;

  // Where the selection actually starts, when that is knowable. Searching
  // for the text instead found the *first* occurrence, so selecting the
  // second "manifest" in "A manifest lists files. Each manifest belongs to a
  // snapshot." reported the first sentence — and that string is what the
  // card shows as where the word was met, what a note quotes, and what the
  // senses are ranked against. The offset only means characters when the
  // container is a text node; on an element it is a child index.
  const at =
    node?.nodeType === Node.TEXT_NODE && offset !== undefined && text.startsWith(selected, offset)
      ? offset
      : text.indexOf(selected);
  if (at < 0) return undefined;

  return sentenceAround(text, selected, at);
}

/**
 * What language the selected text is declared to be in.
 *
 * The nearest ancestor carrying a `lang` wins over the document's, because a
 * quotation in another language is exactly the case where the document's own
 * declaration is wrong — and it is also the case where knowing the language
 * matters most.
 */
function declaredLanguage(node: Node | null): string | undefined {
  const start = node instanceof Element ? node : node?.parentElement;
  const tagged = start?.closest('[lang]');
  return (
    languageTag(tagged?.getAttribute('lang')) ?? languageTag(document.documentElement.lang)
  );
}

/** Page profile plus whatever is true about this particular selection. */
export function contextForSelection(range: Range | null, selected: string): PageContext {
  const profile = pageProfile();
  const documentLanguage = languageTag(document.documentElement.lang);
  if (!range) return { ...profile, ...(documentLanguage ? { lang: documentLanguage } : {}) };

  const anchor = range.startContainer;
  const heading = nearestHeading(anchor);
  const sentence = enclosingSentence(anchor, selected, range.startOffset);
  const definitions = findDefinitions(selected, pageText()).map((d) => d.text);
  const lang = declaredLanguage(anchor);

  return {
    ...profile,
    inCode: isCodeElement(anchor),
    ...(heading ? { nearestHeading: heading } : {}),
    ...(sentence ? { sentence } : {}),
    ...(definitions.length ? { definitions } : {}),
    ...(lang ? { lang } : {}),
  };
}
