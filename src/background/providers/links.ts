import type { Provider, Query, Result } from '../../types';
import { getSettings } from '../../shared/settings';

function tmpl(s: string, q: Query) {
    const lang = q.langUI.split('-')[0];
    return s.replaceAll('{q}', encodeURIComponent(q.text)).replaceAll('{lang}', encodeURIComponent(lang));
}

export const linksProvider: Provider = {
    id: 'links', displayName: 'Links', kind: 'link', enabledByDefault: true,
    async query(q: Query): Promise<Result[]> {
        const s = await getSettings();
        const out: Result[] = [];
        for (const it of s.providers.links.items) {
            out.push({ providerId: 'links', title: it.displayName, url: tmpl(it.template, q) });
        }
        return out;
    }
};