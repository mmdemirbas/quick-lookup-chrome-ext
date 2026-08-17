/**
 * Toolbar popup. Two jobs: say whether the on-device model is available,
 * and let the current site be quietened without opening the full settings.
 */
import { mergeSettings, triggerModeFor, type TriggerMode } from '../core/settings.ts';
import type { HistoryItem } from '../core/store.ts';
import { ext } from '../platform/browser.ts';
import type { StatusResponse } from '../shared/messages.ts';

const statusBox = document.getElementById('status');
const siteSelect = document.getElementById('siteMode') as HTMLSelectElement | null;
const siteLabel = document.getElementById('siteLabel');
const settingsButton = document.getElementById('settings');

settingsButton?.addEventListener('click', () => ext.runtime.openOptionsPage());

void ext.runtime.sendMessage({ type: 'QL_GET_STATUS' }).then((status: StatusResponse) => {
  if (!statusBox) return;
  const { capabilities, version } = status;
  statusBox.replaceChildren();

  const line = document.createElement('div');
  const strong = document.createElement('b');
  strong.textContent = capabilities.translate
    ? 'On-device translator ready'
    : 'No on-device translator';
  line.append(strong);
  statusBox.append(line);

  const detail = document.createElement('div');
  // Ranking is not conditional on anything the browser provides — it is done
  // against the page, locally, on every lookup — so it is stated the same way
  // either way. Only translation changes with the browser.
  detail.textContent = capabilities.translate
    ? 'Translation stays on this device. Meanings are ranked by page context.'
    : 'Lookups work as normal. Meanings are ranked by page context, and translation can be switched on in settings.';
  statusBox.append(detail);

  const versionLine = document.createElement('div');
  versionLine.textContent = `Version ${version}`;
  statusBox.append(versionLine);
});

/**
 * Recent lookups, starred ones first.
 *
 * Starring is what turns the history from a log into a list worth keeping:
 * a starred entry survives both the size cap and Clear.
 */
function renderHistory(items: HistoryItem[]): void {
  const list = document.getElementById('history');
  if (!list) return;
  list.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Nothing looked up yet.';
    list.append(empty);
    return;
  }

  const ordered = [...items].sort(
    (a, b) => Number(b.starred ?? false) - Number(a.starred ?? false) || b.at - a.at,
  );

  for (const item of ordered.slice(0, 40)) {
    const row = document.createElement('li');

    const star = document.createElement('button');
    star.type = 'button';
    star.className = item.starred ? 'star on' : 'star';
    star.textContent = item.starred ? '★' : '☆';
    star.title = item.starred ? 'Unstar' : 'Keep this one';
    star.addEventListener('click', () => {
      void ext.runtime
        .sendMessage({ type: 'QL_STAR', query: item.query, host: item.host })
        .then((next: HistoryItem[]) => renderHistory(next));
    });

    const word = document.createElement('span');
    word.className = 'word';
    word.textContent = item.query;

    const gloss = document.createElement('span');
    gloss.className = 'gloss';
    gloss.textContent = item.gloss ?? item.host;
    gloss.title = `${item.gloss ?? ''} — ${item.host}`.trim();

    row.append(star, word, gloss);
    list.append(row);
  }
}

document.getElementById('clearHistory')?.addEventListener('click', () => {
  void ext.runtime
    .sendMessage({ type: 'QL_CLEAR_HISTORY' })
    .then((next: HistoryItem[]) => renderHistory(next));
});

void ext.runtime.sendMessage({ type: 'QL_GET_HISTORY' }).then((items: HistoryItem[]) => {
  renderHistory(Array.isArray(items) ? items : []);
});

async function currentHost(): Promise<string | undefined> {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return undefined;
  try {
    return new URL(tab.url).hostname || undefined;
  } catch {
    return undefined;
  }
}

void (async () => {
  const host = await currentHost();
  if (!host || !siteSelect) {
    if (siteSelect) siteSelect.disabled = true;
    return;
  }
  if (siteLabel) siteLabel.textContent = host;

  const settings = mergeSettings(await ext.runtime.sendMessage({ type: 'QL_GET_SETTINGS' }));
  siteSelect.value = triggerModeFor(settings, host);

  siteSelect.addEventListener('change', () => {
    const mode = siteSelect.value as TriggerMode;
    // Matching the global default means there is no rule to keep.
    const value = mode === settings.trigger.mode ? null : mode;
    void ext.runtime.sendMessage({ type: 'QL_SET_SITE_MODE', host, mode: value });
  });
})();
