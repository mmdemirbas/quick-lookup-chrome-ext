import type { Provider, Query, Result } from '../../types';

export const dictionaryProvider: Provider = {
    id: 'dictionary',
    displayName: 'Dictionary',
    kind: 'json',
    enabledByDefault: true,
    async query(q: Query, signal: AbortSignal): Promise<Result[]> {
        const lang = (q.langDetected || q.langUI || 'en').split('-')[0];
        const url = `https://api.dictionaryapi.dev/api/v2/entries/${encodeURIComponent(lang)}/${encodeURIComponent(q.text)}`;
        const r = await fetch(url, { signal });
        if (!r.ok) return [];
        const j = await r.json();
        const defs: Result[] = [];
        try {
            const arr = Array.isArray(j) ? j : [];
            for (const entry of arr.slice(0, 2)) {
                const word = entry.word || q.text;
                const meanings = entry.meanings || [];
                const def = meanings[0]?.definitions?.[0]?.definition;
                if (def) defs.push({ providerId: 'dictionary', title: word, snippet: def, url: `https://api.dictionaryapi.dev/#${encodeURIComponent(word)}` });
            }
        } catch {}
        return defs.slice(0, 2);
    }
};
