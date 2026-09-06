import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyResult, createCard, finalise } from './card.ts';
import { blocksOf, escapeMarkdown, formatCard } from './export.ts';
import type { Card } from './types.ts';

/** A technical lookup with the shape the card really produces. */
function manifestCard(): Card {
  const card = createCard('r1', 'manifest', 'technical');
  applyResult(card, 'stackexchange', {
    slots: {
      gloss: 'A metadata file that lists the data files making up a snapshot.',
      extract: {
        text: 'Manifests are the layer between a snapshot and its data files.',
        source: 'stackexchange',
        url: 'https://stackoverflow.com/questions/tagged/manifest',
      },
    },
  });
  applyResult(card, 'page', {
    slots: { onPage: ['A manifest is a metadata file that lists the data files.'] },
  });
  applyResult(card, 'npm', {
    slots: {
      facts: [
        { label: 'Version', value: '19.2.8', source: 'npm' },
        { label: 'License', value: 'MIT', source: 'npm' },
      ],
    },
  });
  return finalise(card);
}

const CONTEXT = {
  url: 'https://iceberg.apache.org/spec/',
  title: 'Iceberg Table Spec',
  capturedAt: '2026-08-14',
};

test('the plain text export carries the query, the gloss and every filled section', () => {
  const text = formatCard(manifestCard(), 'text', CONTEXT);
  assert.match(text, /^manifest \(technical\)/);
  assert.match(text, /A metadata file that lists the data files making up a snapshot\./);
  assert.match(text, /On this page:/);
  assert.match(text, /Facts:\n {2}Version: 19\.2\.8\n {2}License: MIT/);
  // Named, not listed by id. A copy leaves the extension, so it is the copy
  // that carries the attribution a source's terms ask for — and `npm` is
  // here to show that a source the table does not know is still printed.
  assert.match(text, /Sources: Stack Exchange, this page, npm/);
  assert.match(text, /From: Iceberg Table Spec — https:\/\/iceberg\.apache\.org\/spec\/ \(2026-08-14\)/);
});

test('a reference link is kept so the note can be traced back to its source', () => {
  const text = formatCard(manifestCard(), 'text', CONTEXT);
  assert.match(text, /Reference: https:\/\/stackoverflow\.com\/questions\/tagged\/manifest/);
});

test('exporting without page context omits the origin line rather than printing an empty one', () => {
  const text = formatCard(manifestCard(), 'text');
  assert.doesNotMatch(text, /From:/);
  assert.doesNotMatch(text, /\n\n\n/);
  assert.match(text, /Sources: /);
});

test('nothing is exported for a slot that never filled', () => {
  const card = createCard('r2', 'ephemeral', 'word');
  applyResult(card, 'wiktionary', { slots: { gloss: 'Lasting a very short time.' } });
  finalise(card);
  const text = formatCard(card, 'text');
  assert.match(text, /Lasting a very short time\./);
  assert.doesNotMatch(text, /Definitions/);
  assert.doesNotMatch(text, /Related/);
});

test('the export shows the same six senses the card shows, not all of them', () => {
  const card = createCard('r3', 'set', 'word');
  applyResult(card, 'wiktionary', {
    slots: {
      senses: Array.from({ length: 9 }, (_, i) => ({
        definition: `Sense number ${i + 1} of the word.`,
        source: 'wiktionary',
      })),
    },
  });
  finalise(card);
  const blocks = blocksOf(card);
  const senses = blocks.find((b) => b.kind === 'senses');
  assert.equal(senses?.kind === 'senses' ? senses.items.length : 0, 6);
  const text = formatCard(card, 'text');
  assert.match(text, /Sense number 6 of the word\./);
  assert.doesNotMatch(text, /Sense number 7 of the word\./);
});

test('a summary already shown inside the entity block is not repeated', () => {
  const card = createCard('r4', 'Apache Iceberg', 'entity');
  applyResult(card, 'wikipedia', {
    slots: {
      entity: {
        title: 'Apache Iceberg',
        description: 'Big data table format',
        extract: 'Apache Iceberg is a high-performance open-source format for large tables.',
        source: 'wikipedia',
        url: 'https://en.wikipedia.org/wiki/Apache_Iceberg',
      },
      extract: {
        text: 'Apache Iceberg is a high-performance open-source format for large tables.',
        source: 'wikipedia',
      },
    },
  });
  finalise(card);
  const text = formatCard(card, 'text');
  const occurrences = text.split('high-performance open-source format').length - 1;
  assert.equal(occurrences, 1);
  assert.match(text, /Apache Iceberg — Big data table format/);
});

test('dictionary head-words that only repeat the translated line are dropped', () => {
  const card = createCard('r5', 'ephemeral', 'word');
  applyResult(card, 'translator', {
    slots: {
      translation: {
        text: 'geçici, kısa ömürlü',
        lang: 'tr',
        source: 'translator',
        equivalents: [
          { word: 'geçici', source: 'wiktionary' },
          { word: 'kısa ömürlü', source: 'wiktionary' },
        ],
      },
    },
  });
  finalise(card);
  const text = formatCard(card, 'text');
  assert.match(text, /tr: geçici, kısa ömürlü/);
  assert.doesNotMatch(text, /also:/);
});

test('head-words that say something the translation does not are kept', () => {
  const card = createCard('r6', 'ephemeral', 'word');
  applyResult(card, 'translator', {
    slots: {
      translation: {
        text: 'geçici',
        lang: 'tr',
        source: 'translator',
        equivalents: [{ word: 'kısa ömürlü', source: 'wiktionary' }],
      },
    },
  });
  finalise(card);
  assert.match(formatCard(card, 'text'), /also: kısa ömürlü/);
});

test('markdown puts the query in a heading and the intent in the line beneath', () => {
  const markdown = formatCard(manifestCard(), 'markdown', CONTEXT);
  assert.match(markdown, /^## manifest\n\n\*technical\*/);
  assert.match(markdown, /### On this page\n\n> A manifest is a metadata file/);
  assert.match(markdown, /- \*\*Version:\*\* 19\.2\.8/);
  assert.match(markdown, /From: \[Iceberg Table Spec\]\(https:\/\/iceberg\.apache\.org\/spec\/\)/);
});

test('markdown numbers the senses explicitly so the raw text also reads in order', () => {
  const card = createCard('r9', 'set', 'word');
  applyResult(card, 'wiktionary', {
    slots: {
      senses: [
        { definition: 'To put something in a place.', source: 'wiktionary' },
        { definition: 'A collection of distinct things.', source: 'wiktionary' },
      ],
    },
  });
  finalise(card);
  const markdown = formatCard(card, 'markdown');
  assert.match(markdown, /1\. To put something in a place\./);
  assert.match(markdown, /2\. A collection of distinct things\./);
});

test('anki keeps the indentation that separates a definition from its heading', () => {
  const card = createCard('r10', 'set', 'word');
  applyResult(card, 'wiktionary', {
    slots: { senses: [{ definition: 'A collection of distinct things.', source: 'wiktionary' }] },
  });
  finalise(card);
  const back = (formatCard(card, 'anki').split('\n')[3] ?? '').split('\t')[1] ?? '';
  // HTML collapses real spaces, so the leading run has to survive as entities.
  assert.match(back, /Definitions:<br>&nbsp;&nbsp;1\. A collection of distinct things\./);
});

test('markdown escapes source text that would otherwise render as markup', () => {
  assert.equal(escapeMarkdown('use *args and _kwargs_'), 'use \\*args and \\_kwargs\\_');
  assert.equal(escapeMarkdown('see [the docs](x)'), 'see \\[the docs\\](x)');
  assert.equal(escapeMarkdown('- a leading dash'), '\\- a leading dash');
  assert.equal(escapeMarkdown('1. a numbered line'), '\\1. a numbered line');
  assert.equal(escapeMarkdown('a <tag> and `code`'), 'a \\<tag\\> and \\`code\\`');
});

test('a package description full of markup survives the round trip readably', () => {
  const card = createCard('r7', 'react-dom', 'technical');
  applyResult(card, 'npm', {
    slots: { gloss: 'React package for working with the DOM. See `ReactDOM.render()`.' },
  });
  finalise(card);
  const markdown = formatCard(card, 'markdown');
  assert.match(markdown, /See \\`ReactDOM\.render\(\)\\`/);
  // The plain text export must not carry the escapes.
  assert.match(formatCard(card, 'text'), /See `ReactDOM\.render\(\)`\./);
});

test('the anki export is three headers and one tab-separated note', () => {
  const anki = formatCard(manifestCard(), 'anki', CONTEXT);
  const lines = anki.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['#separator:Tab', '#html:true', '#tags:quick-lookup']);
  assert.equal(lines.length, 4, 'the note itself must be a single line');
  const [front, back, ...extra] = (lines[3] ?? '').split('\t');
  assert.equal(extra.length, 0, 'a stray tab would add a third field');
  assert.equal(front, 'manifest');
  assert.match(back ?? '', /A metadata file that lists the data files/);
  assert.match(back ?? '', /<br>/);
});

test('the anki front is not repeated on the back', () => {
  const anki = formatCard(manifestCard(), 'anki', CONTEXT);
  const back = (anki.split('\n')[3] ?? '').split('\t')[1] ?? '';
  assert.doesNotMatch(back, /^manifest \(technical\)/);
});

test('angle brackets and ampersands are escaped for anki, which reads fields as html', () => {
  const card = createCard('r8', 'AT&T', 'entity');
  applyResult(card, 'wikipedia', {
    slots: {
      entity: {
        title: 'AT&T',
        description: 'American telecommunications company',
        source: 'wikipedia',
      },
      gloss: 'Written <abbr>AT&T</abbr> in prose.',
    },
  });
  finalise(card);
  const anki = formatCard(card, 'anki');
  const [front, back] = (anki.split('\n')[3] ?? '').split('\t');
  assert.equal(front, 'AT&amp;T');
  assert.match(back ?? '', /&lt;abbr&gt;AT&amp;T&lt;\/abbr&gt;/);
});

/** A word card with the two sections the note used to drop on the floor. */
function ephemeralCard(): Card {
  const card = createCard('r2', 'ephemeral', 'word');
  applyResult(card, 'free-dictionary', {
    slots: {
      pronunciation: [{ ipa: '/ɪfˈɛməɹəl/', dialect: 'UK' }],
      senses: [{ definition: 'Lasting for a short period of time.', source: 'wiktionary' }],
    },
  });
  applyResult(card, 'datamuse', {
    slots: {
      frequency: { perMillion: 1.600203, band: 3, label: 'fairly common', source: 'datamuse' },
    },
  });
  applyResult(card, 'tatoeba', {
    slots: {
      examples: [
        {
          text: "Love's pleasure is ephemeral; regret eternal.",
          translation: 'Aşkın zevki geçicidir; pişmanlığı sonsuzdur.',
          source: 'tatoeba',
        },
        { text: 'Fame is ephemeral.', source: 'tatoeba' },
      ],
    },
  });
  return finalise(card);
}

test('a sentence and its translation survive being copied out', () => {
  // Both slots reach the note through an explicit case. The switch that
  // builds the blocks ends in `default: break`, so a slot nobody added a case
  // for is dropped in silence — the note simply comes out shorter.
  const text = formatCard(ephemeralCard(), 'text', CONTEXT);
  assert.match(text, /In use:\n {2}"Love's pleasure is ephemeral; regret eternal\."/);
  assert.match(text, /\n {4}Aşkın zevki geçicidir; pişmanlığı sonsuzdur\./);
  assert.match(text, /"Fame is ephemeral\."/);
  assert.match(text, /fairly common/, 'and how common the word is');
});

test('markdown quotes each example apart from the next', () => {
  const markdown = formatCard(ephemeralCard(), 'markdown', CONTEXT);
  // Consecutive `>` lines merge into one blockquote, so without the blank
  // line every example, its translation and the next sentence run together
  // into a single paragraph.
  assert.match(
    markdown,
    /### In use\n\n> Love's pleasure is ephemeral; regret eternal\.\n>\n> Aşkın zevki geçicidir; pişmanlığı sonsuzdur\.\n\n> Fame is ephemeral\./,
  );
  // The band joins the line under the heading rather than taking a section.
  assert.match(markdown, /^\*word · UK \/ɪfˈɛməɹəl\/ · fairly common\*$/m);
});

test('two sentences from the page are two quotations, not one', () => {
  // Consecutive `>` lines are a single blockquote paragraph in CommonMark,
  // so two sentences from different parts of the page ran together into one
  // continuous quotation in the note.
  const card = createCard('r1', 'manifest', 'technical');
  applyResult(card, 'page', {
    slots: {
      onPage: [
        'A manifest is a metadata file that lists the data files.',
        'Manifests are the layer between a snapshot and its data files.',
      ],
    },
  });
  finalise(card);

  const markdown = formatCard(card, 'markdown', { url: 'https://example.com/', title: 'Spec' });
  assert.match(markdown, />\s*\n>\s/, 'a blank quote line separates them');
});

test('the Anki front is one line, whatever was selected', () => {
  // The back is built by dropping the front's line count, so a selection
  // carrying a newline left the tail of the front sitting on the back.
  const card = createCard('r1', 'quick\nlookup', 'word');
  applyResult(card, 'page', { slots: { onPage: ['A quick lookup of a word.'] } });
  finalise(card);

  const anki = formatCard(card, 'anki', { url: 'https://example.com/', title: 'Spec' });
  const row = anki.split('\n').at(-1) ?? '';
  const [front, back] = row.split('\t');

  assert.equal(front, 'quick lookup', 'the front is the selection on one line');
  assert.doesNotMatch(back ?? '', /^lookup/, 'and the back does not open with its tail');
});
