import type { HistoryItem } from '../types';

const KEY = 'history-v1';
const MAX = 200;

export async function pushHistory(q: string, providers: string[]): Promise<void> {
    const data = await chrome.storage.local.get(KEY);
    const items: HistoryItem[] = data[KEY] || [];
    items.unshift({ q, when: Date.now(), providers });
    if (items.length > MAX) items.length = MAX;
    await chrome.storage.local.set({ [KEY]: items });
}

export async function getHistory(): Promise<HistoryItem[]> {
    const data = await chrome.storage.local.get(KEY);
    return (data[KEY] || []) as HistoryItem[];
}

export async function toggleBookmark(index: number): Promise<void> {
    const data = await chrome.storage.local.get(KEY);
    const items: HistoryItem[] = data[KEY] || [];
    if (!items[index]) return;
    items[index].bookmarked = !items[index].bookmarked;
    await chrome.storage.local.set({ [KEY]: items });
}
