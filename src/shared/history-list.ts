/**
 * The list of recent lookups, drawn the same way in the popup and the panel.
 *
 * Starring is what turns the history from a log into a list worth keeping:
 * a starred entry survives both the size cap and Clear, and sorts first.
 */
import type { HistoryItem } from '../core/store.ts';
import { ext } from '../platform/browser.ts';

/** Enough to scroll through, few enough to draw without thinking about it. */
const SHOWN = 40;

export type HistoryList = {
  list: HTMLElement;
  /**
   * Called when a word is chosen. Absent in the popup, where the list is a
   * record of what was looked up rather than a way back into it.
   */
  onPick?: (item: HistoryItem) => void;
};

export function renderHistory(items: HistoryItem[], into: HistoryList): void {
  const { list, onPick } = into;
  list.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Nothing looked up yet.';
    list.append(empty);
    return;
  }

  const ordered = [...items].sort(
    (a, b) => Number(b.starred ?? false) - Number(a.starred ?? false) || b.at - a.at,
  );

  for (const item of ordered.slice(0, SHOWN)) {
    const row = document.createElement('li');

    const star = document.createElement('button');
    star.type = 'button';
    star.className = item.starred ? 'star on' : 'star';
    star.textContent = item.starred ? '★' : '☆';
    star.title = item.starred ? 'Unstar' : 'Keep this one';
    star.addEventListener('click', () => {
      void ext.runtime
        .sendMessage({ type: 'QL_STAR', query: item.query, host: item.host })
        .then((next: HistoryItem[]) => renderHistory(next, into));
    });

    // A word is a button only where pressing it leads somewhere. In the
    // popup there is nowhere to draw the answer, so it stays plain text.
    const word = document.createElement(onPick ? 'button' : 'span');
    word.className = 'word';
    word.textContent = item.query;
    if (onPick && word instanceof HTMLButtonElement) {
      word.type = 'button';
      word.title = `Look up "${item.query}" again`;
      word.addEventListener('click', () => onPick(item));
    }

    const gloss = document.createElement('span');
    gloss.className = 'gloss';
    gloss.textContent = item.gloss ?? item.host;
    gloss.title = `${item.gloss ?? ''} — ${item.host}`.trim();

    row.append(star, word, gloss);
    list.append(row);
  }
}
