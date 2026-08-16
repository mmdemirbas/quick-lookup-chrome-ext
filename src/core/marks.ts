/**
 * Identity marks for the sites a card links to and the sources it answered
 * from.
 *
 * A row of pills that all look alike has to be read word by word. A mark
 * gives the eye somewhere to land first, which is what makes "the orange one
 * is Stack Overflow" work from the second time onward.
 *
 * The marks are drawn, not fetched. A real favicon means either bundling
 * other people's logos or asking the browser for one per site, and both cost
 * more than they return here: a drawn mark also works on a page whose policy
 * blocks images, for a site never visited before, and in Firefox, which has
 * no favicon service to ask.
 *
 * Colour is never the only signal. The label sits beside the mark and the
 * letters differ, so a reader who cannot separate two hues loses nothing —
 * which is also why hues are chosen for distance from each other rather than
 * for resemblance to a brand.
 */

export type Mark = {
  /** One or two letters. Redundant with the label, deliberately. */
  letter: string;
  /** Degrees on the colour wheel. */
  hue: number;
  /** Percent. Low means near-grey, for the sources that are not websites. */
  sat: number;
};

const DEFAULT_SAT = 62;

/**
 * Hand-set, so a site looks the same everywhere it appears — the Wiktionary
 * link chip and the Wiktionary source in the footer are one site.
 *
 * Hues sit at least fifteen degrees apart unless two entries are the same
 * site family, in which case they are equal on purpose. A test holds both
 * halves of that rule.
 */
const SITES: Record<string, { letter: string; hue: number; sat?: number }> = {
  mdn: { letter: 'M', hue: 2 },
  stackoverflow: { letter: 'SO', hue: 25 },
  // Same company, same colour: the tags provider answers from the network
  // that Stack Overflow belongs to.
  stackexchange: { letter: 'SE', hue: 25 },
  imdb: { letter: 'IM', hue: 47 },
  'free-dictionary': { letter: 'FD', hue: 88 },
  datamuse: { letter: 'DM', hue: 112 },
  packs: { letter: 'PK', hue: 136 },
  tatoeba: { letter: 'TB', hue: 158 },
  translate: { letter: 'Tr', hue: 186 },
  scholar: { letter: 'GS', hue: 205 },
  google: { letter: 'G', hue: 228 },
  wikipedia: { letter: 'W', hue: 250 },
  wiktionary: { letter: 'Wk', hue: 272 },
  registry: { letter: 'RG', hue: 296 },
  github: { letter: 'GH', hue: 318 },
  thesaurus: { letter: 'Th', hue: 340 },
  // Not a website: the page already open. Near-grey says so before the
  // letter does, and keeps the one source that cost nothing from competing
  // with the ones that did.
  page: { letter: 'P', hue: 228, sat: 10 },
};

/**
 * Host suffixes, so a link no one wrote a table entry for still gets the
 * right mark. Providers mint link ids of their own — `mdn-doc`, or one per
 * Stack Overflow tag — and those are the ones this catches.
 *
 * Longest first, because `translate.google.com` and `google.com` both match
 * a Google Translate link and only one of them is right.
 */
const HOST_SITES: Array<[string, string]> = [
  ['translate.google.com', 'translate'],
  ['scholar.google.com', 'scholar'],
  ['developer.mozilla.org', 'mdn'],
  ['stackoverflow.com', 'stackoverflow'],
  ['stackexchange.com', 'stackexchange'],
  ['thesaurus.com', 'thesaurus'],
  ['wiktionary.org', 'wiktionary'],
  ['wikipedia.org', 'wikipedia'],
  ['google.com', 'google'],
  ['github.com', 'github'],
  ['tatoeba.org', 'tatoeba'],
  ['imdb.com', 'imdb'],
  ['npmjs.com', 'registry'],
  ['pypi.org', 'registry'],
  ['crates.io', 'registry'],
];

const HOSTS = [...HOST_SITES].sort((a, b) => b[0].length - a[0].length);

function siteForHost(host: string): string | undefined {
  const lower = host.toLowerCase();
  for (const [suffix, id] of HOSTS) {
    if (lower === suffix || lower.endsWith(`.${suffix}`)) return id;
  }
  return undefined;
}

/** Stable across runs and across machines: the same id is always the same colour. */
function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** Two letters at most: a monogram stays readable at nine pixels, a word does not. */
function initialsOf(text: string): string {
  const parts = text.split(/[-_. ]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}

/**
 * The mark for a source id, or for a link — pass the link's URL and a site
 * the table does not name is still recognised by where it points.
 */
export function markFor(id: string, url?: string): Mark {
  const named = SITES[id];
  if (named) return { letter: named.letter, hue: named.hue, sat: named.sat ?? DEFAULT_SAT };

  if (url) {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      // A link with an unparseable URL still gets a mark, from its id.
    }
    const site = host ? siteForHost(host) : undefined;
    const known = site ? SITES[site] : undefined;
    if (known) return { letter: known.letter, hue: known.hue, sat: known.sat ?? DEFAULT_SAT };
    if (host) return { letter: initialsOf(host.replace(/^www\./, '')), hue: hueOf(host), sat: DEFAULT_SAT };
  }

  return { letter: initialsOf(id), hue: hueOf(id), sat: DEFAULT_SAT };
}

/** Exported for the test that guards the table's spacing rule. */
export function namedMarks(): Array<[string, Mark]> {
  return Object.entries(SITES).map(([id, mark]) => [
    id,
    { letter: mark.letter, hue: mark.hue, sat: mark.sat ?? DEFAULT_SAT },
  ]);
}
