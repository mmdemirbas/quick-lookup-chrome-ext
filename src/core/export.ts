/**
 * Turning a finished card into text the reader can keep.
 *
 * Two properties are load-bearing:
 *
 * - **What is copied is what is shown.** The same slots are read, in the
 *   same order, with the same caps and the same suppression rules as
 *   `content/card-view.ts`. A copy that quietly contains more than the card
 *   did — or less — is worse than no copy button, because the reader has no
 *   reason to check it.
 * - **One reading, three renderings.** `blocksOf()` decides *what* leaves
 *   the card; the three formatters decide only *how* it is written. Adding
 *   a slot means touching the reader once, not three formatters that then
 *   drift apart.
 *
 * Everything here is pure. The date is passed in rather than read, so the
 * output is a function of its input and can be asserted exactly.
 */
import type { Card, Related, Sense, SlotId } from './types.ts';

export type ExportFormat = 'text' | 'markdown' | 'anki';

/** Where the lookup happened. All optional: a card can be exported without it. */
export type ExportContext = {
  url?: string;
  title?: string;
  /** Formatted by the caller, so this module needs no clock. */
  capturedAt?: string;
};

/** Caps, kept equal to the card view's own. See the note at the top. */
const MAX_SENSES = 6;
const MAX_RELATED = 14;
const MAX_FACTS = 8;
const MAX_PRONUNCIATIONS = 3;
const MAX_EXAMPLES = 3;

const LABEL: Partial<Record<SlotId, string>> = {
  senses: 'Definitions',
  examples: 'In use',
  inContext: 'Where you met it',
  related: 'Related',
  extract: 'Summary',
  onPage: 'On this page',
  facts: 'Facts',
};

/**
 * The card reduced to what a note needs.
 *
 * Deliberately not the slot list: `links` is navigation rather than content,
 * `headword` is the title, and an entity and an extract collapse into one
 * block the same way they do on screen.
 */
type Block =
  | { kind: 'lead'; text: string }
  | { kind: 'pronunciation'; items: string[] }
  | { kind: 'entity'; title: string; description?: string; extract?: string }
  | { kind: 'aside'; text: string }
  | { kind: 'senses'; label: string; items: Sense[] }
  | { kind: 'examples'; label: string; items: Array<{ text: string; translation?: string }> }
  | { kind: 'quotes'; label: string; items: string[] }
  | { kind: 'chips'; label: string; items: string[] }
  | { kind: 'pairs'; label: string; items: Array<{ label: string; value: string }> }
  | { kind: 'prose'; label: string; text: string }
  | { kind: 'translation'; lang: string; text: string; equivalents: string[] };

function slotOf(card: Card, id: SlotId): { state: string; data?: unknown } | undefined {
  return (card.slots as Record<string, { state: string; data?: unknown } | undefined>)[id];
}

function relatedChip(item: Related): string {
  return item.kind === 'synonym' || item.kind === 'antonym'
    ? `${item.word} (${item.kind})`
    : item.word;
}

export function blocksOf(card: Card): Block[] {
  const blocks: Block[] = [];

  for (const id of card.order) {
    const slot = slotOf(card, id);
    if (!slot || slot.state !== 'filled' || slot.data === undefined) continue;

    switch (id) {
      case 'headword':
      case 'links':
        break; // The title, and navigation. Neither belongs in a note.

      case 'gloss':
        blocks.push({ kind: 'lead', text: String(slot.data) });
        break;

      case 'pronunciation': {
        const items = (slot.data as Array<{ ipa?: string; dialect?: string }>)
          .slice(0, MAX_PRONUNCIATIONS)
          .flatMap((p) => (p.ipa ? [p.dialect ? `${p.dialect} ${p.ipa}` : p.ipa] : []));
        if (items.length > 0) blocks.push({ kind: 'pronunciation', items });
        break;
      }

      case 'senses': {
        const items = (slot.data as Sense[]).slice(0, MAX_SENSES);
        if (items.length > 0) {
          blocks.push({ kind: 'senses', label: LABEL.senses ?? id, items });
        }
        break;
      }

      case 'frequency': {
        // The band, not the raw figure: a note is read later, when "1.6 per
        // million" has no scale beside it to be compared against.
        const f = slot.data as { label: string };
        blocks.push({ kind: 'aside', text: f.label });
        break;
      }

      case 'examples': {
        const items = (slot.data as Array<{ text: string; translation?: string }>)
          .slice(0, MAX_EXAMPLES);
        if (items.length > 0) blocks.push({ kind: 'examples', label: LABEL.examples ?? id, items });
        break;
      }

      case 'inContext': {
        // The reason the sentence is on the card at all: a note read weeks
        // later has no page behind it, and the sentence is what says why
        // this word was worth writing down.
        const c = slot.data as { before: string; term: string; after: string };
        const sentence = `${c.before}${c.term}${c.after}`.trim();
        if (sentence) blocks.push({ kind: 'quotes', label: LABEL.inContext ?? id, items: [sentence] });
        break;
      }

      case 'onPage': {
        const items = slot.data as string[];
        if (items.length > 0) blocks.push({ kind: 'quotes', label: LABEL.onPage ?? id, items });
        break;
      }

      case 'related': {
        const items = (slot.data as Related[]).slice(0, MAX_RELATED).map(relatedChip);
        if (items.length > 0) blocks.push({ kind: 'chips', label: LABEL.related ?? id, items });
        break;
      }

      case 'facts': {
        const items = (slot.data as Array<{ label: string; value: string }>).slice(0, MAX_FACTS);
        if (items.length > 0) blocks.push({ kind: 'pairs', label: LABEL.facts ?? id, items });
        break;
      }

      case 'entity': {
        const entity = slot.data as { title: string; description?: string; extract?: string };
        blocks.push({
          kind: 'entity',
          title: entity.title,
          ...(entity.description ? { description: entity.description } : {}),
          ...(entity.extract ? { extract: entity.extract } : {}),
        });
        break;
      }

      case 'extract': {
        // The entity block already carries this paragraph, exactly as the
        // card suppresses the section when both are filled.
        if (slotOf(card, 'entity')?.state === 'filled') break;
        const extract = slot.data as { text: string };
        blocks.push({ kind: 'prose', label: LABEL.extract ?? id, text: extract.text });
        break;
      }

      case 'translation': {
        const t = slot.data as {
          text: string;
          lang: string;
          equivalents?: Array<{ word: string }>;
        };
        const words = (t.equivalents ?? []).map((w) => w.word);
        // Head-words that only repeat the translated line add nothing, the
        // same judgement the card makes before drawing the chips.
        const equivalents = t.text === words.join(', ') ? [] : words;
        blocks.push({ kind: 'translation', lang: t.lang, text: t.text, equivalents });
        break;
      }

      default:
        break;
    }
  }

  return blocks;
}

/** Links worth keeping in a note: where the prose actually came from. */
function referencesOf(card: Card): string[] {
  const urls: string[] = [];
  const entity = slotOf(card, 'entity');
  const extract = slotOf(card, 'extract');
  if (entity?.state === 'filled') {
    const url = (entity.data as { url?: string }).url;
    if (url) urls.push(url);
  }
  if (extract?.state === 'filled') {
    const url = (extract.data as { url?: string }).url;
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function sourcesOf(card: Card): string[] {
  return card.sources.filter((source) => source !== 'links');
}

/** Joins paragraphs, dropping the empty ones so no double blank line survives. */
function paragraphs(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join('\n\n');
}

function toText(card: Card, context: ExportContext): string {
  const parts: string[] = [`${card.query} (${card.intent})`];

  for (const block of blocksOf(card)) {
    switch (block.kind) {
      case 'lead':
        parts.push(block.text);
        break;
      case 'pronunciation':
        parts.push(block.items.join('  '));
        break;
      case 'entity':
        parts.push(
          paragraphs([
            block.description ? `${block.title} — ${block.description}` : block.title,
            block.extract,
          ]),
        );
        break;
      case 'senses':
        parts.push(
          [
            `${block.label}:`,
            ...block.items.map((sense, index) => {
              const pos = sense.partOfSpeech ? `(${sense.partOfSpeech}) ` : '';
              const example = sense.example ? `\n     "${sense.example}"` : '';
              return `  ${index + 1}. ${pos}${sense.definition}${example}`;
            }),
          ].join('\n'),
        );
        break;
      case 'aside':
        parts.push(block.text);
        break;
      case 'examples':
        parts.push(
          [
            `${block.label}:`,
            ...block.items.flatMap((example) => [
              `  "${example.text}"`,
              ...(example.translation ? [`    ${example.translation}`] : []),
            ]),
          ].join('\n'),
        );
        break;
      case 'quotes':
        parts.push([`${block.label}:`, ...block.items.map((s) => `  "${s}"`)].join('\n'));
        break;
      case 'chips':
        parts.push(`${block.label}: ${block.items.join(', ')}`);
        break;
      case 'pairs':
        parts.push(
          [
            `${block.label}:`,
            ...block.items.map((f) => `  ${f.label}: ${f.value}`),
          ].join('\n'),
        );
        break;
      case 'prose':
        parts.push(`${block.label}:\n  ${block.text}`);
        break;
      case 'translation':
        parts.push(
          [
            `${block.lang}: ${block.text}`,
            ...(block.equivalents.length > 0
              ? [`  also: ${block.equivalents.join(', ')}`]
              : []),
          ].join('\n'),
        );
        break;
    }
  }

  const sources = sourcesOf(card);
  const references = referencesOf(card);
  const from = [context.title, context.url].filter(Boolean).join(' — ');
  const footer = [
    sources.length > 0 ? `Sources: ${sources.join(', ')}` : undefined,
    ...references.map((url) => `Reference: ${url}`),
    from ? `From: ${from}${context.capturedAt ? ` (${context.capturedAt})` : ''}` : undefined,
  ].filter(Boolean);

  return paragraphs([...parts, footer.join('\n')]);
}

/**
 * Escapes the characters that would otherwise change how a source string
 * renders. Package descriptions carry backticks and brackets often enough
 * that leaving them raw mangles the note.
 */
export function escapeMarkdown(input: string): string {
  return input
    .replace(/([\\`*_[\]<>])/g, '\\$1')
    .replace(/^(\s*)([#>+-]|\d+\.)(\s)/gm, '$1\\$2$3');
}

function toMarkdown(card: Card, context: ExportContext): string {
  const parts: string[] = [`## ${escapeMarkdown(card.query)}`];
  const subtitle: string[] = [card.intent];

  for (const block of blocksOf(card)) {
    switch (block.kind) {
      case 'lead':
        parts.push(escapeMarkdown(block.text));
        break;
      case 'pronunciation':
        // Folded into the line under the heading rather than given a section
        // of its own, because on its own it is never what the note is for.
        subtitle.push(...block.items);
        break;
      case 'entity':
        parts.push(
          paragraphs([
            block.description
              ? `**${escapeMarkdown(block.title)}** — ${escapeMarkdown(block.description)}`
              : `**${escapeMarkdown(block.title)}**`,
            block.extract ? escapeMarkdown(block.extract) : undefined,
          ]),
        );
        break;
      case 'senses':
        parts.push(
          [
            `### ${block.label}`,
            '',
            // Numbered explicitly rather than with a repeated `1.`, so the
            // list still reads in order in a plain-text editor.
            ...block.items.map((sense, index) => {
              const pos = sense.partOfSpeech ? `*${escapeMarkdown(sense.partOfSpeech)}* ` : '';
              const example = sense.example ? `  \n   > ${escapeMarkdown(sense.example)}` : '';
              return `${index + 1}. ${pos}${escapeMarkdown(sense.definition)}${example}`;
            }),
          ].join('\n'),
        );
        break;
      case 'aside':
        // Beside the pronunciation on the line under the heading. On its own
        // it is never what the note is for, but it is worth having later.
        subtitle.push(block.text);
        break;
      case 'examples':
        parts.push(
          [
            `### ${block.label}`,
            '',
            // The blank line after each is load-bearing: consecutive `>`
            // lines merge into one quote, which would run every example
            // together with its own translation and the next sentence.
            ...block.items.flatMap((example) => [
              `> ${escapeMarkdown(example.text)}`,
              ...(example.translation ? [`>`, `> ${escapeMarkdown(example.translation)}`] : []),
              '',
            ]),
          ]
            .join('\n')
            .trimEnd(),
        );
        break;
      case 'quotes':
        parts.push(
          [`### ${block.label}`, '', ...block.items.map((s) => `> ${escapeMarkdown(s)}`)].join(
            '\n',
          ),
        );
        break;
      case 'chips':
        parts.push(`**${block.label}:** ${block.items.map(escapeMarkdown).join(', ')}`);
        break;
      case 'pairs':
        parts.push(
          [
            `### ${block.label}`,
            '',
            ...block.items.map(
              (f) => `- **${escapeMarkdown(f.label)}:** ${escapeMarkdown(f.value)}`,
            ),
          ].join('\n'),
        );
        break;
      case 'prose':
        parts.push(`### ${block.label}\n\n${escapeMarkdown(block.text)}`);
        break;
      case 'translation':
        parts.push(
          `**${escapeMarkdown(block.lang)}:** ${escapeMarkdown(block.text)}${
            block.equivalents.length > 0
              ? ` (${block.equivalents.map(escapeMarkdown).join(', ')})`
              : ''
          }`,
        );
        break;
    }
  }

  parts.splice(1, 0, `*${subtitle.map(escapeMarkdown).join(' · ')}*`);

  const sources = sourcesOf(card);
  const from = context.url
    ? `[${escapeMarkdown(context.title || context.url)}](${context.url})`
    : escapeMarkdown(context.title ?? '');
  const footer = [
    sources.length > 0 ? `Sources: ${sources.join(', ')}` : undefined,
    ...referencesOf(card).map((url) => `Reference: <${url}>`),
    from ? `From: ${from}${context.capturedAt ? ` — ${context.capturedAt}` : ''}` : undefined,
  ].filter(Boolean);

  return paragraphs([...parts, footer.length > 0 ? `---\n\n${footer.join('  \n')}` : undefined]);
}

/**
 * One tab-separated note, with the headers that make it import without
 * touching the options dialog.
 *
 * The header keys are Anki's own, supported from 2.1.54 onwards:
 * https://docs.ankiweb.net/importing/text-files.html#file-headers. Older
 * versions treat `#` lines as comments and ignore them, so the file still
 * imports once the separator is chosen by hand.
 *
 * The first field is the duplicate key, so looking a word up twice updates
 * the note instead of adding a second one.
 */
function toAnki(card: Card, context: ExportContext): string {
  const escapeHtml = (input: string): string =>
    input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const field = (input: string): string =>
    escapeHtml(input)
      .replace(/\t/g, ' ')
      // HTML collapses runs of spaces, and the indentation is what keeps a
      // numbered definition distinguishable from the line above it.
      .replace(/^ +/gm, (spaces) => '&nbsp;'.repeat(spaces.length))
      .replace(/\r?\n/g, '<br>')
      .trim();

  const back = toText(card, context)
    .split('\n')
    // The first line is the front of the card; repeating it on the back
    // turns every review into a giveaway.
    .slice(1)
    .join('\n')
    .trim();

  return ['#separator:Tab', '#html:true', '#tags:quick-lookup', `${field(card.query)}\t${field(back)}`].join(
    '\n',
  );
}

export function formatCard(
  card: Card,
  format: ExportFormat,
  context: ExportContext = {},
): string {
  switch (format) {
    case 'markdown':
      return toMarkdown(card, context);
    case 'anki':
      return toAnki(card, context);
    default:
      return toText(card, context);
  }
}
