import { getHistory } from '../background/history';

const root = document.getElementById('root')!;
(async function() {
    const items = await new Promise<any[]>((resolve) => chrome.runtime.sendMessage({ type: 'QL_GET_HISTORY' }, (resp) => resolve(resp?.items || [])));
    root.innerHTML = '<h3>Recent lookups</h3>' + items.slice(0, 10).map(it => `<div>${new Date(it.when).toLocaleString()} — ${it.q}</div>`).join('');
})();
