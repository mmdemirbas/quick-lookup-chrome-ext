/**
 * The API key, kept apart from everything else that is configurable.
 *
 * Settings live in `chrome.storage.sync`, which replicates to every browser
 * the reader is signed into. A key must not travel that way — one machine
 * they no longer use is enough to leak it — so it lives in `local`, which
 * stays on this profile, and it is never included in the `Settings` object
 * that the options page and content scripts pass around.
 *
 * This is storage, not secrecy. Extension storage is not encrypted: anyone
 * with the profile directory can read it, as they can read a `.env` file.
 * What it buys is that the key is not synced, not in a page, and not in the
 * settings blob that gets logged and exported.
 */
import { ext } from './browser.ts';

const KEY = 'chat.apiKey';

export async function readApiKey(): Promise<string> {
  try {
    const stored = await ext.storage.local.get(KEY);
    const value = stored[KEY];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export async function writeApiKey(value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    await ext.storage.local.remove(KEY);
    return;
  }
  await ext.storage.local.set({ [KEY]: trimmed });
}

/**
 * Enough of the key to recognise, and not enough to use.
 *
 * The options page shows this instead of the key so that a screenshot or a
 * shared screen does not hand it over, while still answering "is the right
 * one in there".
 */
export function maskApiKey(value: string): string {
  if (!value) return '';
  return value.length <= 12 ? '••••' : `${value.slice(0, 7)}…${value.slice(-4)}`;
}
