import { getHistory } from '../background/history';

const root = document.getElementById('root')!;
(async function() {
    const items = await new Promise<any[]>((resolve) => chrome.runtime.sendMessage({ type: 'QL_GET_HISTORY' }, (resp) => resolve(resp?.items || [])));
    const listHtml = items.slice(0, 10).map(it => `<div class="history-item"><span class="when">${new Date(it.when).toLocaleString()}</span> — <span class="q">${it.q}</span></div>`).join('');
    root.innerHTML = `
        <div class="popup-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">
          <h3 style="margin:0;font-size:14px">Recent lookups</h3>
          <button id="openOptionsBtn" title="Open settings" aria-label="Open settings" style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;background:transparent;cursor:pointer;border-radius:6px;color:#444">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09c.7 0 1.31-.4 1.51-1a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 3.4l.06.06c.5.5 1.22.65 1.82.33.46-.23 1-.35 1.51-.35H11a2 2 0 1 1 4 0h.09c.52 0 1.05.12 1.51.35.6.32 1.32.17 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06c-.5.5-.65 1.22-.33 1.82.23.46.35 1 .35 1.51V11a2 2 0 1 1 0 4h-.09c-.52 0-1.05.12-1.51.35z"></path>
            </svg>
          </button>
        </div>
        <div class="history-list" style="max-height:240px;overflow:auto">${listHtml || '<div style="opacity:0.7">No history yet</div>'}</div>
    `;
    document.getElementById('openOptionsBtn')?.addEventListener('click', () => {
        if (chrome.runtime?.openOptionsPage) {
            chrome.runtime.openOptionsPage();
        } else {
            window.open('options.html', '_blank');
        }
    });
})();
