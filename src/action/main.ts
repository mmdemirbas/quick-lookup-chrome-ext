/**
 * Toolbar popup. Two jobs: say whether the on-device model is available,
 * and let the current site be quietened without opening the full settings.
 */
import { mergeSettings, triggerModeFor, type TriggerMode } from '../core/settings.ts';
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
  strong.textContent = capabilities.generate
    ? 'On-device model ready'
    : capabilities.translate
      ? 'Translation only'
      : 'No on-device model';
  line.append(strong);
  statusBox.append(line);

  const detail = document.createElement('div');
  detail.textContent = capabilities.generate
    ? 'Meanings are ranked for the page you are on.'
    : 'Lookups work as normal. Meanings are ranked by page context without a model.';
  statusBox.append(detail);

  const versionLine = document.createElement('div');
  versionLine.textContent = `Version ${version}`;
  statusBox.append(versionLine);
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
