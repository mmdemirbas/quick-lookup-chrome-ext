/** Settings page. Reads and writes through the service worker. */
import { DEFAULT_SETTINGS, mergeSettings, type Modifier, type Settings, type TriggerMode } from '../core/settings.ts';
import { ext } from '../platform/browser.ts';
import { downloadTranslation, translationAvailability } from '../platform/ai.ts';
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
    // Translation and ranking are separate switches, and translation is by
    // far the more useful of the two, so it comes first and is kept apart.
    // Measured in Brave: with no flags every API is absent; enabling the
    // translation flag alone is enough to make the translator downloadable.
    // Ranking is a separate capability from translating, and a much harder
    // one to obtain: the flags exist in Brave, but the model behind them
    // reported "unavailable" on every machine measured so far. Translation
    // is handled next to the Download button, where the action is.
    box.append(turningOn('To rank meanings by page context', [
      'Open brave://flags and enable "Prompt API for Gemini Nano".',
      'Set "Enables optimization guide on device" to EnabledBypassPerfRequirement.',
      'Restart. The model then has to arrive as a component, which it may never do.',
      'This is optional. Nothing needs it, and translation does not use it at all.',
    ]));
  }
}

/**
 * What to do when the browser exposes no translator at all.
 *
 * Measured, because the obvious advice is wrong: Brave's flags page lists
 * 760 experiments and not one of them is the translation API. It exists
 * only as a launch switch, so telling the reader to "enable a flag" sends
 * them hunting for something that is not there. Chrome needs nothing.
 */
function showAbsentTranslator(): void {
  const row = $('translationRow');
  row.parentElement?.append(
    turningOn('To translate in Brave', [
      'Quit Brave completely.',
      'Run: open -a "Brave Browser" --args --enable-features=TranslationAPI',
      'Brave has no setting for this, so it applies only to launches started that way.',
      'Come back here and press Download.',
    ]),
    turningOn('Or use Chrome', [
      'Chrome 138 and later expose the translator with no flags at all.',
      'Load the extension there and press Download.',
    ]),
  );
}

function turningOn(title: string, steps: string[]): HTMLElement {
  const wrap = document.createElement('div');
  const heading = document.createElement('div');
  heading.className = 'headline';
  heading.textContent = title;
  const list = document.createElement('ol');
  for (const step of steps) {
    const li = document.createElement('li');
    li.textContent = step;
    list.append(li);
  }
  wrap.append(heading, list);
  return wrap;
}

/**
 * Status of the language pair the gloss is written in, and the one control
 * that can change it.
 *
 * A language pack is a large download that the browser only performs when
 * asked, so it needs a button: without one the translate path could never
 * become live no matter how long the reader waited. Every state the browser
 * can report gets its own sentence, because "unavailable" and "not
 * downloaded yet" call for completely different actions.
 */
async function renderTranslation(): Promise<void> {
  const label = $('translationLabel');
  const button = $<HTMLButtonElement>('downloadTranslation');
  const target = fields.glossLanguage.value;
  const name = fields.glossLanguage.selectedOptions[0]?.textContent ?? target;

  const show = (text: string, offer: boolean) => {
    label.textContent = text;
    button.hidden = !offer;
    button.disabled = !offer;
  };

  show('Checking the translation model…', false);
  const state = await translationAvailability('en', target);

  switch (state) {
    case 'available':
      show(`English to ${name} is ready and runs on this device.`, false);
      return;
    case 'downloadable':
      show(`English to ${name} needs a one-time download.`, true);
      break;
    case 'downloading':
      show(`English to ${name} is downloading. It will start working on its own.`, false);
      return;
    case 'absent':
      show('This browser does not expose a built-in translator.', false);
      showAbsentTranslator();
      return;
    default:
      show(`This device cannot run English to ${name} translation.`, false);
      return;
  }

  button.onclick = async () => {
    button.disabled = true;
    label.textContent = `Downloading English to ${name}…`;
    const settled = await downloadTranslation('en', target, (fraction) => {
      label.textContent = `Downloading English to ${name}… ${Math.round(fraction * 100)}%`;
    });
    if (settled === 'available') {
      show(`English to ${name} is ready and runs on this device.`, false);
    } else {
      // Refused, cancelled or failed. Say so and leave the button usable.
      show(`The download did not finish. English to ${name} is still unavailable.`, true);
    }
  };
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

// The pair depends on the chosen language, so the status follows the select
// rather than only the page load.
fields.glossLanguage.addEventListener('change', () => void renderTranslation());
void renderTranslation();
