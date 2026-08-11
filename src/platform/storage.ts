/**
 * `chrome.storage.local` as the key-value store the core expects.
 *
 * Local rather than sync: the cache would blow past the sync quota within a
 * day, and lookup history is a record of what the reader was reading, which
 * is not something to replicate across devices by default.
 */
import type { KeyValueStore } from '../core/store.ts';
import { ext } from './browser.ts';

export function localStore(): KeyValueStore {
  return {
    async get<T>(keys: string[]): Promise<Record<string, T | undefined>> {
      try {
        return (await ext.storage.local.get(keys)) as Record<string, T | undefined>;
      } catch {
        // Storage can fail when the profile is out of disk. A cache miss is
        // the correct behaviour; the lookup then goes to the network.
        return {};
      }
    },
    async set(items: Record<string, unknown>): Promise<void> {
      try {
        await ext.storage.local.set(items);
      } catch {
        // As above: failing to cache is not a reason to fail the lookup.
      }
    },
    async remove(keys: string[]): Promise<void> {
      try {
        await ext.storage.local.remove(keys);
      } catch {
        // Nothing useful to do; the entry expires on read anyway.
      }
    },
  };
}
