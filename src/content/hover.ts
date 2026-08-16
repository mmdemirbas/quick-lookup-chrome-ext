/**
 * Hover lookup: point at a word with the modifier held, no selection.
 *
 * Hovering can only ever indicate one word, which is why the arrow keys
 * are part of the feature rather than an extra: the pointer picks a
 * starting word and `→` / `←` widen or narrow the span until it is the
 * phrase the reader meant. Nothing else can express "these three words"
 * without dragging.
 *
 * Cost when unused is one `keydown` listener. The pointer listener is
 * attached when the modifier goes down and removed when it comes up, so a
 * page where the reader never hovers pays nothing per mouse move.
 *
 * The span is shown with an overlay drawn inside the extension's own host
 * element rather than with the Custom Highlight API, which would need a
 * style rule injected into the page.
 */
import type { Modifier } from '../core/settings.ts';
import { compoundAt, resizeSpan, sliceSpan, wordAt, type Span } from '../core/span.ts';

/** How long the pointer must rest on a new word before it is looked up. */
const DWELL_MS = 220;

const KEY_FOR: Record<Modifier, string> = {
  alt: 'Alt',
  ctrl: 'Control',
  meta: 'Meta',
  shift: 'Shift',
};

const OVERLAY_STYLE = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483644;
        pointer-events: none; contain: layout paint style; }
.box { position: fixed; border-radius: 3px; background: rgba(79, 70, 229, .18);
       box-shadow: inset 0 -1px 0 rgba(79, 70, 229, .55); }
@media (prefers-color-scheme: dark) {
  .box { background: rgba(165, 160, 255, .22); box-shadow: inset 0 -1px 0 rgba(165, 160, 255, .6); }
}
`;

type Target = { node: Text; text: string; span: Span };

export type HoverCallbacks = {
  /** True while hover lookups are allowed at all. */
  enabled(): boolean;
  modifier(): Modifier;
  onLookup(text: string, rect: DOMRect): void;
  onCancel(): void;
};

/** Chrome and the standard disagree on the name; both are in the wild. */
function caretAt(x: number, y: number): { node: Node; offset: number } | undefined {
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  return undefined;
}

export class HoverLookup {
  #overlayHost: HTMLElement | undefined;
  #overlayRoot: ShadowRoot | undefined;
  #active = false;
  #target: Target | undefined;
  #lastText = '';
  #dwellTimer: ReturnType<typeof setTimeout> | undefined;
  #frame = 0;

  constructor(private readonly callbacks: HoverCallbacks) {
    document.addEventListener('keydown', this.#onKeyDown, true);
    document.addEventListener('keyup', this.#onKeyUp, true);
    window.addEventListener('blur', () => this.#deactivate(), true);
  }

  get isActive(): boolean {
    return this.#active;
  }

  contains(node: Node | null): boolean {
    return Boolean(node && this.#overlayHost?.contains(node));
  }

  /** Any of the extension's own elements, whether text node or host. */
  #isOwnUi(node: Node): boolean {
    if (this.contains(node)) return true;
    const el = node instanceof Element ? node : node.parentElement;
    return Boolean(el?.closest('quick-lookup-card, quick-lookup-handle, quick-lookup-hover'));
  }

  destroy(): void {
    document.removeEventListener('keydown', this.#onKeyDown, true);
    document.removeEventListener('keyup', this.#onKeyUp, true);
    this.#deactivate();
    this.#overlayHost?.remove();
    this.#overlayHost = undefined;
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (!this.callbacks.enabled()) return;

    if (event.key === KEY_FOR[this.callbacks.modifier()]) {
      this.#activate();
      return;
    }
    if (!this.#active || !this.#target) return;

    // Arrow keys reshape the span. This is the part that lets a hover mean
    // a phrase rather than only the word under the pointer.
    const { text, span } = this.#target;
    let next: Span | undefined;
    if (event.key === 'ArrowRight') next = resizeSpan(text, span, event.shiftKey ? -1 : 1, 0);
    else if (event.key === 'ArrowLeft') next = resizeSpan(text, span, 0, event.shiftKey ? -1 : 1);
    if (!next) return;

    event.preventDefault();
    event.stopPropagation();
    this.#target = { ...this.#target, span: next };
    this.#paint(this.#target);
    this.#lookup(this.#target, 0);
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === KEY_FOR[this.callbacks.modifier()]) this.#deactivate();
  };

  #activate(): void {
    if (this.#active) return;
    this.#active = true;
    document.addEventListener('pointermove', this.#onPointerMove, { passive: true, capture: true });
  }

  #deactivate(): void {
    if (!this.#active) return;
    this.#active = false;
    document.removeEventListener('pointermove', this.#onPointerMove, true);
    if (this.#dwellTimer !== undefined) clearTimeout(this.#dwellTimer);
    this.#dwellTimer = undefined;
    this.#target = undefined;
    this.#lastText = '';
    this.#clearOverlay();
  }

  #onPointerMove = (event: PointerEvent): void => {
    if (this.#frame) return;
    // One resolve per frame: pointermove fires far faster than layout can
    // usefully be read.
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#resolve(event.clientX, event.clientY);
    });
  };

  #resolve(x: number, y: number): void {
    const caret = caretAt(x, y);
    const node = caret?.node;
    if (!node) {
      this.#clearOverlay();
      return;
    }

    // The own-UI check comes first and covers element nodes too: pointing at
    // the card returns the card's host element, not a text node, and that
    // must leave the current span alone rather than clear it.
    if (this.#isOwnUi(node)) return;

    // A point over padding, a border, or any non-text box resolves to an
    // element. There is no character to identify there, so there is nothing
    // to look up.
    if (node.nodeType !== Node.TEXT_NODE) {
      this.#clearOverlay();
      return;
    }

    const text = node.nodeValue ?? '';
    const base = wordAt(text, caret.offset);
    if (!base) {
      this.#clearOverlay();
      return;
    }

    // Pointing anywhere in a dotted or hyphenated name means the whole name.
    // Shift+arrow narrows it back to one part when that is what was wanted.
    const span = compoundAt(text, base);

    const target: Target = { node: node as Text, text, span };
    const word = sliceSpan(text, span);
    if (!word || word === this.#lastText) {
      this.#paint(target);
      this.#target = target;
      return;
    }

    this.#target = target;
    this.#paint(target);
    this.#lookup(target, DWELL_MS);
  }

  #lookup(target: Target, delay: number): void {
    if (this.#dwellTimer !== undefined) clearTimeout(this.#dwellTimer);
    const text = sliceSpan(target.text, target.span);
    if (!text) return;

    const fire = () => {
      this.#dwellTimer = undefined;
      this.#lastText = text;
      const rect = this.#rangeFor(target)?.getBoundingClientRect();
      if (rect) this.callbacks.onLookup(text, rect);
    };
    if (delay === 0) fire();
    else this.#dwellTimer = setTimeout(fire, delay);
  }

  #rangeFor(target: Target): Range | undefined {
    try {
      const range = document.createRange();
      range.setStart(target.node, target.span.start);
      range.setEnd(target.node, Math.min(target.span.end, target.text.length));
      return range;
    } catch {
      // The node was replaced while the pointer rested on it.
      return undefined;
    }
  }

  #ensureOverlay(): ShadowRoot | undefined {
    if (this.#overlayRoot) return this.#overlayRoot;
    const host = document.createElement('quick-lookup-hover');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_STYLE;
    root.append(style);
    document.documentElement.append(host);
    this.#overlayHost = host;
    this.#overlayRoot = root;
    return root;
  }

  #paint(target: Target): void {
    const root = this.#ensureOverlay();
    const range = this.#rangeFor(target);
    if (!root || !range) return;

    const boxes: HTMLElement[] = [];
    for (const rect of range.getClientRects()) {
      const box = document.createElement('div');
      box.className = 'box';
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      boxes.push(box);
    }
    const style = root.querySelector('style');
    root.replaceChildren(...(style ? [style, ...boxes] : boxes));
  }

  #clearOverlay(): void {
    const style = this.#overlayRoot?.querySelector('style');
    if (this.#overlayRoot && style) this.#overlayRoot.replaceChildren(style);
    this.#target = undefined;
  }
}
