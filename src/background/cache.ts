import type { Result } from '../types';
import { djb2 } from '../shared/util';

const NS = 'cache-v1';

export type CacheEntry = { value: Result[]; expiresAt: number };

export function cacheKey(text: string, providerId?: string): string {
    return `${NS}:${djb2(text + '|' + (providerId || 'all'))}`;
}

export async function getCache(text: string, providerId?: string): Promise<Result[] | null> {
    const key = cacheKey(text, providerId);
    const obj = await chrome.storage.local.get(key);
    const entry = obj[key] as CacheEntry | undefined;
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry.value;
}

export async function setCache(text: string, value: Result[], ttlHours: number, providerId?: string) {
    const key = cacheKey(text, providerId);
    const entry: CacheEntry = { value, expiresAt: Date.now() + ttlHours * 3600 * 1000 };
    await chrome.storage.local.set({ [key]: entry });
}