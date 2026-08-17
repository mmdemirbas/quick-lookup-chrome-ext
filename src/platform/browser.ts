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
