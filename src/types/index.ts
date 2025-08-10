export type Query = { text: string; langUI: string; langDetected?: string; pageUrl?: string };
export type Result = {
    providerId: string;
    title: string;
    snippet?: string;
    url?: string;
    imageUrl?: string;
    extra?: Record<string, any>;
};

export interface Provider {
    id: string;
    displayName: string;
    kind: 'json' | 'link';
    enabledByDefault: boolean;
    query: (q: Query, signal: AbortSignal) => Promise<Result[]>;
}

export type Settings = {
    theme: 'auto' | 'light' | 'dark';
    trigger: { mode: 'selection'; requireModifier: 'none' | 'Alt' | 'Ctrl' | 'Meta' };
    limits: { maxSelectionChars: number; concurrency: number; timeoutMs: number; cacheTtlHrs: number };
    providersOrder: string[];
    providers: {
        ai: {
            enabled: boolean;
            service: 'auto' | 'openai' | 'groq' | 'openrouter' | 'cloudflare' | 'none';
            // Model names per provider
            openaiModel: string;
            groqModel: string;
            openrouterModel: string;
            cloudflareModel: string; // e.g. "@cf/meta/llama-3.1-8b-instruct"
            // API keys / config
            openaiKey: string;
            groqKey: string;
            openrouterKey: string;
            cloudflareKey: string;
            cloudflareAccountId: string;
        };
        translate: { inline: boolean; libreTranslateUrl: string; apiKey: string };
        wikipedia: { enabled: boolean };
        wikidata: { enabled: boolean };
        dictionary: { enabled: boolean; langFallback: string };
        links: { enabled: boolean; items: { id: string; displayName: string; template: string }[] };
    };
};

export type HistoryItem = { q: string; when: number; providers: string[]; bookmarked?: boolean; tags?: string[] };
