/**
 * Deep links, chosen by intent. No network, so this slot is always filled
 * and the card is never empty even when every source fails.
 */
import type { Intent, LinkTarget, Provider, ProviderResult } from '../types.ts';

type Template = { id: string; label: string; url: (q: string, lang: string) => string };

const ALL: Record<string, Template> = {
  google: {
    id: 'google',
    label: 'Google',
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  wikipedia: {
    id: 'wikipedia',
    label: 'Wikipedia',
    url: (q, lang) =>
      `https://${lang}.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
  },
  wiktionary: {
    id: 'wiktionary',
    label: 'Wiktionary',
    url: (q, lang) => `https://${lang}.wiktionary.org/wiki/${encodeURIComponent(q)}`,
  },
  thesaurus: {
    id: 'thesaurus',
    label: 'Thesaurus',
    url: (q) => `https://www.thesaurus.com/browse/${encodeURIComponent(q)}`,
  },
  translate: {
    id: 'translate',
    label: 'Translate',
    url: (q, lang) =>
      `https://translate.google.com/?sl=auto&tl=${lang}&text=${encodeURIComponent(q)}&op=translate`,
  },
  mdn: {
    id: 'mdn',
    label: 'MDN',
    url: (q) => `https://developer.mozilla.org/search?q=${encodeURIComponent(q)}`,
  },
  stackoverflow: {
    id: 'stackoverflow',
    label: 'Stack Overflow',
    url: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
  },
  github: {
    id: 'github',
    label: 'GitHub',
    url: (q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`,
  },
  imdb: {
    id: 'imdb',
    label: 'IMDb',
    url: (q) => `https://www.imdb.com/find/?q=${encodeURIComponent(q)}`,
  },
  scholar: {
    id: 'scholar',
    label: 'Scholar',
    url: (q) => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`,
  },
};

const BY_INTENT: Record<Intent, string[]> = {
  word: ['wiktionary', 'thesaurus', 'translate', 'google'],
  phrase: ['google', 'wiktionary', 'translate'],
  entity: ['wikipedia', 'google', 'imdb'],
  technical: ['mdn', 'stackoverflow', 'github', 'google'],
  citation: ['scholar', 'google'],
  quantity: ['google'],
  foreign: ['translate', 'wiktionary', 'google'],
  unknown: ['google', 'wikipedia'],
};

export function linksFor(intent: Intent, query: string, lang: string): LinkTarget[] {
  const ids = BY_INTENT[intent] ?? BY_INTENT.unknown;
  const out: LinkTarget[] = [];
  for (const id of ids) {
    const template = ALL[id];
    if (!template) continue;
    out.push({ id: template.id, label: template.label, url: template.url(query, lang) });
  }
  return out;
}

export function makeLinksProvider(intent: Intent): Provider {
  return {
    id: 'links',
    label: 'Quick links',
    intents: [intent],
    slots: ['links'],
    deadlineMs: 0,
    async run(request, context): Promise<ProviderResult> {
      const lang = context.uiLang.split('-')[0] || 'en';
      return { slots: { links: linksFor(intent, request.text, lang) } };
    },
  };
}
