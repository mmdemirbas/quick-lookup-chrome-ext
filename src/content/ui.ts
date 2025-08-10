import type { Result } from '../types';

let shadowRoot: ShadowRoot | null = null;
let container: HTMLElement | null = null;
let header: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let currentRequestId: string | null = null;
let pinned = false;
let lastText: string = '';

export function mountUI() {
    const host = document.createElement('div');
    host.id = '__ql_root__';
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483646';
    document.documentElement.appendChild(host);
    shadowRoot = host.attachShadow({ mode: 'open' });

    container = document.createElement('div');
    container.setAttribute('part', 'container');
    container.style.position = 'fixed';
    container.style.minWidth = '320px';
    container.style.minHeight = '200px';
    container.style.maxWidth = '600px';
    container.style.background = 'var(--ql-bg, #161616)';
    container.style.color = 'var(--ql-fg, #f2f2f2)';
    container.style.font = '13px/1.45 system-ui, -apple-system, Segoe UI, Roboto, Arial';
    container.style.border = '1px solid rgba(255,255,255,0.12)';
    container.style.borderRadius = '10px';
    container.style.boxShadow = '0 8px 30px rgba(0,0,0,.35)';
    container.style.overflow = 'hidden';
    container.style.resize = 'both';
    container.style.visibility = 'hidden';

    const style = document.createElement('style');
    style.textContent = `
    :host { all: initial; }
    .ql-header { display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:move; background:rgba(0,0,0,.25); }
    .ql-title { font-weight:600; }
    .ql-actions { margin-left:auto; display:flex; gap:6px; }
    .ql-btn { border:1px solid rgba(255,255,255,.2); background:transparent; color:inherit; border-radius:6px; padding:2px 6px; cursor:pointer; }
    .ql-tabs { display:flex; gap:8px; padding:6px 10px; border-bottom:1px solid rgba(255,255,255,.12); }
    .ql-tab { padding:4px 8px; border-radius:6px; cursor:pointer; }
    .ql-tab.active { background:rgba(255,255,255,.12); }
    .ql-body { padding:10px; max-height:360px; overflow:auto; }
    .ql-card { display:flex; gap:10px; margin-bottom:10px; }
    .ql-card img { width:64px; height:64px; object-fit:cover; border-radius:6px; }
    .ql-links { display:flex; flex-wrap:wrap; gap:8px; }
    .ql-chip { border:1px solid rgba(255,255,255,.2); padding:4px 8px; border-radius:999px; text-decoration:none; color:inherit; }
    .ql-muted { opacity:.8 }
  `;

    header = document.createElement('div');
    header.className = 'ql-header';
    header.innerHTML = `
    <div class="ql-title">Quick Lookup</div>
    <div class="ql-actions">
      <button class="ql-btn" id="ql-pin">Pin</button>
      <button class="ql-btn" id="ql-close">Close</button>
    </div>
  `;

    const tabs = document.createElement('div');
    tabs.className = 'ql-tabs';
    tabs.innerHTML = `
    <div class="ql-tab active" data-tab="overview">Overview</div>
    <div class="ql-tab" data-tab="sources">Sources</div>
    <div class="ql-tab" data-tab="history">History</div>
    <div class="ql-tab" data-tab="settings">Settings</div>
  `;

    bodyEl = document.createElement('div');
    bodyEl.className = 'ql-body';

    container.appendChild(style);
    container.appendChild(header);
    container.appendChild(tabs);
    container.appendChild(bodyEl);
    shadowRoot.appendChild(container);

    // Drag
    let drag = false; let ox = 0; let oy = 0;
    header!.addEventListener('mousedown', (e) => { drag = true; ox = e.clientX - (container!.offsetLeft); oy = e.clientY - (container!.offsetTop); e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (!drag) return; position(Math.max(8, e.clientX - ox), Math.max(8, e.clientY - oy)); });
    window.addEventListener('mouseup', () => drag = false);

    // Buttons
    header!.querySelector('#ql-close')!.addEventListener('click', () => hide());
    header!.querySelector('#ql-pin')!.addEventListener('click', (e) => { pinned = !pinned; (e.target as HTMLButtonElement).textContent = pinned ? 'Unpin' : 'Pin'; });

    // Tabs
    tabs.querySelectorAll('.ql-tab').forEach((el) => {
        el.addEventListener('click', () => {
            tabs.querySelectorAll('.ql-tab').forEach(t => t.classList.remove('active'));
            el.classList.add('active');
            renderTab((el as HTMLElement).dataset.tab as any);
        });
    });

    window.addEventListener('resize', ensureInViewport);
}

function position(x: number, y: number) {
    if (!container) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = container.getBoundingClientRect();
    const w = rect.width || 360, h = rect.height || 240;
    const nx = Math.min(Math.max(8, x), vw - w - 8);
    const ny = Math.min(Math.max(8, y), vh - h - 8);
    container.style.left = nx + 'px';
    container.style.top = ny + 'px';
}

function ensureInViewport() {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    position(rect.left, rect.top);
}

export function openForText(text: string, selectionRect?: DOMRect) {
    if (!container || pinned) return;
    lastText = text;
    if (selectionRect) {
        const x = selectionRect.left + window.scrollX;
        const y = selectionRect.bottom + window.scrollY + 8;
        position(x, y);
    } else {
        position(20, 20);
    }
    container.style.visibility = 'visible';
    renderOverview({ pending: true, text });
}

export function hide() { if (container) container.style.visibility = 'hidden'; }

let aggregate: Result[] = [];

export function receiveResults(requestId: string, reset = false, chunk: Result[] = [], done = false) {
    if (reset) { currentRequestId = requestId; aggregate = []; }
    if (requestId !== currentRequestId) return;
    if (chunk.length) aggregate = aggregate.concat(chunk);
    if (done) renderOverview({ pending: false }); else renderOverview({ pending: true });
}

function renderTab(which: 'overview'|'sources'|'history'|'settings') {
    if (which === 'overview') renderOverview({});
    else if (which === 'sources') renderSources();
    else if (which === 'history') renderHistory();
    else renderSettings();
}

function el(tag: string, cls?: string, text?: string) {
    const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
}

function renderOverview({ pending = false, text = '' }: { pending?: boolean; text?: string } = {}) {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    if (text) bodyEl.appendChild(el('div', 'ql-muted', 'Looking up: ' + text));

    // Translation (links as first-class chips)
    const translateRow = el('div', 'ql-links');
    {
        const t = lastText || text;
        if (t) {
            const lang = (navigator.language || 'en').split('-')[0];
            const gUrl = 'https://translate.google.com/?sl=auto&tl=' + encodeURIComponent(lang) + '&text=' + encodeURIComponent(t) + '&op=translate';
            const dUrl = 'https://www.deepl.com/translate#auto/' + encodeURIComponent(lang) + '/' + encodeURIComponent(t);
            translateRow.appendChild(linkChip('Google Translate', gUrl, 'gtranslate'));
            translateRow.appendChild(linkChip('DeepL', dUrl, 'deepl'));
        }
    }
    bodyEl.appendChild(translateRow);

    // Entity card (prefer first provider with image)
    const entity = aggregate.find(r => r.imageUrl);
    if (entity) {
        const card = el('div', 'ql-card');
        const img = document.createElement('img'); img.src = entity.imageUrl!; card.appendChild(img);
        const meta = el('div');
        meta.appendChild(el('div', '', entity.title || ''));
        if (entity.snippet) meta.appendChild(el('div', 'ql-muted', entity.snippet));
        if (entity.url) { const a = el('a', 'ql-chip', 'Open'); a.setAttribute('href', entity.url); a.setAttribute('target', '_blank'); meta.appendChild(el('div')).appendChild(a); }
        card.appendChild(meta);
        bodyEl.appendChild(card);
    }

    // Dictionary or Wikipedia snippets
    for (const r of aggregate) {
        if (r.providerId === 'dictionary' || r.providerId === 'wikipedia') {
            const d = el('div');
            d.appendChild(el('div', '', `${r.title}`));
            if (r.snippet) d.appendChild(el('div', 'ql-muted', r.snippet));
            if (r.url) { const a = el('a', 'ql-chip', 'Open') as HTMLAnchorElement; a.href = r.url; a.target = '_blank'; d.appendChild(a); }
            bodyEl.appendChild(d);
        }
    }

    // Quick links row (always visible)
    const linksRow = el('div', 'ql-links');
    aggregate.filter(r => r.providerId === 'links').forEach(r => {
        if (r.url && r.title) linksRow.appendChild(linkChip(r.title, r.url));
    });
    bodyEl.appendChild(linksRow);

    if (pending) bodyEl.appendChild(el('div', 'ql-muted', 'Fetching…'));
}

function linkChip(title: string, href: string, kind?: string) {
    const a = document.createElement('a');
    a.className = 'ql-chip'; a.textContent = title; a.href = href; a.target = '_blank';
    return a;
}

function renderSources() {
    if (!bodyEl) return; bodyEl.innerHTML = '';
    for (const r of aggregate) {
        const row = el('div');
        row.appendChild(el('strong', '', `[${r.providerId}] ${r.title}`));
        if (r.snippet) row.appendChild(el('div', 'ql-muted', r.snippet));
        if (r.url) { const a = el('a', 'ql-chip', 'Open') as HTMLAnchorElement; a.href = r.url; a.target = '_blank'; row.appendChild(a); }
        bodyEl!.appendChild(row);
    }
}

function renderHistory() {
    if (!bodyEl) return; bodyEl.innerHTML = '';
    chrome.runtime.sendMessage({ type: 'QL_GET_HISTORY' }, (resp) => {
        const items = resp?.items || [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const row = el('div');
            row.appendChild(el('span', '', new Date(it.when).toLocaleString() + ': ' + it.q));
            const btn = el('button', 'ql-btn', it.bookmarked ? '★' : '☆');
            btn.addEventListener('click', () => {
                chrome.runtime.sendMessage({ type: 'QL_TOGGLE_BOOKMARK', index: i }, (resp2) => { renderHistory(); });
            });
            row.appendChild(btn);
            bodyEl!.appendChild(row);
        }
    });
}

function renderSettings() {
    if (!bodyEl) return; bodyEl.innerHTML = '';
    bodyEl.appendChild(el('div', '', 'Settings are available in the extension Options page.'));
}
