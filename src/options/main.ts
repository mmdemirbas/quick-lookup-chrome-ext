/** Settings page. Reads and writes through the service worker. */
import { DEFAULT_SETTINGS, mergeSettings, type Modifier, type Settings, type TriggerMode } from '../core/settings.ts';
import { ext } from '../platform/browser.ts';
import type { StatusResponse } from '../shared/messages.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element: ${id}`);
  return el as T;
};

const fields = {
  mode: $<HTMLSelectElement>('mode'),
  modifier: $<HTMLSelectElement>('modifier'),
  dwell: $<HTMLInputElement>('dwell'),
  maxWords: $<HTMLInputElement>('maxWords'),
  inEditable: $<HTMLInputElement>('inEditable'),
  showGloss: $<HTMLInputElement>('showGloss'),
  glossLanguage: $<HTMLSelectElement>('glossLanguage'),
};

let settings: Settings = DEFAULT_SETTINGS;

function fill(next: Settings): void {
  settings = next;
  fields.mode.value = next.trigger.mode;
  fields.modifier.value = next.trigger.modifier;
  fields.dwell.value = String(next.trigger.dwellMs);
  fields.maxWords.value = String(next.trigger.maxWords);
  fields.inEditable.checked = next.trigger.inEditable;
  fields.showGloss.checked = next.appearance.showGloss;
  fields.glossLanguage.value = next.appearance.glossLanguage;
  renderSites();
}

function collect(): Settings {
  return mergeSettings({
    ...settings,
    trigger: {
      ...settings.trigger,
      mode: fields.mode.value as TriggerMode,
      modifier: fields.modifier.value as Modifier,
      dwellMs: Number(fields.dwell.value) || DEFAULT_SETTINGS.trigger.dwellMs,
      maxWords: Number(fields.maxWords.value) || DEFAULT_SETTINGS.trigger.maxWords,
      inEditable: fields.inEditable.checked,
    },
    appearance: {
      ...settings.appearance,
      showGloss: fields.showGloss.checked,
      glossLanguage: fields.glossLanguage.value,
    },
  });
}

function renderSites(): void {
  const list = $<HTMLUListElement>('sites');
  const hosts = Object.keys(settings.sites).sort();
  list.replaceChildren();

  if (hosts.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No site rules yet.';
    list.append(empty);
    return;
  }

  for (const host of hosts) {
    const item = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = host;

    const select = document.createElement('select');
    for (const [value, label] of [
      ['auto', 'Open the card'],
      ['handle', 'Show a handle'],
      ['modifier', 'Only with modifier'],
      ['off', 'Do nothing'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = settings.sites[host]?.mode ?? 'auto';
    select.addEventListener('change', () => {
      settings.sites[host] = { mode: select.value as TriggerMode };
    });

    const remove = document.createElement('button');
    remove.className = 'secondary';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      delete settings.sites[host];
      renderSites();
    });

    item.append(name, select, remove);
    list.append(item);
  }
}

/**
 * Reports what the on-device model can do here.
 *
 * When nothing is available in a Chromium browser the most likely reason is
 * Brave, where the component is behind two flags and a manual download, so
 * the exact steps are shown rather than a bare "unavailable".
 */
function renderStatus(status: StatusResponse): void {
  const box = $('status');
  const { capabilities } = status;
  box.replaceChildren();

  const headline = document.createElement('div');
  headline.className = 'headline';
  const abilities = [
    capabilities.detect && 'detect language',
    capabilities.translate && 'translate',
    capabilities.generate && 'rank and phrase',
  ].filter(Boolean);
  headline.textContent = abilities.length
    ? `Available: ${abilities.join(', ')}.`
    : 'No on-device model available.';

  const reason = document.createElement('div');
  reason.textContent = capabilities.reason;

  const note = document.createElement('div');
  note.textContent =
    'Every answer works without it. The model only ranks meanings and translates — it is never the source of a fact.';

  box.append(headline, reason, note);

  if (!capabilities.generate) {
    const steps = document.createElement('ol');
    for (const step of [
      'Open brave://flags and enable "Prompt API for Gemini Nano".',
      'Set "Enables optimization guide on device" to EnabledBypassPrefRequirement.',
      'Restart, then open brave://components and update "Optimization Guide On Device Model".',
      'The download is large and is skipped on metered connections.',
    ]) {
      const li = document.createElement('li');
      li.textContent = step;
      steps.append(li);
    }
    box.append(steps);
  }
}

function flashSaved(): void {
  const saved = $('saved');
  saved.classList.add('show');
  setTimeout(() => saved.classList.remove('show'), 1400);
}

$('save').addEventListener('click', () => {
  void ext.runtime
    .sendMessage({ type: 'QL_SAVE_SETTINGS', settings: collect() })
    .then((stored) => {
      fill(mergeSettings(stored));
      flashSaved();
    });
});

$('reset').addEventListener('click', () => {
  void ext.runtime
    .sendMessage({ type: 'QL_SAVE_SETTINGS', settings: structuredClone(DEFAULT_SETTINGS) })
    .then((stored) => {
      fill(mergeSettings(stored));
      flashSaved();
    });
});

void ext.runtime.sendMessage({ type: 'QL_GET_SETTINGS' }).then((stored) => {
  fill(mergeSettings(stored));
});

void ext.runtime.sendMessage({ type: 'QL_GET_STATUS' }).then((status: StatusResponse) => {
  renderStatus(status);
});
