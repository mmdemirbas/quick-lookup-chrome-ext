import type { Provider, Query, Result } from '../../types';

async function fetchJson(url: string, signal: AbortSignal) {
    const r = await fetch(url, { signal, headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('wd failed');
    return r.json();
}

function commonsFileUrl(filename: string, width = 320) {
    // Simpler redirect endpoint; Wikimedia will serve a resized image
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=${width}`;
}

export const wikidataProvider: Provider = {
    id: 'wikidata',
    displayName: 'Wikidata',
    kind: 'json',
    enabledByDefault: true,
    async query(q: Query, signal: AbortSignal): Promise<Result[]> {
        const lang = q.langUI.split('-')[0] || 'en';
        const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=${lang}&search=${encodeURIComponent(q.text)}&origin=*`;
        const s = await fetchJson(searchUrl, signal);
        const hit = s?.search?.[0];
        if (!hit?.id) return [];
        const id = hit.id;
        const entUrl = `https://www.wikidata.org/wiki/Special:EntityData/${id}.json`;
        const ent = await fetchJson(entUrl, signal);
        const entity = ent?.entities?.[id];
        let imageUrl: string | undefined;
        try {
            const claims = entity?.claims?.P18; // image
            if (claims?.length) {
                const fn = claims[0].mainsnak?.datavalue?.value as string;
                imageUrl = commonsFileUrl(fn, 320);
            }
        } catch {}
        const label = entity?.labels?.[lang]?.value || hit.label || q.text;
        const desc = entity?.descriptions?.[lang]?.value || hit.description || '';
        return [{ providerId: 'wikidata', title: label, snippet: desc, url: `https://www.wikidata.org/wiki/${id}`, imageUrl }];
    }
};