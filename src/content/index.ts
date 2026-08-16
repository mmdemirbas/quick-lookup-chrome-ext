/**
 * The content script. Deliberately thin: it runs on every page.
 *
 * Its whole job is to decide whether the reader asked for anything, and
 * only then to hand a string to the service worker. The timing guards live
 * here because they are about event order — the decision guards are in
 * `core/trigger.ts`, where they can be tested.
 */
import { DEFAULT_SETTINGS, mergeSettings, triggerModeFor, type Settings } from '../core/settings.ts';
import { DismissalTracker, decideTrigger, selectionFacts } from '../core/trigger.ts';
import type { Card } from '../core/types.ts';
import { ext } from '../platform/browser.ts';
import { CardView } from './card-view.ts';
import { SelectionHandle } from './handle.ts';
import { HoverLookup } from './hover.ts';
import { contextForSelection, resetPageProfile } from './page-context.ts';
import type { ToContent } from '../shared/messages.ts';

/**
 * How long after a selection a copy shortcut still cancels the card.
 *
 * Copying is the most common thing a selection is for, and it is the single
 * biggest source of unwanted cards. The window is generous on purpose.
 */
const COPY_CANCEL_MS = 700;

let settings: Settings = DEFAULT_SETTINGS;
const dismissals = new DismissalTracker(3);

let dwellTimer: ReturnType<typeof setTimeout> | undefined;
let pointerDown = false;
let lastRequestId = '';
let openedAt = 0;
let pendingRect: DOMRect | undefined;

const card = new CardView({
  onClose: () => closeCard('dismissed'),
  onQuietSite: () => {
    void ext.runtime.sendMessage({
      type: 'QL_SET_SITE_MODE',
      host: location.hostname,
      mode: 'handle',
    });
    settings.sites[location.hostname] = { mode: 'handle' };
    closeCard('quieted');
  },
  onEngage: () => dismissals.recordEngagement(location.hostname),
});

const handle = new SelectionHandle(() => {
  const selection = window.getSelection();
  const text = selection?.toString() ?? '';
  const rect = pendingRect ?? rectOf(selection);
  handle.hide();
  if (text.trim() && rect) startLookup(text, rect, selection);
});

/**
 * Hover is a second trigger, not a replacement for selection.
 *
 * Selection is exact because the reader drew the boundary. Hover is fast
 * because it needs no gesture at all, and the arrow keys make it exact
 * afterwards. Both feed the same pipeline.
 */
const hover = new HoverLookup({
  enabled: () =>
    settings.trigger.hoverEnabled && triggerModeFor(settings, location.hostname) !== 'off',
  modifier: () => settings.trigger.modifier,
  onLookup: (text, rect) => {
    cancelDwell();
    handle.hide();
    // A hovered span has no selection, so there is no range to read local
    // context from; the page profile still applies.
    startLookup(text, rect, null);
  },
  onCancel: () => closeCard('navigated'),
});

function rectOf(selection: Selection | null): DOMRect | undefined {
  if (!selection || selection.rangeCount === 0) return undefined;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? undefined : rect;
}

function isEditable(node: Node | null): boolean {
  let el = node instanceof Element ? node : node?.parentElement;
  while (el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    el = el.parentElement;
  }
  return false;
}

function cancelDwell(): void {
  if (dwellTimer !== undefined) {
    clearTimeout(dwellTimer);
    dwellTimer = undefined;
  }
}

function closeCard(reason: 'dismissed' | 'quieted' | 'navigated'): void {
  if (!card.isOpen) return;
  card.hide();
  handle.hide();
  void ext.runtime.sendMessage({ type: 'QL_CANCEL', requestId: lastRequestId }).catch(() => {});

  // Only a real dismissal counts. Closing because the page changed, or
  // because the site was just quietened, says nothing about intent.
  if (reason !== 'dismissed') return;
  const engagedLongEnough = Date.now() - openedAt > 4000;
  if (engagedLongEnough) return;
  if (dismissals.recordDismissal(location.hostname)) offerQuietMode();
}

/**
 * After repeated dismissals, switch this site to handle-only rather than
 * waiting to be found in the options page.
 */
function offerQuietMode(): void {
  settings.sites[location.hostname] = { mode: 'handle' };
  void ext.runtime.sendMessage({
    type: 'QL_SET_SITE_MODE',
    host: location.hostname,
    mode: 'handle',
  });
}

function startLookup(text: string, rect: DOMRect, selection: Selection | null): void {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  lastRequestId = requestId;
  openedAt = Date.now();

  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const page = contextForSelection(range, text.trim());

  card.renderPending(text.trim());
  card.showAt(rect);

  void ext.runtime
    .sendMessage({ type: 'QL_LOOKUP', requestId, text, page })
    .catch(() => {
      // The service worker was asleep and the message was dropped. The next
      // selection will wake it; nothing useful can be shown for this one.
    });
}

/** Runs after the dwell, if nothing has cancelled it in the meantime. */
function evaluateSelection(modifierHeld: boolean): void {
  const selection = window.getSelection();
  const text = selection?.toString() ?? '';
  const anchor = selection?.anchorNode ?? null;

  const facts = selectionFacts(text, {
    inEditable: isEditable(anchor),
    insideOwnUi: card.contains(anchor) || handle.contains(anchor) || hover.contains(anchor),
    modifierHeld,
  });

  const mode = triggerModeFor(settings, location.hostname);
  const decision = decideTrigger(facts, settings, mode);
  const rect = rectOf(selection);

  if (decision.action === 'ignore' || !rect) {
    handle.hide();
    return;
  }
  if (decision.action === 'handle') {
    pendingRect = rect;
    handle.showAt(rect);
    return;
  }
  handle.hide();
  startLookup(text, rect, selection);
}

function modifierPressed(event: MouseEvent | KeyboardEvent): boolean {
  switch (settings.trigger.modifier) {
    case 'alt':
      return event.altKey;
    case 'ctrl':
      return event.ctrlKey;
    case 'meta':
      return event.metaKey;
    case 'shift':
      return event.shiftKey;
    default:
      return false;
  }
}

document.addEventListener(
  'pointerdown',
  (event) => {
    pointerDown = true;
    cancelDwell();
    const target = event.target as Node;
    // A click outside the card closes it, but a click inside must not.
    if (card.isOpen && !card.contains(target)) closeCard('dismissed');
    // Nor may pressing the handle hide the handle. This listener is on the
    // document in the capture phase, so it ran before the button's own
    // `click` — hiding the host removed the button from under the finger and
    // the click never landed, which is why the handle looked dead.
    if (!handle.contains(target)) handle.hide();
  },
  true,
);

document.addEventListener(
  'pointerup',
  (event) => {
    pointerDown = false;
    const modifierHeld = modifierPressed(event);
    cancelDwell();
    // A gesture that ended on the extension's own surface — dragging across
    // the answer, or releasing the handle — has already been acted on. Re-
    // evaluating would only hide the handle that was just used.
    const target = event.target as Node;
    if (card.contains(target) || handle.contains(target)) return;
    // Guard three: nothing is decided while the button is still down.
    dwellTimer = setTimeout(() => {
      dwellTimer = undefined;
      if (!pointerDown) evaluateSelection(modifierHeld);
    }, settings.trigger.dwellMs);
  },
  true,
);

document.addEventListener(
  'keydown',
  (event) => {
    // Copying the open card, for readers who never touch the mouse. The
    // card deliberately never takes focus, so its buttons cannot be tabbed
    // to and this is the only keyboard route to them. Alt is used rather
    // than the configured modifier because that may be set to ctrl or meta,
    // which the guard below owns. `code` rather than `key`, because Alt+C
    // composes to "ç" on a Mac.
    if (card.isOpen && event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyC') {
      event.preventDefault();
      void card.copyCurrent('markdown');
      return;
    }
    // Guard two: copying is a different intention from looking up.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      cancelDwell();
      if (card.isOpen && Date.now() - openedAt < COPY_CANCEL_MS) closeCard('navigated');
      return;
    }
    if (event.key === 'Escape' && card.isOpen) {
      closeCard('dismissed');
      return;
    }
    // Keyboard selection, for readers who never touch the mouse.
    if (event.shiftKey && event.key.startsWith('Arrow')) {
      cancelDwell();
      dwellTimer = setTimeout(() => {
        dwellTimer = undefined;
        evaluateSelection(modifierPressed(event));
      }, settings.trigger.dwellMs + 150);
    }
  },
  true,
);

window.addEventListener(
  'scroll',
  () => {
    cancelDwell();
    handle.hide();
    // While the modifier is held the reader is still pointing at text, so
    // scrolling is navigation within the same lookup rather than the end of
    // it. The overlay follows on the next pointer move.
    if (card.isOpen && !hover.isActive) closeCard('navigated');
  },
  { passive: true, capture: true },
);

ext.runtime.onMessage.addListener((message: ToContent) => {
  switch (message.type) {
    case 'QL_CARD': {
      const incoming = message.card as Card;
      // A late answer for a selection the reader has moved on from.
      if (incoming.requestId !== lastRequestId) return;
      card.render(incoming);
      return;
    }
    case 'QL_TRIGGER_LOOKUP': {
      const selection = window.getSelection();
      const text = message.text ?? selection?.toString() ?? '';
      const rect = rectOf(selection) ?? new DOMRect(24, 24, 0, 0);
      if (text.trim()) startLookup(text, rect, selection);
      return;
    }
    case 'QL_SETTINGS_CHANGED':
      settings = mergeSettings(message.settings);
      return;
    default:
      return;
  }
});

// Single-page navigations change the page without reloading the script.
window.addEventListener('popstate', () => {
  resetPageProfile();
  closeCard('navigated');
});

void ext.runtime
  .sendMessage({ type: 'QL_GET_SETTINGS' })
  .then((loaded) => {
    settings = mergeSettings(loaded);
  })
  .catch(() => {
    // Defaults are already in place; the extension is usable without this.
  });
