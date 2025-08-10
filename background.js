// Context menu for selected text
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "quick-lookup",
        title: 'Quick Lookup “%s”',
        contexts: ["selection"]
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "quick-lookup" && tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "OPEN_FOR_TEXT", text: info.selectionText });
    }
});

// Fetch utilities with timeout
async function fetchJSON(url, timeoutMs = 1500, headers = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers, signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(t);
    }
}

// Wikipedia summary (locale-aware)
async function wikipediaSummary(q, lang = "en") {
    const safeLang = (lang || "en").split("-")[0].toLowerCase();
    const base = `https://${safeLang}.wikipedia.org/api/rest_v1/page/summary/` +
        encodeURIComponent(q.trim());
    try {
        const j = await fetchJSON(base, 1500, { "Accept": "application/json" });
        return {
            providerId: "wikipedia",
            title: j.title || q,
            snippet: j.extract || "",
            url: j?.content_urls?.desktop?.page || j?.content_urls?.mobile?.page,
            imageUrl: j?.thumbnail?.source || j?.originalimage?.source || null
        };
    } catch (e) {
        return { providerId: "wikipedia", title: q, snippet: "No summary found.", url: null, imageUrl: null };
    }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "LOOKUP") {
        (async () => {
            const { text, langUI } = msg;
            const res = await wikipediaSummary(text, langUI);
            sendResponse({ ok: true, results: [res] });
        })();
        return true; // async
    }
});
