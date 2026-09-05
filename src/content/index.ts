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
import type { Card, LookupRequest } from '../core/types.ts';
import { finalise } from '../core/card.ts';
import { extractSignals } from '../core/intent/signals.ts';
import { routeIntent } from '../core/intent/router.ts';
import { localCard } from '../core/lookup.ts';
import { uiLanguage } from '../platform/ai.ts';
import { ext } from '../platform/browser.ts';
import { CardView } from './card-view.ts';
import { SelectionHandle } from './handle.ts';
import { HoverLookup } from './hover.ts';
import { contextForSelection, pageProfile, pageText, resetPageProfile } from './page-context.ts';
import type { CollectedContext, ToContent } from '../shared/messages.ts';

/**
 * How long after a selection a copy shortcut still cancels the card.
 *
 * Copying is the most common thing a selection is for, and it is the single
 * biggest source of unwanted cards. The window is generous on purpose.
 */
const COPY_CANCEL_MS = 700;

let settings: Settings = DEFAULT_SETTINGS;
const dismissals = new DismissalTracker(3);

/**
 * Cards the reader has dragged aside, oldest first.
 *
 * Dragging a card detaches it: it keeps its answer, stops following
 * selections and stops being closed by them, so the next lookup opens a
 * second card beside it. That is the whole point — two words on screen at
 * once is the only way to compare them.
 */
const pinned: CardView[] = [];

/**
 * Beyond this many, the screen is the problem rather than the feature. The
 * oldest goes, because the reader pinned it longest ago and has had the most
 * time to finish with it.
 */
const MAX_PINNED = 4;

let dwellTimer: ReturnType<typeof setTimeout> | undefined;
let pointerDown = false;
let openedAt = 0;
let pendingRect: DOMRect | undefined;

/**
 * Words reached by following a synonym, per card, oldest first.
 *
 * Outside the card because it is navigation rather than rendering, and it has
 * to survive the re-render that every arriving provider causes. Keyed by card
 * because each one is a separate line of enquiry: going back in one must not
 * move another.
 */
const trails = new WeakMap<CardView, string[]>();

const trailOf = (view: CardView): string[] => {
  const existing = trails.get(view);
  if (existing) return existing;
  const fresh: string[] = [];
  trails.set(view, fresh);
  return fresh;
};

/** Looks a word up inside the card it was pressed in, leaving it where it is. */
function follow(view: CardView, text: string, from: string | undefined): void {
  const rect = view.anchor;
  if (!rect) return;
  if (from) trailOf(view).push(from);
  startLookup(text, rect, null, { view, keepTrail: true });
}

function makeCard(): CardView {
  const view: CardView = new CardView({
    onClose: () => dismiss(view, 'dismissed'),
    onQuietSite: () => {
      void ext.runtime.sendMessage({
        type: 'QL_SET_SITE_MODE',
        host: location.hostname,
        mode: 'handle',
      });
      settings.sites[location.hostname] = { mode: 'handle' };
      dismiss(view, 'quieted');
    },
    onEngage: () => dismissals.recordEngagement(location.hostname),
    onFollow: (text) => follow(view, text, view.query),
    onBack: () => {
      const previous = trailOf(view).pop();
      if (previous) follow(view, previous, undefined);
    },
    onPinned: () => {
      // The card the reader just took hold of is no longer the one selections
      // write into, so the live slot has to be replaced before the next one.
      if (view !== live) return;
      pinned.push(view);
      live = makeCard();
      while (pinned.length > MAX_PINNED) pinned.shift()?.destroy();
    },
  });
  return view;
}

/** The card a new selection writes into. Replaced whenever one is pinned. */
let live = makeCard();

/** Every card on screen. Order is irrelevant; membership is not. */
const allCards = (): CardView[] => [live, ...pinned];

function anyCardContains(node: Node | null): boolean {
  return allCards().some((view) => view.contains(node));
}

/**
 * Closes one card.
 *
 * A pinned card is destroyed rather than hidden: it exists because the reader
 * put it there, so closing it should leave nothing behind. The live card is
 * only hidden, because it is reused by the next selection.
 */
function dismiss(view: CardView, reason: 'dismissed' | 'quieted' | 'navigated'): void {
  if (view !== live) {
    const at = pinned.indexOf(view);
    if (at >= 0) pinned.splice(at, 1);
    view.destroy();
    return;
  }
  closeCard(reason);
}

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
  if (!live.isOpen) return;
  live.hide();
  handle.hide();
  void ext.runtime.sendMessage({ type: 'QL_CANCEL', requestId: live.requestId }).catch(() => {});

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

function startLookup(
  text: string,
  rect: DOMRect,
  selection: Selection | null,
  options: { view?: CardView; keepTrail?: boolean } = {},
): void {
  const view = options.view ?? live;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  view.claim(requestId);
  openedAt = Date.now();

  const trail = trailOf(view);
  if (!options.keepTrail) trail.length = 0;

  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const page = contextForSelection(range, text.trim());

  view.renderPending(text.trim());
  view.setBack(trail[trail.length - 1]);
  // Only the pinned ones are avoided. A card following a word inside itself
  // must be free to stay exactly where the reader put it.
  view.showAt(
    rect,
    pinned.filter((other) => other !== view).flatMap((other) => other.box() ?? []),
  );

  // What the page can answer on its own, drawn before the worker is asked.
  // The worker's card replaces it as it arrives; a request that never comes
  // back leaves this one, settled, rather than a skeleton.
  //
  // The query and the language are derived exactly as the worker derives
  // them, and not merely equivalently. A different string routes to a
  // different intent, an intent chooses the slot order, and the card would
  // then visibly reshuffle the moment the worker's answer landed.
  // Captured, not read at timeout: `openedAt` belongs to whichever lookup
  // ran last, and the timer below fires seconds later.
  const startedAt = openedAt;
  const trimmed = text.slice(0, settings.limits.maxSelectionChars);
  const lang = uiLanguage().split('-')[0] || 'en';
  const request: LookupRequest = { id: requestId, text: trimmed, uiLang: lang, page };
  const local = localCard(request, routeIntent(extractSignals(trimmed, page), lang));
  void local.then((card) => {
    if (view.isOpen && view.requestId === requestId) view.render(card);
  });

  void ext.runtime
    .sendMessage({ type: 'QL_LOOKUP', requestId, text, page })
    .catch(() => {
      // Not "the worker was asleep". A message to a sleeping worker starts
      // it and is delivered — on a first run after install that took 15
      // seconds, which is what the local card above is for. A rejection
      // means nothing was listening at all, so this is all the lookup gets.
      settleLocally(view, requestId, local, startedAt);
    });

  // A worker that never answers — a lost message, a worker that will not
  // start — must not leave the skeletons up for good. Its own budget, plus
  // room for the round trip, is how long they are worth waiting on.
  awaiting.set(
    requestId,
    setTimeout(() => {
      awaiting.delete(requestId);
      settleLocally(view, requestId, local, startedAt);
    }, settings.limits.timeoutMs + SETTLE_GRACE_MS),
  );
}

/**
 * The settle timer of each lookup still waiting on the worker.
 *
 * A map rather than a set of ids that have answered, so every entry leaves by
 * one of exactly two doors — the worker answered, or the timer fired. A set
 * of answered ids kept anything the worker replied to after its own timer had
 * already run, which is a small leak that never ends.
 */
const awaiting = new Map<string, ReturnType<typeof setTimeout>>();

/** How much longer than the worker's own budget the page waits before settling. */
const SETTLE_GRACE_MS = 3000;

/**
 * Marks the still-pending slots of the local card as unavailable, in place.
 *
 * The elapsed time is set here rather than left at zero: `finalise` is what
 * makes a card `done`, and a done card prints how long it took. A card that
 * waited seven seconds for a worker that never answered would otherwise
 * claim it had taken none.
 */
function settleLocally(
  view: CardView,
  requestId: string,
  local: Promise<Card>,
  startedAt: number,
): void {
  void local.then((card) => {
    // Open, and still this lookup. Rendering re-creates the host if it has
    // gone, so a settle firing seconds after the reader pressed Escape would
    // otherwise put a dismissed card back on the page.
    if (!view.isOpen || view.requestId !== requestId) return;
    card.elapsedMs = Date.now() - startedAt;
    view.render(finalise(card));
  });
}

/** Runs after the dwell, if nothing has cancelled it in the meantime. */
function evaluateSelection(modifierHeld: boolean): void {
  const selection = window.getSelection();
  const text = selection?.toString() ?? '';
  const anchor = selection?.anchorNode ?? null;

  const facts = selectionFacts(text, {
    inEditable: isEditable(anchor),
    insideOwnUi: anyCardContains(anchor) || handle.contains(anchor) || hover.contains(anchor),
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
    if (live.isOpen && !anyCardContains(target)) closeCard('dismissed');
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
    if (anyCardContains(target) || handle.contains(target)) return;
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
    if (live.isOpen && event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyC') {
      event.preventDefault();
      void live.copyCurrent('markdown');
      return;
    }
    // And the same route to hearing it.
    if (live.isOpen && event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyS') {
      event.preventDefault();
      live.speakQuery();
      return;
    }
    // Guard two: copying is a different intention from looking up.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      cancelDwell();
      if (live.isOpen && Date.now() - openedAt < COPY_CANCEL_MS) closeCard('navigated');
      return;
    }
    if (event.key === 'Escape') {
      // The live card first, then the pinned ones newest first, so pressing
      // Escape repeatedly clears the screen in the reverse of the order it
      // filled up. Nothing open means the key belongs to the page.
      if (live.isOpen) closeCard('dismissed');
      else {
        const last = pinned[pinned.length - 1];
        if (last) dismiss(last, 'dismissed');
        else return;
      }
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
    if (live.isOpen && !hover.isActive) closeCard('navigated');
  },
  { passive: true, capture: true },
);

/**
 * A ceiling on what crosses the message channel, not the context budget.
 *
 * The budget belongs to the conversation and is applied by the worker, which
 * is the only place that knows the setting. This exists so that a docs site
 * serving its whole reference on one route cannot hand a megabyte of string
 * to `sendMessage`.
 */
const MAX_TRANSFERRED_CHARS = 200_000;

ext.runtime.onMessage.addListener((message: ToContent, _sender, sendResponse) => {
  switch (message.type) {
    case 'QL_CARD': {
      const incoming = message.card as Card;
      // Routed by request rather than drawn on the live card. A pinned card
      // can still be waiting on a slow provider, and its answer must land in
      // it and not in whatever the reader has selected since.
      const owner = allCards().find((view) => view.requestId === incoming.requestId);
      // No owner is a late answer for a lookup that has been superseded.
      if (!owner) return;
      const timer = awaiting.get(incoming.requestId);
      if (timer !== undefined) {
        clearTimeout(timer);
        awaiting.delete(incoming.requestId);
      }
      owner.render(incoming);
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
    case 'QL_COLLECT_CONTEXT': {
      const profile = pageProfile();
      const text = pageText();
      const selection = window.getSelection()?.toString().trim() ?? '';
      const reply: CollectedContext = {
        attachment: {
          url: profile.url ?? location.href,
          host: profile.host ?? location.hostname,
          title: profile.title || document.title || location.hostname,
          ...(selection ? { selection } : {}),
          excerpt: text.slice(0, MAX_TRANSFERRED_CHARS),
          // The true length, measured before either cut. It is what tells
          // the reader that what the model saw was not the whole page.
          fullLength: text.length,
        },
      };
      sendResponse(reply);
      return;
    }
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
