import type { Provider, Query, Result } from '../../types';

function wpLang(ui: string) { return ui.split('-')[0] || 'en'; }

export const wikipediaProvider: Provider = {
    id: 'wikipedia',
    displayName: 'Wikipedia',
    kind: 'json',
    enabledByDefault: true,
    async query(q: Query, signal: AbortSignal): Promise<Result[]> {
        const lang = wpLang(q.langUI);
        const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q.text)}`;
        const res = await fetch(url, { signal, headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error('wp failed');
        const j = await res.json();
        if (!j || !j.title) return [];
        return [{
            providerId: 'wikipedia',
            title: j.title,
            snippet: j.extract,
            url: j?.content_urls?.desktop?.page,
            imageUrl: j?.thumbnail?.source
        }];
    }
};
