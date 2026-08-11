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

const MAX_TOPIC_TERMS = 24;

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

/** The sentence around the selection, bounded so a long node stays cheap. */
function enclosingSentence(node: Node | null, selected: string): string | undefined {
  const text = node?.textContent;
  if (!text || text.length > 4000) return undefined;
  const at = text.indexOf(selected);
  if (at < 0) return undefined;
  const start = Math.max(0, text.lastIndexOf('.', at) + 1);
  const endMark = text.indexOf('.', at + selected.length);
  const end = endMark < 0 ? Math.min(text.length, at + 300) : endMark + 1;
  const sentence = text.slice(start, end).trim();
  return sentence.length > selected.length ? sentence : undefined;
}

/** Page profile plus whatever is true about this particular selection. */
export function contextForSelection(range: Range | null, selected: string): PageContext {
  const profile = pageProfile();
  if (!range) return profile;

  const anchor = range.startContainer;
  const heading = nearestHeading(anchor);
  const sentence = enclosingSentence(anchor, selected);

  return {
    ...profile,
    inCode: isCodeElement(anchor),
    ...(heading ? { nearestHeading: heading } : {}),
    ...(sentence ? { sentence } : {}),
  };
}
