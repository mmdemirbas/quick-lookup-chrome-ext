import type { Provider, Query, Result } from '../types';
import { wikipediaProvider } from './providers/wikipedia';
import { wikidataProvider } from './providers/wikidata';
import { dictionaryProvider } from './providers/dictionary';
import { linksProvider } from './providers/links';

export const registry: Record<string, Provider> = {
    wikipedia: wikipediaProvider,
    wikidata: wikidataProvider,
    dictionary: dictionaryProvider,
    links: linksProvider
};

export async function runProviders(ids: string[], q: Query, timeoutMs: number, concurrency = 4,
                                   onChunk?: (r: Result[]) => void): Promise<Result[]> {
    const queue = ids.slice();
    const results: Result[] = [];

    const runOne = async (id: string) => {
        const prov = registry[id];
        if (!prov) return;
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort('timeout'), timeoutMs);
        try {
            const r = await prov.query(q, ac.signal);
            if (r?.length) {
                results.push(...r);
                onChunk?.(r);
            }
        } catch (e) {
            // swallow; provider failed or timed out
        } finally {
            clearTimeout(t);
        }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push((async function loop() {
            while (queue.length) {
                const id = queue.shift()!;
                await runOne(id);
            }
        })());
    }
    await Promise.all(workers);
    return results;
}