export function debounce<T extends (...args: any[]) => void>(fn: T, delay = 150) {
    let t: number | undefined;
    return (...args: Parameters<T>) => {
        if (t) clearTimeout(t);
        // @ts-ignore
        t = setTimeout(() => fn(...args), delay) as unknown as number;
    };
}

export function djb2(str: string): string {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
    return (h >>> 0).toString(16);
}

export function detectLanguage(text: string, uiLang: string): string | undefined {
    // Extremely light heuristic: if contains non-ASCII letters, assume not English; otherwise UI lang.
    const hasNonAsciiLetters = /[^\x00-\x7F]/.test(text);
    if (hasNonAsciiLetters) return undefined; // let providers handle locale or use UI language
    return uiLang.split('-')[0];
}

export function looksNamedEntity(text: string): boolean {
    return /[A-Z][a-z]+(?: [A-Z][a-z]+)+/.test(text) || /\(\d{4}\)|S\d+E\d+/i.test(text);
}

export function isSingleWord(text: string): boolean {
    return /^[^\s]+$/.test(text) && text.length <= 30;
}