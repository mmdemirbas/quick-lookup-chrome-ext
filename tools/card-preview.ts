/**
 * Renders the card outside the extension, for visual and layout checking.
 *
 * `CardView` touches nothing but the DOM, so it can be mounted on a plain
 * page. That makes the riskiest part of the UI — placement, overflow,
 * theming, and the skeleton-to-content transition — checkable without
 * loading the extension into a browser profile.
 *
 * Built by `npm run preview`, which writes dist/preview and serves nothing;
 * open dist/preview/index.html directly.
 */
import { CardView } from '../src/content/card-view.ts';
import { HoverLookup } from '../src/content/hover.ts';
import { applyResult, createCard, finalise } from '../src/core/card.ts';
import { linksFor } from '../src/core/providers/links.ts';
import type { Card } from '../src/core/types.ts';

function wordCard(): Card {
  const card = createCard('preview-word', 'ephemeral', 'word');
  applyResult(card, 'free-dictionary', {
    slots: {
      headword: 'ephemeral',
      pronunciation: [{ ipa: '/ɛˈfɛ.mə.ɹəl/', dialect: 'UK' }, { ipa: '/əˈfɛm(ə)rəl/', dialect: 'US' }],
      senses: [
        {
          partOfSpeech: 'adjective',
          definition: 'Lasting for a short period of time.',
          example: 'the ephemeral fashions of the day',
          source: 'freedictionaryapi.com',
        },
        {
          partOfSpeech: 'adjective',
          definition: 'Existing for only one day, as with some flowers, insects, and diseases.',
          source: 'freedictionaryapi.com',
        },
        {
          partOfSpeech: 'noun',
          definition: 'Something which lasts for a short period of time.',
          source: 'en.wiktionary.org',
        },
      ],
      related: [
        { word: 'transitory', kind: 'synonym', source: 'datamuse' },
        { word: 'fleeting', kind: 'synonym', source: 'datamuse' },
        { word: 'short-lived', kind: 'synonym', source: 'datamuse' },
        { word: 'evanescent', kind: 'synonym', source: 'datamuse' },
        { word: 'permanent', kind: 'antonym', source: 'freedictionaryapi.com' },
        { word: 'eternal', kind: 'antonym', source: 'freedictionaryapi.com' },
        { word: 'ephemeral nature', kind: 'collocation', source: 'datamuse' },
        { word: 'ephemeral stream', kind: 'collocation', source: 'datamuse' },
      ],
      translation: { text: 'kısa ömürlü, geçici', lang: 'tr', source: 'on-device' },
      links: linksFor('word', 'ephemeral', 'en'),
    },
  });
  return finalise(card, []);
}

function entityCard(): Card {
  const card = createCard('preview-entity', 'Alan Turing', 'entity');
  applyResult(card, 'wikipedia', {
    slots: {
      entity: {
        title: 'Alan Turing',
        description: 'English computer scientist (1912–1954)',
        extract:
          'Alan Mathison Turing was an English mathematician, computer scientist, logician and cryptanalyst. He was highly influential in the development of theoretical computer science.',
        imageUrl:
          'data:image/svg+xml;utf8,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="66" height="66"><rect width="66" height="66" fill="#c7c7d4"/><text x="33" y="40" font-size="26" text-anchor="middle" fill="#5c5c6b">AT</text></svg>',
          ),
        source: 'wikipedia',
      },
      facts: [
        { label: 'Born', value: '23 June 1912', source: 'wikidata' },
        { label: 'Died', value: '7 June 1954', source: 'wikidata' },
        { label: 'Field', value: 'Computer science', source: 'wikidata' },
      ],
      links: linksFor('entity', 'Alan Turing', 'en'),
    },
  });
  return finalise(card, []);
}

/**
 * The technical layout, with the payloads the real sources returned for
 * `webpack` on a JavaScript page: a definition from the tag wiki, a
 * paragraph beneath it, and the package facts alongside.
 */
function technicalCard(): Card {
  const card = createCard('preview-technical', 'webpack', 'technical');
  applyResult(card, 'stackexchange', {
    slots: {
      gloss: 'Webpack is a module bundler.',
      extract: {
        text: 'Webpack is a module bundler. Its main purpose is to bundle JavaScript files for usage in a browser, yet it can also transform, bundle, or package just about any resource or asset.',
        source: 'stackexchange',
        url: 'https://stackoverflow.com/questions/tagged/webpack',
      },
      links: [
        {
          id: 'so-tag-webpack',
          label: 'Tagged webpack',
          url: 'https://stackoverflow.com/questions/tagged/webpack',
        },
      ],
    },
  });
  applyResult(card, 'registry', {
    slots: {
      facts: [
        { label: 'Version', value: '5.109.2', source: 'npm' },
        { label: 'License', value: 'MIT', source: 'npm' },
      ],
      links: [
        { id: 'npm-package', label: 'npm', url: 'https://www.npmjs.com/package/webpack' },
        { id: 'npm-homepage', label: 'Homepage', url: 'https://github.com/webpack/webpack' },
      ],
    },
  });
  applyResult(card, 'page', {
    slots: {
      onPage: ['Webpack is configured with a single webpack.config.js at the project root.'],
    },
  });
  applyResult(card, 'links', { slots: { links: linksFor('technical', 'webpack', 'en') } });
  return finalise(card, []);
}

/** A long word with no spaces, to prove the header cannot burst the card. */
function overflowCard(): Card {
  const query = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
  const card = createCard('preview-overflow', query, 'word');
  applyResult(card, 'free-dictionary', {
    slots: {
      senses: [
        {
          partOfSpeech: 'noun',
          definition:
            'An invented long word said to mean a lung disease caused by inhaling very fine silica dust, used chiefly as an example of a very long word.',
          source: 'en.wiktionary.org',
        },
      ],
      links: linksFor('word', query, 'en'),
    },
  });
  return finalise(card, []);
}

const SAMPLES: Array<{ id: string; label: string; build: () => Card }> = [
  { id: 'word', label: 'Word', build: wordCard },
  { id: 'entity', label: 'Entity', build: entityCard },
  { id: 'technical', label: 'Technical', build: technicalCard },
  { id: 'overflow', label: 'Long headword', build: overflowCard },
];

const view = new CardView({
  onClose: () => view.hide(),
  onQuietSite: () => view.hide(),
  onEngage: () => {},
});

function show(id: string): void {
  const sample = SAMPLES.find((s) => s.id === id);
  const anchor = document.getElementById('anchor');
  if (!sample || !anchor) return;
  if (id === 'pending') {
    view.renderPending('loading…');
  } else {
    view.render(sample.build());
  }
  view.showAt(anchor.getBoundingClientRect());
}

const bar = document.getElementById('controls');
for (const sample of SAMPLES) {
  const button = document.createElement('button');
  button.textContent = sample.label;
  button.dataset.sample = sample.id;
  button.addEventListener('click', () => show(sample.id));
  bar?.append(button);
}
const pendingButton = document.createElement('button');
pendingButton.textContent = 'Skeleton';
pendingButton.dataset.sample = 'pending';
pendingButton.addEventListener('click', () => {
  view.renderPending('ephemeral');
  const anchor = document.getElementById('anchor');
  if (anchor) view.showAt(anchor.getBoundingClientRect());
});
bar?.append(pendingButton);

// Hover trigger, mounted over the prose on this page so the caret
// resolution, the overlay and the arrow-key span resize can be driven by an
// automated check rather than only by hand.
const hoverLog: Array<{ text: string; rect: DOMRect }> = [];
new HoverLookup({
  enabled: () => true,
  modifier: () => 'alt',
  onLookup: (text, rect) => {
    hoverLog.push({ text, rect });
    const readout = document.getElementById('hover-readout');
    if (readout) readout.textContent = text;
  },
  onCancel: () => {},
});

// Exposed so an automated check can drive the harness without clicking.
Object.assign(globalThis as object, {
  showSample: show,
  hoverLog,
  hoverBoxes: () =>
    [...(document.querySelector('quick-lookup-hover')?.shadowRoot?.querySelectorAll('.box') ?? [])]
      .map((b) => (b as HTMLElement).getBoundingClientRect()),
});

show('word');
