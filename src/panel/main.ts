/**
 * The panel: the same card, in a place the page cannot take away.
 *
 * Everything the panel shows is already on screen somewhere else while you
 * are on the page you found it on. What it adds is that the answer survives
 * leaving that page — a card lives in a content script and dies with it —
 * and that a word looked up yesterday can be opened again without finding
 * the page it was on.
 *
 * So the panel is a mirror, not a second client. It draws whatever was
 * looked up last, in whichever tab, and the only lookup it starts itself is
 * the one you ask for from the list of recent words.
 */
import { CardView } from '../content/card-view.ts';
import { renderHistory } from '../shared/history-list.ts';
import { ext } from '../platform/browser.ts';
import type { HistoryItem } from '../core/store.ts';
import type { ToContent } from '../shared/messages.ts';

const dock = document.getElementById('card');
const emptyState = document.getElementById('emptyState');
const historyList = document.getElementById('history');

/** Words reached by following a synonym, oldest first, so back has somewhere to go. */
const trail: string[] = [];

const view = dock
  ? new CardView(
      {
        // Closing and quietening act on the page a card is floating over.
        // A docked card has no page, and both buttons are hidden.
        onClose: () => {},
        onQuietSite: () => {},
        onEngage: () => {},
        onFollow: (text) => {
          trail.push(view?.query ?? '');
          look(text);
        },
        onBack: () => {
          const previous = trail.pop();
          if (previous) look(previous);
        },
        // A panel holds one card. Dragging is off, so this cannot fire.
        onPinned: () => {},
      },
      dock,
    )
  : undefined;

/**
 * Looks a word up from the panel.
 *
 * With no page behind it there is no context to rank against, which is the
 * honest thing to send: this is the word on its own, not the word as it
 * appeared somewhere. The answer comes back by broadcast, like every other.
 */
function look(text: string): void {
  if (!text.trim() || !view) return;
  reveal();
  view.renderPending(text);
  void ext.runtime.sendMessage({
    type: 'QL_LOOKUP',
    requestId: `panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    page: {},
  });
}

function reveal(): void {
  if (emptyState) emptyState.hidden = true;
}

ext.runtime.onMessage.addListener((message: ToContent) => {
  if (message.type === 'QL_CARD' && view) {
    reveal();
    view.render(message.card);
    return;
  }
  // A word looked up while the panel is open belongs in the list under it.
  if (message.type === 'QL_HISTORY') draw(message.items);
});

function draw(items: HistoryItem[]): void {
  if (!historyList) return;
  renderHistory(items, {
    list: historyList,
    onPick: (item) => {
      trail.length = 0;
      look(item.query);
    },
  });
}

document.getElementById('clearHistory')?.addEventListener('click', () => {
  void ext.runtime.sendMessage({ type: 'QL_CLEAR_HISTORY' }).then(draw);
});

void ext.runtime.sendMessage({ type: 'QL_GET_HISTORY' }).then((items: HistoryItem[]) => {
  draw(Array.isArray(items) ? items : []);
});
