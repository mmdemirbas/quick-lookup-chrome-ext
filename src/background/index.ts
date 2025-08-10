import type { Query, Result } from '../types';
import { getSettings } from '../shared/settings';
import { detectLanguage } from '../shared/util';
import { runProviders } from './provider-registry';
import { planProviders } from './planner';
import { getCache, setCache } from './cache';
import { pushHistory, getHistory, toggleBookmark } from './history';

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: 'quick-lookup', title: 'Quick Lookup "%s"', contexts: ['selection'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'quick-lookup' && info.selectionText && tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'QL_OPEN_FOR', text: info.selectionText });
    }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        if (msg?.type === 'QL_QUERY') {
            const tabId = sender.tab?.id;
            if (!tabId) return;

            const settings = await getSettings();
            const uiLang = settings?.providers?.dictionary?.langFallback || 'en';
            const query: Query = {
                text: msg.text,
                langUI: navigator.language || uiLang,
                langDetected: detectLanguage(msg.text, navigator.language || uiLang),
                pageUrl: sender.tab?.url
            };

            const requestId: string = msg.requestId;
            const plan = planProviders(query, settings.providersOrder);

            // Serve cached aggregate if exists
            const cachedAll = await getCache(query.text);
            if (cachedAll) {
                chrome.tabs.sendMessage(tabId, { type: 'QL_RESULTS', requestId, results: cachedAll, done: true });
                return;
            }

            const partial: Result[] = [];
            chrome.tabs.sendMessage(tabId, { type: 'QL_RESULTS', requestId, results: [], done: false });

            const all = await runProviders(plan, query, settings.limits.timeoutMs, settings.limits.concurrency, (chunk) => {
                partial.push(...chunk);
                chrome.tabs.sendMessage(tabId, { type: 'QL_RESULTS', requestId, results: chunk, done: false });
            });

            await setCache(query.text, all, settings.limits.cacheTtlHrs);
            await pushHistory(query.text, plan);
            chrome.tabs.sendMessage(tabId, { type: 'QL_RESULTS', requestId, results: [], done: true });
            sendResponse({ ok: true });
        }

        if (msg?.type === 'QL_GET_HISTORY') {
            const items = await getHistory();
            sendResponse({ items });
        }

        if (msg?.type === 'QL_TOGGLE_BOOKMARK') {
            await toggleBookmark(msg.index);
            const items = await getHistory();
            sendResponse({ items });
        }

        if (msg?.type === 'QL_GET_SETTINGS') {
            const s = await getSettings();
            sendResponse({ settings: s });
        }

    })();
    return true; // keep channel open for async
});
