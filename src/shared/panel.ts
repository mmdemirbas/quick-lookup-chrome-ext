/**
 * Opening the panel, from the two places allowed to.
 *
 * Where this can be called from is decided by the browser, and the rule is
 * narrower than the documentation says. Chrome documents `sidePanel.open()`
 * as callable "in response to a user action"; run here, a call from the
 * service worker with nothing behind it is refused with "may only be called
 * in response to a user gesture", while the same call from an extension page
 * succeeds. Firefox's `sidebarAction.open()` is documented as needing a user
 * action too; that half has not been run.
 *
 * So a button in the card cannot open the panel: the press happens in a page
 * and reaches the extension as a message, which leaves the service worker
 * making the call with no gesture. What works is a context-menu click, which
 * hands the worker a real one, and the toolbar popup, which is an extension
 * page. Those are the two entry points.
 */
import { ext } from '../platform/browser.ts';

type Chromium = { sidePanel?: { open(options: { windowId: number }): Promise<void> } };
type Firefox = { sidebarAction?: { open(): Promise<void> } };

/**
 * Chromium calls it a side panel and wants to be told which window. Firefox
 * calls it a sidebar, has one per window, and needs nothing.
 */
export function openPanel(windowId: number | undefined): void {
  const chromium = (ext as Chromium).sidePanel;
  if (chromium && windowId !== undefined) {
    void chromium.open({ windowId }).catch(() => {
      // Refused because the user action had already ended. Nothing to recover.
    });
    return;
  }
  void (ext as Firefox).sidebarAction?.open().catch(() => {});
}
