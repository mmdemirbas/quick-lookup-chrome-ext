/**
 * The panel: two things the page cannot take away.
 *
 * **Lookup** is a mirror. Everything it shows is already on screen somewhere
 * else while you are on the page you found it on. What it adds is that the
 * answer survives leaving that page — a card lives in a content script and
 * dies with it — and that a word looked up yesterday can be opened again
 * without finding the page it was on. It is a mirror, not a second client:
 * it draws whatever was looked up last, in whichever tab, and the only
 * lookup it starts itself is the one you ask for from the list of recent
 * words.
 *
 * **Chat** is the opposite: this document is the only place the thread
 * exists. The service worker is torn down after about thirty seconds of
 * inactivity, so it cannot hold a conversation between two questions; the
 * panel holds it and sends it whole each time. That is also what lets a
 * thread outlive navigation, and span several pages — each question carries
 * the page it was asked against.
 */
import { CardView } from '../content/card-view.ts';
import { renderHistory } from '../shared/history-list.ts';
import { ext } from '../platform/browser.ts';
import { DEFAULT_MODEL, type Conversation } from '../core/chat.ts';
import { ChatView } from './chat-view.ts';
import type { ChatUsage } from '../platform/anthropic.ts';
import type { HistoryItem } from '../core/store.ts';
import type { Attachment } from '../core/chat.ts';
import type { KeyState, ToContent, ToPanel } from '../shared/messages.ts';

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

// ---------------------------------------------------------------- views

const tabs = {
  lookup: document.getElementById('tabLookup'),
  chat: document.getElementById('tabChat'),
};
const panes = {
  lookup: document.getElementById('lookup'),
  chat: document.getElementById('chat'),
};

function show(which: 'lookup' | 'chat'): void {
  for (const name of ['lookup', 'chat'] as const) {
    const active = name === which;
    panes[name]?.setAttribute('data-active', String(active));
    tabs[name]?.setAttribute('aria-selected', String(active));
  }
}

tabs.lookup?.addEventListener('click', () => show('lookup'));
tabs.chat?.addEventListener('click', () => show('chat'));

// ---------------------------------------------------------------- chat

/**
 * Where the thread is kept between one opening of the panel and the next.
 *
 * `session` rather than `local`: a conversation is about what you were
 * reading an hour ago, and keeping it past the browser closing would mean
 * carrying pages the reader has finished with into a new day. It also never
 * touches disk, which matters for something that holds page content.
 *
 * Keyed by window, because the panel is one per window and two windows are
 * usually two different things being read.
 */
async function threadKey(): Promise<string> {
  try {
    const current = await ext.windows.getCurrent();
    return `chat:${current.id ?? 0}`;
  } catch {
    return 'chat:0';
  }
}

type SavedThread = { conversation: Conversation; usage: ChatUsage };

const chatElements = {
  log: document.getElementById('chatLog'),
  empty: document.getElementById('chatEmpty'),
  input: document.getElementById('chatInput') as HTMLTextAreaElement | null,
  send: document.getElementById('chatSend') as HTMLButtonElement | null,
  model: document.getElementById('chatModel') as HTMLSelectElement | null,
  attachment: document.getElementById('chatAttachment'),
  meter: document.getElementById('chatMeter'),
  clear: document.getElementById('chatClear') as HTMLButtonElement | null,
};

let chat: ChatView | undefined;

if (
  chatElements.log &&
  chatElements.empty &&
  chatElements.input &&
  chatElements.send &&
  chatElements.model &&
  chatElements.attachment &&
  chatElements.meter &&
  chatElements.clear
) {
  chat = new ChatView(
    {
      log: chatElements.log,
      empty: chatElements.empty,
      input: chatElements.input,
      send: chatElements.send,
      model: chatElements.model,
      attachment: chatElements.attachment,
      meter: chatElements.meter,
      clear: chatElements.clear,
    },
    {
      onSend: (conversation, requestId) => {
        void ext.runtime.sendMessage({ type: 'QL_CHAT_SEND', requestId, conversation });
      },
      onCancel: () => {
        void ext.runtime.sendMessage({ type: 'QL_CHAT_CANCEL' });
      },
      onChanged: (conversation) => void saveThread(conversation),
    },
    { model: DEFAULT_MODEL, turns: [] },
  );
}

/** The running usage, kept here because only the view knows the thread. */
let savedUsage: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

async function saveThread(conversation: Conversation): Promise<void> {
  try {
    const key = await threadKey();
    const value: SavedThread = { conversation, usage: savedUsage };
    await ext.storage.session.set({ [key]: value });
  } catch {
    // Session storage is unavailable or full. The thread still works for as
    // long as this document lives; only reopening the panel loses it.
  }
}

async function loadThread(): Promise<void> {
  if (!chat) return;
  try {
    const key = await threadKey();
    const stored = await ext.storage.session.get(key);
    const saved = stored[key] as SavedThread | undefined;
    if (saved?.conversation?.turns) {
      savedUsage = saved.usage;
      chat.restore(saved.conversation, saved.usage);
      return;
    }
  } catch {
    // Nothing saved, or storage refused. An empty thread is the right start.
  }

  // No saved thread: start on whichever model the settings name.
  try {
    const settings = await ext.runtime.sendMessage({ type: 'QL_GET_SETTINGS' });
    const model = settings?.chat?.model;
    if (typeof model === 'string') {
      chat.restore({ model, turns: [] }, savedUsage);
    }
  } catch {
    // The default in the picker already stands.
  }
}

/**
 * Says so when there is no key, in the place the reader is looking.
 *
 * Not a silent failure on the first question: without a key nothing here can
 * work at all, and finding that out after typing a paragraph is worse than
 * being told on arrival.
 */
async function checkKey(): Promise<void> {
  if (!chatElements.empty) return;
  try {
    const state = (await ext.runtime.sendMessage({ type: 'QL_CHAT_KEY_STATE' })) as
      | KeyState
      | undefined;
    if (state?.present) return;

    chatElements.empty.replaceChildren();
    const heading = document.createElement('b');
    heading.textContent = 'An API key is needed first.';
    const body = document.createElement('span');
    body.textContent = 'Add an Anthropic API key in the extension settings, then come back. ';
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'Open settings';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      ext.runtime.openOptionsPage();
    });
    chatElements.empty.append(heading, body, link);
  } catch {
    // The worker did not answer. The ordinary empty state stands.
  }
}

function attach(attachment: Attachment): void {
  if (!chat) return;
  // Asking to discuss a page is asking to be in the conversation, so the
  // panel goes there rather than leaving a badge on a tab nobody looked at.
  show('chat');
  chat.attach(attachment);
}

// ---------------------------------------------------------------- wiring

ext.runtime.onMessage.addListener((message: ToContent | ToPanel) => {
  switch (message.type) {
    case 'QL_CARD':
      if (view) {
        reveal();
        view.render(message.card);
      }
      return;
    // A word looked up while the panel is open belongs in the list under it.
    case 'QL_HISTORY':
      draw(message.items);
      return;
    case 'QL_CHAT_DELTA':
      chat?.delta(message.requestId, message.kind, message.text);
      return;
    case 'QL_CHAT_DONE':
      savedUsage = {
        inputTokens: savedUsage.inputTokens + message.usage.inputTokens,
        outputTokens: savedUsage.outputTokens + message.usage.outputTokens,
        cacheReadTokens: savedUsage.cacheReadTokens + message.usage.cacheReadTokens,
      };
      chat?.done(message.requestId, message.usage);
      return;
    case 'QL_CHAT_FAILED':
      chat?.failed(message.requestId, message.message, message.retryable);
      return;
    case 'QL_CHAT_ATTACH':
      attach(message.attachment);
      return;
    default:
      return;
  }
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

void loadThread().then(checkKey);

/**
 * Claims the page staged before this document existed.
 *
 * Opening the panel and collecting the page happen in one gesture, and the
 * panel usually loses that race — it is still loading when the page arrives.
 * The worker holds one for exactly this, so the first thing the panel does
 * is ask whether it missed one.
 */
void ext.runtime
  .sendMessage({ type: 'QL_CHAT_TAKE_ATTACHMENT' })
  .then((attachment: Attachment | null) => {
    if (attachment) attach(attachment);
  })
  .catch(() => {
    // No worker yet. The broadcast covers the case where it arrives later.
  });
