import type {Result} from '../types';

let shadowRoot: ShadowRoot | null = null;
let container: HTMLElement | null = null;
let header: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let currentRequestId: string | null = null;
let pinned = false;
let lastText: string = '';
let clickOutsideListener: ((e: Event) => void) | null = null;

export function mountUI() {
    const host = document.createElement('div');
    host.id = '__ql_root__';
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483646';
    document.documentElement.appendChild(host);
    shadowRoot = host.attachShadow({mode: 'open'});

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
    .ql-btn svg { width:16px; height:16px; display:block; }
    .ql-btn.active { background:rgba(255,255,255,.12); }
    .ql-tabs { display:flex; gap:8px; padding:6px 10px; border-bottom:1px solid rgba(255,255,255,.12); }
    .ql-tab { padding:4px 8px; border-radius:6px; cursor:pointer; }
    .ql-tab.active { background:rgba(255,255,255,.12); }
    .ql-body { padding:10px; max-height:360px; overflow:auto; }
    .ql-source-section { margin-bottom:16px; border:1px solid rgba(255,255,255,.1); border-radius:8px; overflow:hidden; }
    .ql-source-header { background:rgba(255,255,255,.08); padding:8px 12px; font-weight:600; font-size:12px; display:flex; justify-content:space-between; align-items:center; }
    .ql-source-content { padding:12px; }
    .ql-source-actions { display:flex; gap:6px; }
    .ql-card { display:flex; gap:10px; margin-bottom:10px; }
    .ql-card img { width:64px; height:64px; object-fit:cover; border-radius:6px; }
    .ql-links { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
    .ql-chip { border:1px solid rgba(255,255,255,.2); padding:4px 8px; border-radius:999px; text-decoration:none; color:inherit; font-size:11px; }
    .ql-chip:hover { background:rgba(255,255,255,.1); }
    .ql-muted { opacity:.8; }
    .ql-truncated { color: #fbbf24; font-size:11px; margin-top:4px; }
  `;

    header = document.createElement('div');
    header.className = 'ql-header';
    header.innerHTML = `
    <div class="ql-title">Quick Lookup</div>
    <div class="ql-actions">
      <button class="ql-btn" id="ql-options" type="button" title="Options" aria-label="Options">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 0 1 7.04 4.3l.06.06c.51.51 1.31.66 1.82.33A1.65 1.65 0 0 0 10.4 3V3a2 2 0 0 1 4 0v.09c0 .7.4 1.31 1 1.51.51.23 1.31.18 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82c.23.51.6 1 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
      <button class="ql-btn" id="ql-pin" type="button" title="Pin" aria-label="Pin">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m9 12 2 2 4-4"/>
          <path d="M21 12c.552 0 1.005-.449.95-.998a10.009 10.009 0 0 0-8.953-8.953c-.549-.055-.998.398-.998.95v2.002c0 .552.449 1.005.998.95a6.002 6.002 0 0 1 5.953 5.953c.055.549-.398.998-.95.998h-2.002z"/>
          <path d="M8.5 12.5 16 5l3 3-7.5 7.5-4 1 1-4Z"/>
        </svg>
      </button>
      <button class="ql-btn" id="ql-close" type="button" title="Close" aria-label="Close">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `;

    const tabs = document.createElement('div');
    tabs.className = 'ql-tabs';
    tabs.innerHTML = `
    <div class="ql-tab active" data-tab="overview">Overview</div>
    <div class="ql-tab" data-tab="sources">Sources</div>
    <div class="ql-tab" data-tab="history">History</div>
  `;

    bodyEl = document.createElement('div');
    bodyEl.className = 'ql-body';

    container.appendChild(style);
    container.appendChild(header);
    container.appendChild(tabs);
    container.appendChild(bodyEl);
    shadowRoot.appendChild(container);

    // Drag
    let drag = false;
    let ox = 0;
    let oy = 0;
    header!.addEventListener('mousedown', (e) => {
        drag = true;
        ox = e.clientX - (container!.offsetLeft);
        oy = e.clientY - (container!.offsetTop);
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!drag) return;
        position(Math.max(8, e.clientX - ox), Math.max(8, e.clientY - oy));
    });
    window.addEventListener('mouseup', () => drag = false);

    // Buttons
    const closeBtn = header!.querySelector('#ql-close') as HTMLButtonElement;
    const pinBtn = header!.querySelector('#ql-pin') as HTMLButtonElement;
    const optionsBtn = header!.querySelector('#ql-options') as HTMLButtonElement;

    closeBtn.addEventListener('click', () => hide());
    pinBtn.addEventListener('click', () => {
        pinned = !pinned;
        pinBtn.classList.toggle('active', pinned);
        pinBtn.setAttribute('aria-pressed', String(pinned));
        pinBtn.title = pinned ? 'Unpin' : 'Pin';
        pinBtn.setAttribute('aria-label', pinned ? 'Unpin' : 'Pin');
    });

    optionsBtn.addEventListener('click', () => {
        // Send message to background script to open options page
        chrome.runtime.sendMessage({type: 'QL_OPEN_OPTIONS'}).catch((error) => {
            console.warn('Failed to open options via background script:', error);
            // Fallback: try opening directly (may not work in all contexts)
            try {
                window.open(chrome.runtime.getURL('options.html'), '_blank');
            } catch (fallbackError) {
                console.error('Failed to open options page:', fallbackError);
            }
        });
    });

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
    setupClickOutsideHandler(); // Enable click-outside detection
    renderOverview({pending: true, text});
}

export function hide() {
    if (container) {
        container.style.visibility = 'hidden';
        removeClickOutsideHandler(); // Clean up click-outside listener
    }
}

let aggregate: Result[] = [];

export function receiveResults(requestId: string, reset = false, chunk: Result[] = [], done = false) {
    if (reset) {
        currentRequestId = requestId;
        aggregate = [];
    }
    if (requestId !== currentRequestId) return;
    if (chunk.length) aggregate = aggregate.concat(chunk);
    if (done) renderOverview({pending: false}); else renderOverview({pending: true});
}

function renderTab(which: 'overview' | 'sources' | 'history' | 'settings') {
    if (which === 'overview') renderOverview({});
    else if (which === 'sources') renderSources();
    else if (which === 'history') renderHistory();
    else renderSettings();
}

function el(tag: string, cls?: string, text?: string) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

function renderOverview({pending = false, text = ''}: { pending?: boolean; text?: string } = {}) {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';

    const queryText = lastText || text;
    const MAX_CHARS = 500; // Practical limit for translation services
    const isTextTruncated = queryText.length > MAX_CHARS;
    const displayText = isTextTruncated ? queryText.substring(0, MAX_CHARS) : queryText;

    // Show query info
    if (queryText) {
        const querySection = el('div', 'ql-source-section');
        const queryHeader = el('div', 'ql-source-header');
        queryHeader.textContent = 'Query';
        querySection.appendChild(queryHeader);

        const queryContent = el('div', 'ql-source-content');
        queryContent.appendChild(el('div', '', `"${displayText}"`));
        if (isTextTruncated) {
            queryContent.appendChild(el('div', 'ql-truncated', `Text truncated to ${MAX_CHARS} characters for processing`));
        }
        querySection.appendChild(queryContent);
        bodyEl.appendChild(querySection);
    }

    // Translation Section (always show if we have text)
    if (queryText) {
        const translationSection = el('div', 'ql-source-section');
        const translationHeader = el('div', 'ql-source-header');
        translationHeader.textContent = 'Translation';

        const translationActions = el('div', 'ql-source-actions');
        const lang = (navigator.language || 'en').split('-')[0];
        const encodedText = encodeURIComponent(displayText);

        // Google Translate button
        const gtBtn = el('a', 'ql-chip', 'Google Translate') as HTMLAnchorElement;
        gtBtn.href = `https://translate.google.com/?sl=auto&tl=${lang}&text=${encodedText}&op=translate`;
        gtBtn.target = '_blank';
        translationActions.appendChild(gtBtn);

        // DeepL button
        const deepLBtn = el('a', 'ql-chip', 'DeepL') as HTMLAnchorElement;
        deepLBtn.href = `https://www.deepl.com/translate#auto/${lang}/${encodedText}`;
        deepLBtn.target = '_blank';
        translationActions.appendChild(deepLBtn);

        translationHeader.appendChild(translationActions);
        translationSection.appendChild(translationHeader);

        const translationContent = el('div', 'ql-source-content');
        translationContent.appendChild(el('div', 'ql-muted', 'Click buttons above to translate this text'));
        translationSection.appendChild(translationContent);

        bodyEl.appendChild(translationSection);
    }

    // AI Summary Section
    const ai = aggregate.find(r => r.providerId === 'ai');
    if (ai?.snippet) {
        const aiSection = el('div', 'ql-source-section');
        const aiHeader = el('div', 'ql-source-header');
        aiHeader.textContent = 'AI Summary';
        if (ai.url) {
            const aiActions = el('div', 'ql-source-actions');
            const aiBtn = el('a', 'ql-chip', 'Open Source') as HTMLAnchorElement;
            aiBtn.href = ai.url;
            aiBtn.target = '_blank';
            aiActions.appendChild(aiBtn);
            aiHeader.appendChild(aiActions);
        }
        aiSection.appendChild(aiHeader);

        const aiContent = el('div', 'ql-source-content');
        aiContent.appendChild(el('div', '', ai.snippet));
        if (ai.extra?.typeHint) {
            const badge = el('div', 'ql-chip', `Type: ${ai.extra.typeHint}`);
            badge.style.marginTop = '8px';
            badge.style.display = 'inline-block';
            aiContent.appendChild(badge);
        }
        aiSection.appendChild(aiContent);

        bodyEl.appendChild(aiSection);
    }

    // Dictionary Section
    const dictionaries = aggregate.filter(r => r.providerId === 'dictionary');
    dictionaries.forEach(dict => {
        const dictSection = el('div', 'ql-source-section');
        const dictHeader = el('div', 'ql-source-header');
        dictHeader.textContent = `Dictionary: ${dict.title}`;
        if (dict.url) {
            const dictActions = el('div', 'ql-source-actions');
            const dictBtn = el('a', 'ql-chip', 'Open Dictionary') as HTMLAnchorElement;
            dictBtn.href = dict.url;
            dictBtn.target = '_blank';
            dictActions.appendChild(dictBtn);
            dictHeader.appendChild(dictActions);
        }
        dictSection.appendChild(dictHeader);

        const dictContent = el('div', 'ql-source-content');
        if (dict.snippet) {
            dictContent.appendChild(el('div', '', dict.snippet));
        }
        dictSection.appendChild(dictContent);

        bodyEl.appendChild(dictSection);
    });

    // Wikipedia Section
    const wikipedia = aggregate.filter(r => r.providerId === 'wikipedia');
    wikipedia.forEach(wiki => {
        const wikiSection = el('div', 'ql-source-section');
        const wikiHeader = el('div', 'ql-source-header');
        wikiHeader.textContent = `Wikipedia: ${wiki.title}`;
        if (wiki.url) {
            const wikiActions = el('div', 'ql-source-actions');
            const wikiBtn = el('a', 'ql-chip', 'Read Article') as HTMLAnchorElement;
            wikiBtn.href = wiki.url;
            wikiBtn.target = '_blank';
            wikiActions.appendChild(wikiBtn);
            wikiHeader.appendChild(wikiActions);
        }
        wikiSection.appendChild(wikiHeader);

        const wikiContent = el('div', 'ql-source-content');
        if (wiki.imageUrl) {
            const img = document.createElement('img');
            img.src = wiki.imageUrl;
            img.style.width = '64px';
            img.style.height = '64px';
            img.style.objectFit = 'cover';
            img.style.borderRadius = '6px';
            img.style.float = 'left';
            img.style.marginRight = '12px';
            wikiContent.appendChild(img);
        }
        if (wiki.snippet) {
            wikiContent.appendChild(el('div', '', wiki.snippet));
        }
        wikiSection.appendChild(wikiContent);

        bodyEl.appendChild(wikiSection);
    });

    // Quick Links Section
    const links = aggregate.filter(r => r.providerId === 'links');
    if (links.length > 0) {
        const linksSection = el('div', 'ql-source-section');
        const linksHeader = el('div', 'ql-source-header');
        linksHeader.textContent = 'Quick Links';
        linksSection.appendChild(linksHeader);

        const linksContent = el('div', 'ql-source-content');
        const linksRow = el('div', 'ql-links');
        links.forEach(link => {
            if (link.url && link.title) {
                const linkBtn = el('a', 'ql-chip', link.title) as HTMLAnchorElement;
                linkBtn.href = link.url;
                linkBtn.target = '_blank';
                linksRow.appendChild(linkBtn);
            }
        });
        linksContent.appendChild(linksRow);
        linksSection.appendChild(linksContent);

        bodyEl.appendChild(linksSection);
    }

    // Loading indicator
    if (pending) {
        const loadingSection = el('div', 'ql-source-section');
        const loadingHeader = el('div', 'ql-source-header');
        loadingHeader.textContent = 'Loading...';
        loadingSection.appendChild(loadingHeader);

        const loadingContent = el('div', 'ql-source-content');
        loadingContent.appendChild(el('div', 'ql-muted', 'Fetching information from various sources...'));
        loadingSection.appendChild(loadingContent);

        bodyEl.appendChild(loadingSection);
    }
}

function linkChip(title: string, href: string, kind?: string) {
    const a = document.createElement('a');
    a.className = 'ql-chip';
    a.textContent = title;
    a.href = href;
    a.target = '_blank';
    return a;
}

function renderSources() {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    for (const r of aggregate) {
        const section = el('div', 'ql-source-section');
        const header = el('div', 'ql-source-header');
        header.appendChild(el('div', '', `[${r.providerId}] ${r.title}`));
        const actions = el('div', 'ql-source-actions');
        actions.appendChild(el('button', 'ql-btn', 'Open'));
        header.appendChild(actions);
        section.appendChild(header);

        const content = el('div', 'ql-source-content');
        content.appendChild(el('div', 'ql-muted', r.snippet));
        if (r.url) {
            const a = el('a', 'ql-chip', 'Open') as HTMLAnchorElement;
            a.href = r.url;
            a.target = '_blank';
            content.appendChild(a);
        }
        section.appendChild(content);

        bodyEl.appendChild(section);
    }
}

function renderHistory() {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    chrome.runtime.sendMessage({type: 'QL_GET_HISTORY'}, (resp) => {
        const items = resp?.items || [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const row = el('div');
            row.appendChild(el('span', '', new Date(it.when).toLocaleString() + ': ' + it.q));
            const btn = el('button', 'ql-btn', it.bookmarked ? '★' : '☆');
            btn.addEventListener('click', () => {
                chrome.runtime.sendMessage({type: 'QL_TOGGLE_BOOKMARK', index: i}, (resp2) => {
                    renderHistory();
                });
            });
            row.appendChild(btn);
            bodyEl!.appendChild(row);
        }
    });
}

function renderSettings() {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    bodyEl.appendChild(el('div', '', 'Settings are available in the extension Options page.'));
}

function setupClickOutsideHandler() {
    // Clean up any existing listener
    if (clickOutsideListener) {
        document.removeEventListener('click', clickOutsideListener, true);
        document.removeEventListener('keydown', handleEscapeKey, true);
        clickOutsideListener = null;
    }

    clickOutsideListener = (e: Event) => {
        // Don't close if pinned or not visible
        if (pinned || !container || container.style.visibility === 'hidden') {
            return;
        }

        const target = e.target as Node;

        // Check if click is inside shadow DOM boundary or the host element
        const hostElement = shadowRoot?.host;
        const composedPath = (e as any).composedPath ? (e as any).composedPath() : [target];
        const isInsideQuickLookup = composedPath.some((node: Node) => 
            node === container ||
            node === hostElement ||
            (shadowRoot && shadowRoot.contains(node)) ||
            (container && container.contains(node))
        );

        // Also check if the target is a text selection (to avoid closing during selection)
        const isTextSelection = window.getSelection()?.toString().trim().length > 0;

        if (!isInsideQuickLookup && !isTextSelection) {
            hide();
        }
    };

    // Use capture phase to ensure we get the event before other handlers
    document.addEventListener('mousedown', clickOutsideListener, true);
    document.addEventListener('keydown', handleEscapeKey, true);
}

function handleEscapeKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && container && container.style.visibility === 'visible' && !pinned) {
        e.preventDefault();
        e.stopPropagation();
        hide();
    }
}

function removeClickOutsideHandler() {
    if (clickOutsideListener) {
        document.removeEventListener('click', clickOutsideListener, true);
        document.removeEventListener('keydown', handleEscapeKey, true);
        clickOutsideListener = null;
    }
}
