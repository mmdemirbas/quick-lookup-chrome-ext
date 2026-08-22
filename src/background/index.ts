/**
 * Service worker: the only place lookups are orchestrated.
 *
 * Content scripts stay thin because they run on every page. Everything that
 * costs anything — network, ranking, caching — happens here, once per
 * browser rather than once per tab.
 */
import { runLookup } from '../core/lookup.ts';
import { extractSignals } from '../core/intent/signals.ts';
import { routeIntent } from '../core/intent/router.ts';
import { LruCache, cardShape, lookupKey } from '../core/cache.ts';
import { PersistentStore } from '../core/store.ts';
import { localStore } from '../platform/storage.ts';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../core/settings.ts';
import type { Card, LookupRequest } from '../core/types.ts';
import { PROVIDERS } from '../core/providers/all.ts';
import { ext } from '../platform/browser.ts';
import { packLookup } from '../platform/packs.ts';
import { createHttpClient } from '../platform/http.ts';
import {
  detectCapabilities,
  detectLanguage,
  hasTranslator,
  translate,
  uiLanguage,
} from '../platform/ai.ts';
import { translateOnline, UNKNOWN_LANGUAGE } from '../core/online-translate.ts';
import { sameLanguage } from '../core/language.ts';
import type { StatusResponse, ToBackground } from '../shared/messages.ts';
import { openPanel } from '../shared/panel.ts';

const VERSION = ext.runtime.getManifest().version;
const http = createHttpClient(VERSION);

/**
 * Opened once per service-worker lifetime, not once per lookup. The worker is
 * torn down after about thirty seconds of inactivity, so "once" is often and
 * the metadata read behind this is what keeps it cheap when no pack exists.
 */
const packs = packLookup();

let settings: Settings = DEFAULT_SETTINGS;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Two cache layers, because they solve different problems.
 *
 * The service worker is torn down after about thirty seconds of inactivity,
 * so an in-memory cache alone would be cold for almost every real lookup —
 * it only helps within a burst, such as reading four words in one paragraph.
 * The persistent layer is what makes a word looked up yesterday instant
 * today.
 */
const memory = new LruCache<Card>({ maxEntries: 60, ttlMs: CACHE_TTL_MS });
const persistent = new PersistentStore<Card>(localStore(), {
  maxEntries: 400,
  ttlMs: CACHE_TTL_MS,
  maxHistory: 300,
});

/** One controller per tab: a new lookup cancels whatever that tab was doing. */
/**
 * One lookup at a time per surface. A tab is keyed by its id; the panel has
 * no tab of its own, so it gets a key that no tab id can collide with.
 */
const PANEL = 'panel';
const inFlight = new Map<number | typeof PANEL, AbortController>();

async function loadSettings(): Promise<Settings> {
  const stored = await ext.storage.sync.get('settings');
  settings = mergeSettings(stored.settings);
  return settings;
}

async function saveSettings(next: Settings): Promise<void> {
  settings = mergeSettings(next);
  await ext.storage.sync.set({ settings });
  const tabs = await ext.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    ext.tabs.sendMessage(tab.id, { type: 'QL_SETTINGS_CHANGED', settings }).catch(() => {
      // A tab with no content script — an extension page, or the store.
    });
  }
}

/**
 * Cards go to the tab that asked and to every extension page at once.
 *
 * The panel is a mirror rather than a second client: it shows whatever was
 * looked up last, in whichever tab, which is what lets an answer outlive the
 * page it was found on. A lookup started from the panel itself has no tab,
 * and then only the broadcast carries it.
 */
function send(tabId: number | undefined, card: Card): void {
  if (tabId !== undefined) {
    ext.tabs.sendMessage(tabId, { type: 'QL_CARD', card }).catch(() => {
      // The tab navigated away mid-lookup. The abort below handles the rest.
    });
  }
  ext.runtime.sendMessage({ type: 'QL_CARD', card }).catch(() => {
    // No extension page is open. This is the usual case, not a failure.
  });
}

/**
 * Adds a translation of the lead sense.
 *
 * Runs after the sources have settled rather than as a provider, because it
 * translates an answer we already have instead of fetching a new one, and
 * because it is the one step that may be unavailable on any given machine.
 */
async function addGloss(
  card: Card,
  targetLanguage: string,
  pageLanguage: string | undefined,
): Promise<boolean> {
  if (!settings.appearance.showGloss) return false;
  // Nothing here could translate, so nothing below is worth working out.
  if (!hasTranslator() && !settings.appearance.onlineTranslation) return false;

  // What is worth translating differs by what was selected. For a single
  // word the definition carries far more than the word alone would, and the
  // dictionary already supplied the word itself. For anything longer the
  // selection is the thing the reader wants rendered.
  const existing = card.slots.translation?.data;
  const subject =
    card.intent === 'word'
      ? (card.slots.gloss?.data ?? card.slots.senses?.data?.[0]?.definition)
      : card.query;
  if (!subject) return false;

  // What language the subject is in, in order of how much it can be trusted.
  //
  // A dictionary definition is written in English whatever the word was, so
  // the word path knows. Anything else is the reader's own selection, and
  // assuming English there is how a German sentence came back as itself:
  // both services accept `en` for German text and return the input, with no
  // error to notice. A detector, where the browser has one, is evidence; the
  // page's `lang` is a declaration; neither may be invented.
  const source =
    card.intent === 'word'
      ? 'en'
      : ((await detectLanguage(subject)) ?? pageLanguage ?? undefined);
  if (source && sameLanguage(source, targetLanguage)) return false;

  // On-device first, always: it is free, private and needs no allowance. It
  // needs both languages named, so an unknown source skips it rather than
  // guessing — the online chain can still ask a service that detects.
  const onDevice = source ? await translate(subject, source, targetLanguage) : undefined;
  const online =
    onDevice || !settings.appearance.onlineTranslation
      ? undefined
      : await translateOnline(http, {
          text: subject,
          sourceLanguage: source ?? UNKNOWN_LANGUAGE,
          targetLanguage,
          preference: settings.appearance.translationService,
          ...(settings.appearance.translationEmail
            ? { email: settings.appearance.translationEmail }
            : {}),
        });

  const translated = onDevice ?? online?.text;
  if (!translated) return false;

  card.slots.translation = {
    id: 'translation',
    state: 'filled',
    data: {
      text: translated,
      lang: targetLanguage,
      source: onDevice ? 'on-device' : (online?.source ?? 'online'),
      // Dictionary head-words are a different answer, not a worse one, so a
      // translator arriving later must not discard them.
      ...(existing?.equivalents?.length ? { equivalents: existing.equivalents } : {}),
    },
  };
  if (!card.order.includes('translation')) card.order.push('translation');
  return true;
}

async function handleLookup(
  tabId: number | undefined,
  requestId: string,
  text: string,
  page: LookupRequest['page'],
): Promise<void> {
  const surface = tabId ?? PANEL;
  inFlight.get(surface)?.abort('superseded');
  const controller = new AbortController();
  inFlight.set(surface, controller);

  const trimmed = text.slice(0, settings.limits.maxSelectionChars);
  const lang = uiLanguage().split('-')[0] || 'en';
  const decision = routeIntent(extractSignals(trimmed, page), lang);
  const shape = cardShape({
    ...(settings.appearance.showGloss
      ? { glossLanguage: settings.appearance.glossLanguage }
      : {}),
    onlineTranslation: settings.appearance.onlineTranslation,
    translationService: settings.appearance.translationService,
    packs: await packs.signature(),
    build: VERSION,
  });
  const key = lookupKey(trimmed, decision.intent, page.host ?? '', lang, shape);

  const remember = async (card: Card) => {
    await persistent.recordLookup({
      query: trimmed,
      intent: decision.intent,
      host: page.host ?? '',
      at: Date.now(),
      ...(card.slots.gloss?.data ? { gloss: card.slots.gloss.data } : {}),
    });
    // The panel lists recent lookups and is open while they happen, so it
    // has to be told. The card cannot carry this: it is finished before the
    // write that this awaits.
    const items = await persistent.history();
    ext.runtime.sendMessage({ type: 'QL_HISTORY', items }).catch(() => {
      // No extension page is open, which is the usual case.
    });
  };

  const cached = memory.get(key) ?? (await persistent.read(key));
  if (cached) {
    if (controller.signal.aborted) return;
    memory.set(key, cached);
    send(tabId, { ...cached, requestId });
    void remember(cached);
    return;
  }

  const budget = setTimeout(() => controller.abort('budget'), settings.limits.timeoutMs);
  try {
    const request: LookupRequest = {
      id: requestId,
      text: trimmed,
      uiLang: lang,
      page,
      ...(settings.appearance.showGloss
        ? { glossLanguage: settings.appearance.glossLanguage }
        : {}),
    };
    const card = await runLookup(
      request,
      decision,
      { http, providers: PROVIDERS, packs },
      {
        signal: controller.signal,
        onUpdate: (partial) => send(tabId, partial),
      },
    );

    if (controller.signal.aborted) return;
    if (await addGloss(card, settings.appearance.glossLanguage, page.lang)) send(tabId, card);

    // Only cache a card that actually answered. Caching an empty result
    // would make a transient outage stick for a week.
    if (card.sources.some((source) => source !== 'links')) {
      memory.set(key, card);
      void persistent.write(key, card);
    }
    void remember(card);
  } finally {
    clearTimeout(budget);
    if (inFlight.get(surface) === controller) inFlight.delete(surface);
  }
}

ext.runtime.onMessage.addListener((message: ToBackground, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'QL_LOOKUP':
      // A message with no tab behind it came from the panel, which is an
      // extension page. Its lookups run the same way and answer by broadcast.
      void loadSettings()
        .then(() => handleLookup(tabId, message.requestId, message.text, message.page))
        .catch(() => {
          // Every provider already swallows its own failure; reaching here
          // means the orchestration itself failed and there is no card.
        });
      return false;

    case 'QL_CANCEL':
      if (tabId !== undefined) inFlight.get(tabId)?.abort('cancelled');
      return false;

    case 'QL_GET_SETTINGS':
      void loadSettings().then(sendResponse);
      return true;

    case 'QL_SAVE_SETTINGS':
      void saveSettings(message.settings).then(() => sendResponse(settings));
      return true;

    case 'QL_SET_SITE_MODE':
      void loadSettings().then(() => {
        const next = structuredClone(settings);
        if (message.mode === null) delete next.sites[message.host];
        else next.sites[message.host] = { mode: message.mode };
        return saveSettings(next).then(() => sendResponse(settings));
      });
      return true;

    case 'QL_GET_STATUS':
      void detectCapabilities().then((capabilities) => {
        const status: StatusResponse = { capabilities, version: VERSION };
        sendResponse(status);
      });
      return true;

    case 'QL_GET_HISTORY':
      void persistent.history().then(sendResponse);
      return true;

    case 'QL_STAR':
      void persistent.toggleStar(message.query, message.host).then(sendResponse);
      return true;

    case 'QL_PACKS_CHANGED':
      packs.refresh();
      // Cached cards were composed without the new pack, or with one that has
      // gone. The persistent layer is keyed by a shape that now includes the
      // installed set, so only the in-memory copy has to be dropped.
      memory.clear();
      return false;

    case 'QL_CLEAR_HISTORY':
      void persistent.clearHistory().then(() => persistent.history().then(sendResponse));
      return true;

    default:
      return false;
  }
});

ext.runtime.onInstalled.addListener(() => {
  ext.contextMenus.create({
    id: 'quick-lookup',
    title: 'Quick Lookup "%s"',
    contexts: ['selection'],
  });
  // The panel cannot be opened by the card's own button: that press reaches
  // the extension as a message, leaving the service worker to make the call
  // with no gesture behind it, and Chrome refuses that outright. A
  // context-menu click hands the worker a real one, and is the entry point
  // Chrome's own documentation uses.
  ext.contextMenus.create({
    id: 'quick-lookup-panel',
    title: 'Open the Quick Lookup panel',
    contexts: ['all'],
  });
  // Expired entries are dropped on read, but a key never read again would
  // otherwise occupy storage forever.
  void persistent.prune();
});

ext.runtime.onStartup?.addListener(() => {
  void persistent.prune();
});

ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'quick-lookup-panel') {
    openPanel(tab?.windowId);
    return;
  }
  if (info.menuItemId !== 'quick-lookup' || tab?.id === undefined) return;
  ext.tabs
    .sendMessage(tab.id, { type: 'QL_TRIGGER_LOOKUP', text: info.selectionText })
    .catch(() => {
      // No content script on this page; nothing to trigger.
    });
});

ext.commands?.onCommand.addListener((command, tab) => {
  if (command !== 'lookup-selection' || tab?.id === undefined) return;
  ext.tabs.sendMessage(tab.id, { type: 'QL_TRIGGER_LOOKUP' }).catch(() => {
    // As above.
  });
});

ext.tabs.onRemoved.addListener((tabId) => {
  inFlight.get(tabId)?.abort('tab closed');
  inFlight.delete(tabId);
});
