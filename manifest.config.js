/**
 * Single source of truth for the extension manifest.
 *
 * Two targets share almost everything. Chromium covers Brave, Chrome and
 * Edge; Firefox differs in how the background script and the extension id
 * are declared. Keeping one file means a permission can never be added to
 * one target and forgotten in the other.
 */

/** Hosts the extension is allowed to contact. Every entry needs a reason. */
export const DATA_HOSTS = [
  'https://*.wikipedia.org/*', // article summaries and title search
  'https://*.wiktionary.org/*', // definitions, independent of the API below
  'https://freedictionaryapi.com/*', // definitions and pronunciation
  'https://api.datamuse.com/*', // synonyms, related words, collocations
  'https://www.wikidata.org/*', // structured facts for entities
  'https://upload.wikimedia.org/*', // images referenced by the two above
  'https://api.stackexchange.com/*', // tag wikis: definitions of programming terms
  'https://registry.npmjs.org/*', // package facts, asked only on JavaScript pages
  'https://pypi.org/*', // package facts, asked only on Python pages
  'https://crates.io/*', // package facts, asked only on Rust pages
  'https://developer.mozilla.org/*', // web platform reference, asked only on web pages
];

const BASE = {
  manifest_version: 3,
  name: 'Quick Lookup',
  version: '0.2.0',
  description: 'Instant, evidence-backed lookup for whatever you select.',
  permissions: ['storage', 'contextMenus', 'activeTab'],
  host_permissions: DATA_HOSTS,
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  action: { default_title: 'Quick Lookup', default_popup: 'action.html' },
  options_ui: { page: 'options.html', open_in_tab: true },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['content.js'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  commands: {
    'lookup-selection': {
      suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' },
      description: 'Look up the current selection',
    },
  },
};

/**
 * @param {'chromium' | 'firefox'} target
 */
export function manifestFor(target) {
  if (target === 'firefox') {
    return {
      ...BASE,
      background: { scripts: ['background.js'], type: 'module' },
      browser_specific_settings: {
        gecko: { id: 'quick-lookup@mmdemirbas', strict_min_version: '128.0' },
      },
    };
  }
  return {
    ...BASE,
    background: { service_worker: 'background.js', type: 'module' },
    minimum_chrome_version: '116',
  };
}
