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
import { LruCache, lookupKey } from '../core/cache.ts';
import { PersistentStore } from '../core/store.ts';
import { localStore } from '../platform/storage.ts';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../core/settings.ts';
import type { Card, LookupRequest, Provider } from '../core/types.ts';
import { freeDictionaryProvider } from '../core/providers/free-dictionary.ts';
import { wiktionaryProvider } from '../core/providers/wiktionary.ts';
import { datamuseProvider } from '../core/providers/datamuse.ts';
import { wikipediaProvider } from '../core/providers/wikipedia.ts';
import { stackExchangeProvider } from '../core/providers/stackexchange.ts';
import { registryProvider } from '../core/providers/registry.ts';
import { ext } from '../platform/browser.ts';
import { createHttpClient } from '../platform/http.ts';
import { detectCapabilities, translate, uiLanguage } from '../platform/ai.ts';
import type { StatusResponse, ToBackground } from '../shared/messages.ts';

const VERSION = ext.runtime.getManifest().version;
const http = createHttpClient(VERSION);

const PROVIDERS: Provider[] = [
  wikipediaProvider,
  stackExchangeProvider,
  registryProvider,
  freeDictionaryProvider,
  wiktionaryProvider,
  datamuseProvider,
];

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
const inFlight = new Map<number, AbortController>();

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

function send(tabId: number, card: Card): void {
  ext.tabs.sendMessage(tabId, { type: 'QL_CARD', card }).catch(() => {
    // The tab navigated away mid-lookup. The abort below handles the rest.
  });
}

/**
 * Adds a translation of the lead sense.
 *
 * Runs after the sources have settled rather than as a provider, because it
 * translates an answer we already have instead of fetching a new one, and
 * because it is the one step that may be unavailable on any given machine.
 */
async function addGloss(card: Card, targetLanguage: string): Promise<boolean> {
  if (!settings.appearance.showGloss) return false;
  const lead = card.slots.gloss?.data ?? card.slots.senses?.data?.[0]?.definition;
  if (!lead) return false;
  const translated = await translate(lead, 'en', targetLanguage);
  if (!translated) return false;
  card.slots.translation = {
    id: 'translation',
    state: 'filled',
    data: { text: translated, lang: targetLanguage, source: 'on-device' },
  };
  if (!card.order.includes('translation')) card.order.push('translation');
  return true;
}

async function handleLookup(
  tabId: number,
  requestId: string,
  text: string,
  page: LookupRequest['page'],
): Promise<void> {
  inFlight.get(tabId)?.abort('superseded');
  const controller = new AbortController();
  inFlight.set(tabId, controller);

  const trimmed = text.slice(0, settings.limits.maxSelectionChars);
  const lang = uiLanguage().split('-')[0] || 'en';
  const decision = routeIntent(extractSignals(trimmed, page), lang);
  const key = lookupKey(trimmed, decision.intent, page.host ?? '', lang);

  const remember = (card: Card) =>
    persistent.recordLookup({
      query: trimmed,
      intent: decision.intent,
      host: page.host ?? '',
      at: Date.now(),
      ...(card.slots.gloss?.data ? { gloss: card.slots.gloss.data } : {}),
    });

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
    const request: LookupRequest = { id: requestId, text: trimmed, uiLang: lang, page };
    const card = await runLookup(
      request,
      decision,
      { http, providers: PROVIDERS },
      {
        signal: controller.signal,
        onUpdate: (partial) => send(tabId, partial),
      },
    );

    if (controller.signal.aborted) return;
    if (await addGloss(card, settings.appearance.glossLanguage)) send(tabId, card);

    // Only cache a card that actually answered. Caching an empty result
    // would make a transient outage stick for a week.
    if (card.sources.some((source) => source !== 'links')) {
      memory.set(key, card);
      void persistent.write(key, card);
    }
    void remember(card);
  } finally {
    clearTimeout(budget);
    if (inFlight.get(tabId) === controller) inFlight.delete(tabId);
  }
}

ext.runtime.onMessage.addListener((message: ToBackground, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'QL_LOOKUP':
      if (tabId === undefined) return false;
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
  // Expired entries are dropped on read, but a key never read again would
  // otherwise occupy storage forever.
  void persistent.prune();
});

ext.runtime.onStartup?.addListener(() => {
  void persistent.prune();
});

ext.contextMenus.onClicked.addListener((info, tab) => {
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
