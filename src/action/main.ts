/**
 * Toolbar popup. Three jobs: say whether the browser has a translator, let
 * the current site be quietened without opening the full settings, and open
 * the panel — one of the two places a browser will accept that request from.
 */
import { mergeSettings, triggerModeFor, type TriggerMode } from '../core/settings.ts';
import type { HistoryItem } from '../core/store.ts';
import { renderHistory as drawHistory } from '../shared/history-list.ts';
import { openPanel } from '../shared/panel.ts';
import { ext } from '../platform/browser.ts';
import type { StatusResponse } from '../shared/messages.ts';

const statusBox = document.getElementById('status');
const siteSelect = document.getElementById('siteMode') as HTMLSelectElement | null;
const siteLabel = document.getElementById('siteLabel');
const settingsButton = document.getElementById('settings');

settingsButton?.addEventListener('click', () => ext.runtime.openOptionsPage());

/**
 * Read now rather than in the handler. Firefox requires the sidebar to be
 * opened from inside a user-action handler, and an await ends that handler
 * before the call is made.
 */
let windowId: number | undefined;
void ext.windows?.getCurrent().then((window) => {
  windowId = window.id;
});

document.getElementById('openPanel')?.addEventListener('click', () => {
  openPanel(windowId);
  // The popup closes itself when it loses focus to the panel, but not
  // reliably on every browser, and a popup left open over a panel is in
  // the way of the thing it just opened.
  window.close();
});

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

/** The popup lists what was looked up; the panel is where one can be reopened. */
function renderHistory(items: HistoryItem[]): void {
  const list = document.getElementById('history');
  if (list) drawHistory(items, { list });
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
    // Otherwise the row reads "This site: …" beside a control nothing can
    // explain. There is no site: the popup was opened over a new tab, a
    // settings page, or the store.
    if (siteLabel) siteLabel.textContent = 'no page to look things up on';
    return;
  }
  // Into the span, not over the label. Replacing the whole label left the
  // select announcing as the bare hostname, with nothing saying what it
  // does — the popup's only control, and unnamed to anyone listening.
  if (siteLabel) {
    siteLabel.textContent = host;
    siteLabel.title = host;
  }

  const settings = mergeSettings(await ext.runtime.sendMessage({ type: 'QL_GET_SETTINGS' }));
  siteSelect.value = triggerModeFor(settings, host);

  siteSelect.addEventListener('change', () => {
    const mode = siteSelect.value as TriggerMode;
    // Matching the global default means there is no rule to keep.
    const value = mode === settings.trigger.mode ? null : mode;
    void ext.runtime.sendMessage({ type: 'QL_SET_SITE_MODE', host, mode: value });
  });
})();
