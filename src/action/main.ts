import { getHistory } from '../background/history';

const root = document.getElementById('root')!;
(async function() {
    const items = await new Promise<any[]>((resolve) => chrome.runtime.sendMessage({ type: 'QL_GET_HISTORY' }, (resp) => resolve(resp?.items || [])));
    const listHtml = items.slice(0, 10).map(it => `<div class="history-item"><span class="when">${new Date(it.when).toLocaleString()}</span> — <span class="q">${it.q}</span></div>`).join('');
    root.innerHTML = `
        <div class="popup-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">
          <h3 style="margin:0;font-size:14px">Recent lookups</h3>
          <button id="openOptionsBtn" title="Open options" style="padding:4px 8px;font-size:12px;cursor:pointer">Options</button>
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
