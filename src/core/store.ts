/**
 * Persistence policy: what is kept, for how long, and what is dropped first.
 *
 * The storage itself is injected, so eviction and history rules are testable
 * without a browser. Two shapes live here because they have opposite
 * requirements: the cache is keyed and evicted by age, while history is
 * ordered and evicted by count.
 *
 * Cache entries are stored one key per entry rather than as one large map.
 * A single map would have to be read and rewritten on every lookup, which
 * is the opposite of what a cache is for. Only the index — a short list of
 * key and timestamp pairs — is read whole.
 */

export type KeyValueStore = {
  get<T>(keys: string[]): Promise<Record<string, T | undefined>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

export type CacheEntry<V> = { value: V; storedAt: number };

const ENTRY_PREFIX = 'c:';
const INDEX_KEY = 'cacheIndex';
const HISTORY_KEY = 'history';

export type HistoryItem = {
  query: string;
  intent: string;
  host: string;
  at: number;
  gloss?: string;
  starred?: boolean;
};

export type StoreOptions = {
  maxEntries: number;
  ttlMs: number;
  maxHistory: number;
  now?: () => number;
};

type IndexRow = [key: string, storedAt: number];

export class PersistentStore<V> {
  readonly #store: KeyValueStore;
  readonly #max: number;
  readonly #ttl: number;
  readonly #maxHistory: number;
  readonly #now: () => number;

  constructor(store: KeyValueStore, options: StoreOptions) {
    this.#store = store;
    this.#max = Math.max(1, options.maxEntries);
    this.#ttl = options.ttlMs;
    this.#maxHistory = Math.max(1, options.maxHistory);
    this.#now = options.now ?? (() => Date.now());
  }

  async read(key: string): Promise<V | undefined> {
    const storageKey = ENTRY_PREFIX + key;
    const found = await this.#store.get<CacheEntry<V>>([storageKey]);
    const entry = found[storageKey];
    if (!entry) return undefined;
    if (this.#now() - entry.storedAt > this.#ttl) {
      await this.#store.remove([storageKey]);
      return undefined;
    }
    return entry.value;
  }

  async write(key: string, value: V): Promise<void> {
    const storedAt = this.#now();
    const storageKey = ENTRY_PREFIX + key;
    await this.#store.set({ [storageKey]: { value, storedAt } satisfies CacheEntry<V> });

    const index = await this.#index();
    const next: IndexRow[] = [[key, storedAt], ...index.filter(([k]) => k !== key)];

    const keep = next.slice(0, this.#max);
    const drop = next.slice(this.#max);
    await this.#store.set({ [INDEX_KEY]: keep });
    if (drop.length > 0) await this.#store.remove(drop.map(([k]) => ENTRY_PREFIX + k));
  }

  async #index(): Promise<IndexRow[]> {
    const found = await this.#store.get<IndexRow[]>([INDEX_KEY]);
    const index = found[INDEX_KEY];
    return Array.isArray(index) ? index : [];
  }

  /** Drops everything past the time to live. Cheap: only the index is read. */
  async prune(): Promise<number> {
    const index = await this.#index();
    const cutoff = this.#now() - this.#ttl;
    const stale = index.filter(([, at]) => at <= cutoff);
    if (stale.length === 0) return 0;
    await this.#store.set({ [INDEX_KEY]: index.filter(([, at]) => at > cutoff) });
    await this.#store.remove(stale.map(([k]) => ENTRY_PREFIX + k));
    return stale.length;
  }

  async clear(): Promise<void> {
    const index = await this.#index();
    await this.#store.remove([INDEX_KEY, ...index.map(([k]) => ENTRY_PREFIX + k)]);
  }

  async history(): Promise<HistoryItem[]> {
    const found = await this.#store.get<HistoryItem[]>([HISTORY_KEY]);
    const items = found[HISTORY_KEY];
    return Array.isArray(items) ? items : [];
  }

  /**
   * Records a lookup.
   *
   * Repeating the same query on the same site moves the existing entry to
   * the top rather than adding a row, so scanning a paragraph twice does not
   * bury everything else. Starred entries survive the cap.
   */
  async recordLookup(item: HistoryItem): Promise<HistoryItem[]> {
    const existing = await this.history();
    const same = (other: HistoryItem) =>
      other.query.toLowerCase() === item.query.toLowerCase() && other.host === item.host;

    const previous = existing.find(same);
    const merged: HistoryItem = previous?.starred ? { ...item, starred: true } : item;
    const next = [merged, ...existing.filter((other) => !same(other))];

    const kept = next.filter((entry, i) => i < this.#maxHistory || entry.starred);
    await this.#store.set({ [HISTORY_KEY]: kept });
    return kept;
  }

  async toggleStar(query: string, host: string): Promise<HistoryItem[]> {
    const items = await this.history();
    const next = items.map((item) =>
      item.query === query && item.host === host ? { ...item, starred: !item.starred } : item,
    );
    await this.#store.set({ [HISTORY_KEY]: next });
    return next;
  }

  async clearHistory(): Promise<void> {
    const items = await this.history();
    await this.#store.set({ [HISTORY_KEY]: items.filter((item) => item.starred) });
  }
}
