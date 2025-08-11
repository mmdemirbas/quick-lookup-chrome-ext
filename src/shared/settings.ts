import type { Settings } from '../types';

const DEFAULT_SETTINGS: Settings = {
    theme: 'auto',
    trigger: { mode: 'selection', requireModifier: 'none' },
    limits: { maxSelectionChars: 300, concurrency: 4, timeoutMs: 1500, cacheTtlHrs: 24 },
    providersOrder: ['ai', 'wikipedia', 'wikidata', 'dictionary', 'links'],
    providers: {
        ai: {
            enabled: true,
            service: 'auto',
            openaiModel: 'gpt-4o-mini',
            groqModel: 'llama-3.1-8b-instant',
            openrouterModel: 'meta-llama/llama-3.1-8b-instruct:free',
            cloudflareModel: '@cf/meta/llama-3.1-8b-instruct',
            openaiKey: '',
            groqKey: '',
            openrouterKey: '',
            cloudflareKey: '',
            cloudflareAccountId: ''
        },
        wikipedia: { enabled: true },
        wikidata: { enabled: true },
        dictionary: { enabled: true, langFallback: 'en' },
        links: {
            enabled: true,
            items: [
                { id: 'google', displayName: 'Google', template: 'https://www.google.com/search?q={q}' },
                { id: 'mdn', displayName: 'MDN', template: 'https://developer.mozilla.org/search?q={q}' },
                { id: 'imdb', displayName: 'IMDB', template: 'https://www.imdb.com/find/?q={q}' },
                { id: 'deepl', displayName: 'DeepL', template: 'https://www.deepl.com/translate#auto/{lang}/{q}' },
                { id: 'gtranslate', displayName: 'Google Translate', template: 'https://translate.google.com/?sl=auto&tl={lang}&text={q}&op=translate' }
            ]
        }
    }
};

export async function getSettings(): Promise<Settings> {
    const data = await chrome.storage.sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...(data.settings || {}) } as Settings;
}

export async function saveSettings(s: Settings): Promise<void> {
    await chrome.storage.sync.set({ settings: s });
}

export { DEFAULT_SETTINGS };