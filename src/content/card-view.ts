/**
 * The card, rendered into a shadow root.
 *
 * Three properties matter more than anything cosmetic here:
 *
 * - It never moves the page. The host is fixed-position and carries
 *   `contain`, so nothing it does can reflow the document.
 * - It never covers the selection, and never runs off the screen. Placement
 *   prefers below the selected rect, flips above when there is more room
 *   there, and caps its own height to the space it was given.
 * - It never takes focus. The page keeps the caret and the keyboard.
 *
 * Every value from a source is inserted with `textContent`. No source
 * string is ever parsed as markup.
 */
import type { Card, Related, Sense, SlotId } from '../core/types.ts';
import { formatCard, type ExportContext, type ExportFormat } from '../core/export.ts';
import { speakable, utteranceLanguage } from '../core/speech.ts';
import type { Frequency } from '../core/frequency.ts';

const GAP = 10;
const MARGIN = 8;
const WIDTH = 380;

/**
 * The least the card may be squeezed to before it stops trying to avoid the
 * selection. Below this it is a scrollbar with a border, so overlapping the
 * selected line is the better trade.
 */
const MIN_HEIGHT = 150;

const STYLE = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483646;
  contain: layout paint style;
}
* { box-sizing: border-box; }
.card {
  --bg: #ffffff;
  --surface: #f6f6f9;
  --text: #17171c;
  --soft: #5c5c6b;
  --faint: #8b8b99;
  --border: #e2e2ea;
  --accent: #4f46e5;
  --warn: #b45309;
  --shadow: 0 8px 28px rgba(16, 16, 32, .16), 0 1px 3px rgba(16, 16, 32, .1);
  width: ${WIDTH}px;
  /* Replaced inline by the placer with the room actually available. This
     value only applies when the card is rendered without an anchor, which
     is what the preview harness does. */
  max-height: 60vh;
  overflow: hidden auto;
  overscroll-behavior: contain;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  font: 400 13.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  animation: appear .12s ease-out;
}
@media (prefers-color-scheme: dark) {
  .card {
    --bg: #16161c;
    --surface: #1f1f28;
    --text: #ececf2;
    --soft: #a9a9ba;
    --faint: #7d7d8f;
    --border: #2e2e3a;
    --accent: #a5a0ff;
    --warn: #f0b25e;
    --shadow: 0 8px 28px rgba(0, 0, 0, .5), 0 1px 3px rgba(0, 0, 0, .4);
  }
}
@keyframes appear { from { opacity: 0; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }

header {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 10px 9px 13px;
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg); z-index: 1;
  user-select: none;
}
/* Everything below the header is an answer, and answers get copied out. */
.body, footer { user-select: text; }
.query { font-weight: 600; font-size: 14px; flex: 1; overflow-wrap: anywhere; }
.intent {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--faint); border: 1px solid var(--border);
  border-radius: 999px; padding: 1px 7px; white-space: nowrap;
}
button.icon {
  border: 0; background: transparent; color: var(--faint);
  cursor: pointer; border-radius: 6px; padding: 3px 6px; font-size: 14px; line-height: 1;
}
button.icon:hover { background: var(--surface); color: var(--text); }
button.icon:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.body { padding: 4px 13px 12px; }
section { padding: 8px 0; border-top: 1px solid var(--border); }
section:first-child { border-top: 0; }
/* Pronunciation and frequency are both one short line identifying the word.
   A rule between them gives a five-pixel bar the same weight as Definitions
   and makes the top of the card read as three stacked strips. */
section.tight { border-top: 0; padding-top: 0; }
section[hidden] { display: none; }
.label {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--faint); margin-bottom: 5px;
}

.gloss { font-size: 15px; line-height: 1.45; }
.ipa { color: var(--soft); font-size: 13px; }
.ipa span + span { margin-left: 10px; }
.frequency { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--soft); }
.frequency .bar { display: inline-flex; gap: 2px; }
.frequency .bar span {
  width: 9px; height: 6px; border-radius: 1px;
  background: var(--border);
}
.frequency .bar span.on { background: var(--accent); }
.frequency .band { letter-spacing: .01em; }

ol.senses { margin: 0; padding-left: 18px; }
ol.senses li { margin-bottom: 7px; }
ol.senses li:last-child { margin-bottom: 0; }
.pos { color: var(--accent); font-style: italic; margin-right: 5px; }
.example { display: block; color: var(--soft); font-style: italic; margin-top: 2px; }
.origin { color: var(--faint); font-size: 11px; margin-left: 4px; }

/* A sentence lifted from the page, marked as quoted so it is not mistaken
   for the extension's own words. */
.quote {
  margin: 0 0 6px; padding-left: 9px;
  border-left: 2px solid var(--border); color: var(--soft);
}
.quote:last-child { margin-bottom: 0; }

.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  border: 1px solid var(--border); border-radius: 999px;
  padding: 2px 9px; font-size: 12px; color: var(--soft);
  background: var(--surface); text-decoration: none; display: inline-block;
}
a.chip:hover { border-color: var(--accent); color: var(--accent); }
button.chip { font: inherit; font-size: 12px; cursor: pointer; }
button.chip:hover { border-color: var(--accent); color: var(--accent); }
button.chip[data-state='done'] { border-color: var(--accent); color: var(--accent); }
button.chip[data-state='failed'] { border-color: var(--warn); color: var(--warn); }
.chip.synonym { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); color: var(--accent); }
.chip.antonym { border-color: color-mix(in srgb, var(--warn) 40%, var(--border)); color: var(--warn); }

.entity { display: flex; gap: 11px; align-items: flex-start; }
.entity img {
  width: 66px; height: 66px; object-fit: cover;
  border-radius: 8px; border: 1px solid var(--border); flex: none; background: var(--surface);
}
.entity h3 { margin: 0 0 2px; font-size: 14px; }
.entity p { margin: 0; color: var(--soft); }

.translation { color: var(--soft); }
.translation .lang { font-size: 11px; color: var(--faint); margin-right: 6px; text-transform: uppercase; }
button.icon.say { font-size: 12px; padding: 1px 4px; vertical-align: baseline; margin-left: 4px; }

footer {
  padding: 7px 13px 9px; border-top: 1px solid var(--border);
  color: var(--faint); font-size: 11px;
  display: flex; justify-content: space-between; gap: 8px;
}

.skeleton { height: 13px; border-radius: 4px; background: var(--surface); margin-bottom: 6px; }
.skeleton:nth-child(2) { width: 82%; }
.skeleton:nth-child(3) { width: 64%; }
@keyframes pulse { 50% { opacity: .55; } }
.pending .skeleton { animation: pulse 1.1s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .pending .skeleton { animation: none; } }
`;

const SLOT_LABEL: Partial<Record<SlotId, string>> = {
  senses: 'Definitions',
  related: 'Related',
  links: 'Look up in',
  extract: 'Summary',
  onPage: 'On this page',
  facts: 'Facts',
};

export type CardViewCallbacks = {
  onClose(): void;
  onQuietSite(): void;
  onEngage(): void;
};

/** The formats offered, in the order they appear on the card. */
const FORMATS: Array<{ format: ExportFormat; label: string; hint: string }> = [
  { format: 'text', label: 'Text', hint: 'Copy as plain text' },
  { format: 'markdown', label: 'Markdown', hint: 'Copy as Markdown (Alt+C)' },
  { format: 'anki', label: 'Anki', hint: 'Copy as an Anki note, tab separated' },
];

/** How long a button says what it just did before going back to its name. */
const FEEDBACK_MS = 1400;

/**
 * Where the lookup happened, so a note can be traced back to the page that
 * prompted it. Read at copy time rather than at render time, because a
 * single-page navigation can change the URL under an open card.
 */
function exportContext(): ExportContext {
  return {
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString().slice(0, 10),
  };
}

/**
 * Puts text on the clipboard, preferring the async API.
 *
 * The fallback is not superstition: `navigator.clipboard` rejects in a few
 * real situations a content script lands in, including a document that is
 * not the active one and some cross-origin frames. `execCommand` is
 * deprecated but still accepted in exactly those places.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  (document.body ?? document.documentElement).append(area);

  // The whole extension is driven by the reader's selection, so losing it
  // as a side effect of copying would be a visible regression.
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();

  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return copied;
}

/**
 * Speaks a string, cancelling whatever was being said.
 *
 * Cancelling first rather than queueing: pressing the button twice means
 * "say it again", never "say it twice". Returns false when the browser has
 * no speech engine or the text is not worth speaking, so the caller can
 * leave the control off the card rather than offer one that does nothing.
 */
function speak(text: string, lang: string): boolean {
  const engine = window.speechSynthesis;
  if (!engine || typeof SpeechSynthesisUtterance !== 'function' || !speakable(text)) return false;
  engine.cancel();
  const utterance = new SpeechSynthesisUtterance(text.trim());
  utterance.lang = lang;
  engine.speak(utterance);
  return true;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class CardView {
  #host: HTMLElement | undefined;
  #root: ShadowRoot | undefined;
  #card: HTMLElement | undefined;
  #body: HTMLElement | undefined;
  #footer: HTMLElement | undefined;
  #title: HTMLElement | undefined;
  #intent: HTMLElement | undefined;
  #engaged = false;
  /** The selection the card is placed against, kept so it can be re-placed. */
  #anchor: DOMRect | undefined;
  /** The card on screen. Held so it can be copied without asking for it again. */
  #current: Card | undefined;
  #actionButtons = new Map<ExportFormat, HTMLButtonElement>();
  #speaker: HTMLButtonElement | undefined;

  constructor(private readonly callbacks: CardViewCallbacks) {}

  get isOpen(): boolean {
    return this.#host?.isConnected === true && this.#host.style.display !== 'none';
  }

  /** True when the node is inside this card, so selections in it are ignored. */
  contains(node: Node | null): boolean {
    if (!node || !this.#host) return false;
    return this.#host.contains(node) || this.#root?.contains(node) === true;
  }

  #ensure(): void {
    if (this.#host) return;

    const host = document.createElement('quick-lookup-card');
    host.style.display = 'none';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;

    const card = el('div', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Quick Lookup result');

    const header = el('header');
    const title = el('div', 'query');
    const intent = el('span', 'intent');

    // Next to the word it pronounces, not in a toolbar: the reader should
    // never have to work out which control acts on which text.
    const speaker = el('button', 'icon', '🔊');
    speaker.title = 'Read this aloud';
    speaker.setAttribute('aria-label', 'Read this aloud');
    speaker.addEventListener('click', () => this.speakQuery());

    const quiet = el('button', 'icon', '⃠');
    quiet.title = 'Stop opening automatically on this site';
    quiet.setAttribute('aria-label', 'Stop opening automatically on this site');
    quiet.addEventListener('click', () => {
      this.#engaged = true;
      this.callbacks.onQuietSite();
    });

    const close = el('button', 'icon', '✕');
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.callbacks.onClose());

    header.append(title, intent, speaker, quiet, close);
    this.#speaker = speaker;

    const body = el('div', 'body');
    const footer = el('footer');
    card.append(header, body, footer);

    // The header is chrome, so pressing it must not disturb the reader's
    // selection. The body and footer are content, and content is selectable:
    // an answer you cannot drag across is an answer you have to retype.
    // Selections inside the card are ignored by the trigger, so this cannot
    // start a second lookup — that guard lives in `core/trigger.ts`.
    header.addEventListener('mousedown', (event) => event.preventDefault());
    card.addEventListener('pointerdown', () => this.#engage());
    card.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });

    root.append(style, card);
    document.documentElement.append(host);

    this.#host = host;
    this.#root = root;
    this.#card = card;
    this.#body = body;
    this.#footer = footer;
    this.#title = title;
    this.#intent = intent;
  }

  #engage(): void {
    if (this.#engaged) return;
    this.#engaged = true;
    this.callbacks.onEngage();
  }

  /** Anchors the card to a selection and shows it. */
  showAt(rect: DOMRect): void {
    this.#ensure();
    if (!this.#host) return;
    this.#anchor = rect;
    this.#host.style.display = 'block';
    this.#place();
  }

  /**
   * Places the card against its anchor and sizes it to the space there.
   *
   * Run again after every render, which is the part that was missing. The
   * card is placed while it is still a three-line skeleton, because showing
   * something immediately is the whole point of the skeleton — so a card
   * anchored 200px from the foot of the window was measured at 60px, given a
   * top that fitted, and then grew to 500px once the providers answered.
   * Everything past the window edge was unreachable: the card scrolls
   * internally, so the page scrollbar could not bring it back either.
   *
   * Placing again on each render also keeps the card still. Position and
   * height only change when the space the card needs has actually changed.
   */
  #place(): void {
    const host = this.#host;
    const card = this.#card;
    const anchor = this.#anchor;
    if (!host || !card || !anchor || host.style.display === 'none') return;

    // Measured unconstrained, so the choice is made on the height the card
    // wants rather than on the cap it was last given.
    card.style.maxHeight = '';
    const wanted = card.getBoundingClientRect().height || MIN_HEIGHT;

    const roomBelow = window.innerHeight - anchor.bottom - GAP - MARGIN;
    const roomAbove = anchor.top - GAP - MARGIN;

    // Below is preferred because reading continues downward. Above wins only
    // when it can show more of the card than below can.
    const goBelow = wanted <= roomBelow || roomBelow >= roomAbove;
    const room = Math.max(MIN_HEIGHT, goBelow ? roomBelow : roomAbove);
    const height = Math.min(wanted, room, window.innerHeight - 2 * MARGIN);

    card.style.maxHeight = `${Math.round(height)}px`;

    const top = goBelow
      ? Math.min(anchor.bottom + GAP, window.innerHeight - height - MARGIN)
      : Math.max(MARGIN, anchor.top - GAP - height);

    const left = Math.min(
      Math.max(MARGIN, anchor.left),
      Math.max(MARGIN, window.innerWidth - WIDTH - MARGIN),
    );

    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(Math.max(MARGIN, top))}px`;
  }

  hide(): void {
    if (this.#host) this.#host.style.display = 'none';
    this.#anchor = undefined;
    this.#engaged = false;
  }

  destroy(): void {
    this.#host?.remove();
    this.#host = undefined;
  }

  /** Draws a skeleton immediately, before any provider has answered. */
  renderPending(query: string): void {
    this.#ensure();
    if (!this.#title || !this.#body || !this.#intent || !this.#footer) return;
    this.#current = undefined;
    this.#actionButtons.clear();
    this.#title.textContent = query;
    this.#showSpeaker(query);
    this.#intent.textContent = '';
    this.#footer.textContent = '';
    this.#body.replaceChildren(this.#skeletonSection());
    this.#place();
  }

  #skeletonSection(): HTMLElement {
    const section = el('section', 'pending');
    section.append(el('div', 'skeleton'), el('div', 'skeleton'), el('div', 'skeleton'));
    return section;
  }

  render(card: Card): void {
    this.#ensure();
    if (!this.#title || !this.#body || !this.#intent || !this.#footer) return;

    this.#current = card;
    this.#title.textContent = card.query;
    this.#showSpeaker(card.query);
    this.#intent.textContent = card.intent;

    const sections: HTMLElement[] = [];
    for (const id of card.order) {
      const section = this.#renderSlot(card, id);
      if (section) sections.push(section);
    }
    // Offered as soon as there is anything to take, not only once every
    // provider has settled — what the reader can see is what they can copy.
    if (sections.length === 0) sections.push(this.#skeletonSection());
    else sections.push(this.#actionsSection());
    this.#body.replaceChildren(...sections);

    const sources = card.sources.filter((s) => s !== 'links');
    this.#footer.replaceChildren(
      el('span', undefined, sources.length ? `Sources: ${sources.join(', ')}` : 'Looking…'),
      el('span', undefined, card.done ? `${card.elapsedMs} ms` : ''),
    );

    // The card has just changed height. Placing it again is what keeps a
    // card anchored near the foot of the window on the screen.
    this.#place();
  }

  /**
   * The copy row, at the foot of the body.
   *
   * It reads as one more section rather than as a toolbar, because that is
   * what it is: the last thing on the card, in the same shape as the "Look
   * up in" links directly above it.
   */
  #actionsSection(): HTMLElement {
    this.#actionButtons.clear();
    const section = el('section');
    const chips = el('div', 'chips');

    for (const { format, label, hint } of FORMATS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = label;
      button.title = hint;
      button.setAttribute('aria-label', hint);
      button.addEventListener('click', () => void this.copyCurrent(format));
      this.#actionButtons.set(format, button);
      chips.append(button);
    }

    section.append(el('div', 'label', 'Copy'), chips);
    return section;
  }

  /**
   * Reads the selection aloud, in the language the page is written in.
   *
   * The page's own `lang` is the best evidence available: the words came
   * from there, so that is how they are meant to sound. Nothing on the card
   * records a source language, and guessing from the characters would get
   * every English word in a Turkish article wrong.
   */
  speakQuery(): boolean {
    const query = this.#current?.query ?? this.#title?.textContent ?? '';
    this.#engage();
    return speak(query, utteranceLanguage(document.documentElement.lang));
  }

  /**
   * A control that cannot do anything should not be on the card. Speech is
   * missing in some browsers and refused for a selection long enough to be
   * a paragraph, and both are known before the button is drawn.
   */
  #showSpeaker(query: string): void {
    if (!this.#speaker) return;
    const possible = Boolean(window.speechSynthesis) && speakable(query);
    this.#speaker.hidden = !possible;
  }

  /**
   * Copies the card on screen. Returns false when there was nothing to copy
   * or the clipboard refused, so a caller can tell the two apart from silence.
   */
  async copyCurrent(format: ExportFormat): Promise<boolean> {
    const card = this.#current;
    if (!card) return false;
    this.#engage();

    const copied = await writeClipboard(formatCard(card, format, exportContext()));
    this.#flash(format, copied);
    return copied;
  }

  /** Says what happened on the button that did it, then puts its name back. */
  #flash(format: ExportFormat, copied: boolean): void {
    const button = this.#actionButtons.get(format);
    const name = FORMATS.find((f) => f.format === format)?.label;
    if (!button || !name) return;

    button.textContent = copied ? 'Copied' : 'Failed';
    button.dataset.state = copied ? 'done' : 'failed';
    setTimeout(() => {
      // The card may have been re-rendered in the meantime, which replaces
      // the button; touching the detached one is harmless.
      button.textContent = name;
      delete button.dataset.state;
    }, FEEDBACK_MS);
  }

  #renderSlot(card: Card, id: SlotId): HTMLElement | undefined {
    const slot = (card.slots as Record<string, { state: string; data?: unknown } | undefined>)[id];
    if (!slot) return undefined;

    if (slot.state === 'pending') {
      // Reserving space for a slot still in flight is what stops the card
      // from jumping when a slower source lands.
      const section = el('section', 'pending');
      section.append(el('div', 'skeleton'), el('div', 'skeleton'));
      return section;
    }
    if (slot.state !== 'filled' || slot.data === undefined) return undefined;

    const section = el('section');
    const label = SLOT_LABEL[id];

    switch (id) {
      case 'headword':
        return undefined; // Already shown in the header.

      case 'gloss':
        section.append(el('div', 'gloss', String(slot.data)));
        return section;

      case 'pronunciation': {
        const list = slot.data as Array<{ ipa?: string; dialect?: string }>;
        const row = el('div', 'ipa');
        for (const p of list.slice(0, 3)) {
          if (!p.ipa) continue;
          row.append(el('span', undefined, p.dialect ? `${p.dialect} ${p.ipa}` : p.ipa));
        }
        if (!row.hasChildNodes()) return undefined;
        section.append(row);
        return section;
      }

      case 'frequency': {
        const f = slot.data as Frequency;
        // Joined to the pronunciation above it when there is one, so the two
        // read as one block about the word rather than as two strips.
        if (card.slots.pronunciation?.state === 'filled') section.className = 'tight';
        const row = el('div', 'frequency');

        // Five segments, filled to the band. Length encodes the value, so the
        // comparison between two words is made by the eye rather than by
        // reading two numbers off a logarithmic scale.
        const bar = el('span', 'bar');
        for (let step = 1; step <= 5; step++) {
          const cell = el('span', step <= f.band ? 'on' : undefined);
          bar.append(cell);
        }
        // The bar alone cannot say what it measures, and colour alone cannot
        // either — so the word is always there and the exact figure is one
        // hover away for anyone who wants it.
        row.append(bar, el('span', 'band', f.label));
        row.title = `${f.perMillion.toLocaleString(undefined, { maximumFractionDigits: 2 })} per million words, ${f.source}`;
        section.append(row);
        return section;
      }

      case 'senses': {
        const senses = slot.data as Sense[];
        const list = el('ol', 'senses');
        for (const sense of senses.slice(0, 6)) {
          const item = el('li');
          if (sense.partOfSpeech) item.append(el('span', 'pos', sense.partOfSpeech));
          item.append(document.createTextNode(sense.definition));
          if (sense.example) item.append(el('em', 'example', sense.example));
          list.append(item);
        }
        section.append(el('div', 'label', label ?? id), list);
        return section;
      }

      case 'related': {
        const related = slot.data as Related[];
        const chips = el('div', 'chips');
        for (const item of related.slice(0, 14)) {
          const chip = el('span', `chip ${item.kind}`, item.word);
          if (item.definition) chip.title = item.definition;
          chips.append(chip);
        }
        if (!chips.hasChildNodes()) return undefined;
        section.append(el('div', 'label', label ?? id), chips);
        return section;
      }

      case 'translation': {
        const t = slot.data as {
          text: string;
          lang: string;
          equivalents?: Array<{ word: string }>;
        };
        const row = el('div', 'translation');
        row.append(el('span', 'lang', t.lang), document.createTextNode(t.text));

        // Its own speaker, in its own language. Reading `bölme` with an
        // English voice is not a pronunciation of anything.
        const say = el('button', 'icon say', '🔊');
        say.title = `Read the ${t.lang} aloud`;
        say.setAttribute('aria-label', `Read the ${t.lang} translation aloud`);
        say.addEventListener('click', () => {
          this.#engage();
          speak(t.text, utteranceLanguage(t.lang));
        });
        row.append(say);
        section.append(row);

        // Dictionary head-words, but only the ones the translated line does
        // not already contain. A pack writes both, and its line *is* its
        // head-words, so an equality check on the joined string was too
        // narrow the moment anything grouped them differently.
        const words = (t.equivalents ?? []).filter((w) => !t.text.includes(w.word));
        if (words.length > 0) {
          const chips = el('div', 'chips');
          for (const word of words) chips.append(el('span', 'chip', word.word));
          section.append(chips);
        }
        return section;
      }

      case 'entity': {
        const entity = slot.data as {
          title: string;
          description?: string;
          extract?: string;
          imageUrl?: string;
        };
        const wrap = el('div', 'entity');
        if (entity.imageUrl) {
          const img = el('img');
          img.src = entity.imageUrl;
          img.alt = '';
          img.loading = 'lazy';
          wrap.append(img);
        }
        const text = el('div');
        text.append(el('h3', undefined, entity.title));
        if (entity.description) text.append(el('p', undefined, entity.description));
        if (entity.extract) text.append(el('p', undefined, entity.extract));
        wrap.append(text);
        section.append(wrap);
        return section;
      }

      case 'extract': {
        // The entity slot already shows this text when both are present.
        if (card.slots.entity?.state === 'filled') return undefined;
        const extract = slot.data as { text: string };
        section.append(el('div', 'label', label ?? id), el('div', undefined, extract.text));
        return section;
      }

      case 'onPage': {
        const sentences = slot.data as string[];
        if (sentences.length === 0) return undefined;
        section.append(el('div', 'label', label ?? id));
        for (const sentence of sentences) section.append(el('p', 'quote', sentence));
        return section;
      }

      case 'facts': {
        const facts = slot.data as Array<{ label: string; value: string }>;
        const chips = el('div', 'chips');
        for (const fact of facts.slice(0, 8)) {
          chips.append(el('span', 'chip', `${fact.label}: ${fact.value}`));
        }
        if (!chips.hasChildNodes()) return undefined;
        section.append(el('div', 'label', label ?? id), chips);
        return section;
      }

      case 'links': {
        const links = slot.data as Array<{ id: string; label: string; url: string }>;
        const chips = el('div', 'chips');
        for (const link of links) {
          const anchor = el('a', 'chip', link.label);
          anchor.href = link.url;
          anchor.target = '_blank';
          anchor.rel = 'noreferrer noopener';
          anchor.addEventListener('click', () => this.#engage());
          chips.append(anchor);
        }
        section.append(el('div', 'label', label ?? id), chips);
        return section;
      }

      default:
        return undefined;
    }
  }
}
