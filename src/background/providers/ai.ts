import type { Provider, Query, Result } from '../../types';
import { getSettings } from '../../shared/settings';

type Service = 'openai' | 'groq' | 'openrouter' | 'cloudflare';

function chooseService(): { service?: Service } {
    // Prefer free tiers by default: groq -> openrouter -> cloudflare -> openai
    return { service: undefined }; // actual choice is done after reading keys
}

function buildPrompt(q: Query) {
    const uiLang = q.langUI?.split('-')[0] || 'en';
    // Keep it short for speed
    return `You are a concise assistant. Return ONLY valid JSON.

Input:
- UI language: ${uiLang}
- Text: """${q.text}"""

Return JSON object like:
{"summary": "2–3 lines helpful summary in UI language", "typeHint": "movie|actor|person|animal|place|organization|term|other"}
`;
}

function extractJson(text: string): { summary?: string; typeHint?: string } {
    try { return JSON.parse(text); } catch {}
    // Try to find the first {...} block
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
        try { return JSON.parse(m[0]); } catch {}
    }
    return {};
}

async function callOpenAI(model: string, key: string, prompt: string, signal: AbortSignal): Promise<string | null> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
                { role: 'system', content: 'Return only compact JSON. No prose.' },
                { role: 'user', content: prompt }
            ]
        }),
        signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || null;
}

async function callGroq(model: string, key: string, prompt: string, signal: AbortSignal): Promise<string | null> {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
                { role: 'system', content: 'Return only compact JSON. No prose.' },
                { role: 'user', content: prompt }
            ]
        }),
        signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || null;
}

async function callOpenRouter(model: string, key: string, prompt: string, signal: AbortSignal): Promise<string | null> {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
                { role: 'system', content: 'Return only compact JSON. No prose.' },
                { role: 'user', content: prompt }
            ]
        }),
        signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || null;
}

async function callCloudflare(accountId: string, model: string, key: string, prompt: string, signal: AbortSignal): Promise<string | null> {
    // Workers AI "run" API for instruct models
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${encodeURIComponent(model)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
            messages: [
                { role: 'system', content: 'Return only compact JSON. No prose.' },
                { role: 'user', content: prompt }
            ]
        }),
        signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Commonly response is in data.result.response or result.output_text depending on model
    return data?.result?.response || data?.result?.output_text || null;
}

export const aiProvider: Provider = {
    id: 'ai',
    displayName: 'AI Summary',
    kind: 'json',
    enabledByDefault: true,
    async query(q: Query, signal: AbortSignal): Promise<Result[]> {
        const s = await getSettings();
        const cfg = s.providers.ai;
        if (!cfg?.enabled) return [];

        const prompt = buildPrompt(q);

        // Auto-select service by available keys: prefer free first
        const candidates: Array<{ svc: Service; ok: boolean }> = [
            { svc: 'groq', ok: !!cfg.groqKey },
            { svc: 'openrouter', ok: !!cfg.openrouterKey },
            { svc: 'cloudflare', ok: !!(cfg.cloudflareKey && cfg.cloudflareAccountId) },
            { svc: 'openai', ok: !!cfg.openaiKey }
        ];
        let selected: Service | undefined;
        if (cfg.service === 'auto') {
            selected = candidates.find(c => c.ok)?.svc;
        } else if (cfg.service !== 'none') {
            selected = cfg.service as Service;
        }

        let text: string | null = null;
        try {
            if (selected === 'groq' && cfg.groqKey) {
                text = await callGroq(cfg.groqModel, cfg.groqKey, prompt, signal);
            } else if (selected === 'openrouter' && cfg.openrouterKey) {
                text = await callOpenRouter(cfg.openrouterModel, cfg.openrouterKey, prompt, signal);
            } else if (selected === 'cloudflare' && cfg.cloudflareKey && cfg.cloudflareAccountId) {
                text = await callCloudflare(cfg.cloudflareAccountId, cfg.cloudflareModel, cfg.cloudflareKey, prompt, signal);
            } else if (selected === 'openai' && cfg.openaiKey) {
                text = await callOpenAI(cfg.openaiModel, cfg.openaiKey, prompt, signal);
            }
        } catch {
            // Ignore errors/timeouts
        }

        if (!text) return [];
        const obj = extractJson(text);
        const summary = (obj.summary || '').toString().trim();
        const typeHint = (obj.typeHint || '').toString().trim();

        if (!summary) return [];
        const result: Result = {
            providerId: 'ai',
            title: 'AI Summary',
            snippet: summary,
            extra: { typeHint, raw: obj }
        };
        return [result];
    }
};
