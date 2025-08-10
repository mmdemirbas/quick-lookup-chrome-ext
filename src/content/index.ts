import { debounce } from '../shared/util';
import { mountUI, openForText, receiveResults } from './ui';

let requireModifier: 'none' | 'Alt' | 'Ctrl' | 'Meta' = 'none';

mountUI();

chrome.runtime.sendMessage({ type: 'QL_GET_SETTINGS' }, (resp) => {
    requireModifier = resp?.settings?.trigger?.requireModifier || 'none';
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'QL_OPEN_FOR' && msg.text) {
        openForText(msg.text);
    }
});

const doQuery = debounce((text: string) => {
    const requestId = Math.random().toString(36).slice(2);
    receiveResults(requestId, true); // reset UI for new request
    chrome.runtime.sendMessage({ type: 'QL_QUERY', text, requestId });
}, 150);

function getSelectionText(): { text: string, rect: DOMRect } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    try {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        return { text, rect };
    } catch { return null; }
}

function modifierOk(ev: MouseEvent): boolean {
    if (requireModifier === 'none') return true;
    if (requireModifier === 'Alt') return ev.altKey;
    if (requireModifier === 'Ctrl') return ev.ctrlKey;
    if (requireModifier === 'Meta') return ev.metaKey;
    return true;
}

document.addEventListener('mouseup', (ev) => {
    if (!modifierOk(ev)) return;
    const s = getSelectionText();
    if (!s) return;
    openForText(s.text, s.rect);
    doQuery(s.text);
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'QL_RESULTS') {
        receiveResults(msg.requestId, msg.done, msg.results || []);
    }
});