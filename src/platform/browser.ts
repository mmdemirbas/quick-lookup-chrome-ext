/**
 * The extension namespace, resolved once.
 *
 * Firefox exposes `browser` with promises, Chromium exposes `chrome`.
 * Chromium's MV3 APIs also return promises, so one reference covers both
 * and nothing above this file names a browser.
 */
declare const browser: typeof chrome | undefined;

export const ext: typeof chrome =
  typeof browser !== 'undefined' && browser ? browser : chrome;

export type BrowserFamily = 'chromium' | 'firefox' | 'unknown';

export function browserFamily(): BrowserFamily {
  if (typeof browser !== 'undefined' && browser && !('app' in (browser as object))) {
    // Firefox defines `browser`; Chromium only defines `chrome`.
    return typeof chrome === 'undefined' || chrome !== (browser as unknown) ? 'firefox' : 'chromium';
  }
  return typeof chrome !== 'undefined' ? 'chromium' : 'unknown';
}
