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
import {
  DEFAULT_MODEL,
  HANDOFF_URL,
  newConversation,
  reviveConversation,
  type Conversation,
} from '../core/chat.ts';
import { ChatView } from './chat-view.ts';
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

function show(which: 'lookup' | 'chat', focus = false): void {
  for (const name of ['lookup', 'chat'] as const) {
    const active = name === which;
    panes[name]?.setAttribute('data-active', String(active));
    tabs[name]?.setAttribute('aria-selected', String(active));
    // Roving tabindex: one stop for the whole tablist, as the pattern wants.
    // Two stops would make a keyboard user tab through the switch before
    // reaching anything it switches to.
    tabs[name]?.setAttribute('tabindex', active ? '0' : '-1');
  }
  if (focus) tabs[which]?.focus();
}

tabs.lookup?.addEventListener('click', () => show('lookup'));
tabs.chat?.addEventListener('click', () => show('chat'));

// Arrows move between tabs, which is the half of the pattern that a native
// button does not give you for free once the tabindex is roving.
for (const [name, tab] of Object.entries(tabs)) {
  tab?.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    const other = name === 'lookup' ? 'chat' : 'lookup';
    show(key === 'Home' ? 'lookup' : key === 'End' ? 'chat' : other, true);
  });
}

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

/**
 * The whole thread, and nothing beside it.
 *
 * It used to carry a second `usage` object kept in this file. Two owners for
 * one fact is how a cleared thread went on reporting spend: the view reset
 * its copy and this one was written to storage unchanged.
 */
type SavedThread = { conversation: Conversation };

const chatElements = {
  log: document.getElementById('chatLog'),
  empty: document.getElementById('chatEmpty'),
  input: document.getElementById('chatInput') as HTMLTextAreaElement | null,
  send: document.getElementById('chatSend') as HTMLButtonElement | null,
  model: document.getElementById('chatModel') as HTMLSelectElement | null,
  attachment: document.getElementById('chatAttachment'),
  meter: document.getElementById('chatMeter'),
  clear: document.getElementById('chatClear') as HTMLButtonElement | null,
  handoff: document.getElementById('chatHandoff') as HTMLButtonElement | null,
  status: document.getElementById('chatStatus'),
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
  chatElements.clear &&
  chatElements.handoff &&
  chatElements.status
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
      handoff: chatElements.handoff,
      status: chatElements.status,
    },
    {
      onSend: (conversation, requestId) => {
        void ext.runtime.sendMessage({ type: 'QL_CHAT_SEND', requestId, conversation });
      },
      onCancel: () => {
        void ext.runtime.sendMessage({ type: 'QL_CHAT_CANCEL' });
      },
      onChanged: (conversation) => void saveThread(conversation),
      onHandoff: (prompt) => void handoff(prompt),
    },
    newConversation(DEFAULT_MODEL),
  );
}

async function saveThread(conversation: Conversation): Promise<void> {
  try {
    const key = await threadKey();
    const value: SavedThread = { conversation };
    await ext.storage.session.set({ [key]: value });
  } catch {
    // Session storage is unavailable or full. The thread still works for as
    // long as this document lives; only reopening the panel loses it.
  }
}

async function loadThread(): Promise<void> {
  if (!chat) return;
  // Read and revive are separate, and the catch covers only the read.
  //
  // They used to share one `try`, so a conversation this build could not
  // parse — one saved before spend moved inside it, say — threw on the way
  // in and was caught by the handler meant for storage being unavailable.
  // The thread was silently replaced with an empty one and nothing said so.
  let stored: Record<string, unknown> = {};
  try {
    stored = await ext.storage.session.get(await threadKey());
  } catch {
    // Session storage refused. An empty thread is the right start.
  }
  const saved = reviveConversation((Object.values(stored)[0] as SavedThread | undefined)?.conversation);
  if (saved) {
    chat.restore(saved);
    return;
  }

  // No saved thread: start on whichever model the settings name.
  try {
    const settings = await ext.runtime.sendMessage({ type: 'QL_GET_SETTINGS' });
    const model = settings?.chat?.model;
    if (typeof model === 'string') {
      chat.restore(newConversation(model));
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
    heading.textContent = 'An API key is needed to answer here.';
    const body = document.createElement('span');
    body.textContent =
      'Add an Anthropic API key in the extension settings and Ask will work. ';
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'Open settings';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      ext.runtime.openOptionsPage();
    });
    // Without this the panel would be telling the reader it can do nothing
    // while one of its two buttons works perfectly well.
    const keyless = document.createElement('span');
    keyless.textContent =
      ' Or skip the key entirely: type a question and press claude.ai\u2197, which copies it' +
      ' with the page and opens a new conversation there for you to paste into.';
    chatElements.empty.append(heading, body, link, keyless);
  } catch {
    // The worker did not answer. The ordinary empty state stands.
  }
}

/**
 * The second way to reach a model: clipboard, then claude.ai.
 *
 * The prompt goes on the clipboard rather than into the URL. A page excerpt
 * runs to tens of thousands of characters and would exceed what a URL can
 * carry long before the context budget does, so a query-string prefill would
 * work for the short cases and fail silently on exactly the long ones this
 * exists to serve.
 *
 * Costs nothing, needs no key, and is the only path here that works before
 * one is added. What it costs instead is that you leave the page to talk.
 */
async function handoff(prompt: string): Promise<void> {
  const button = chatElements.handoff;
  try {
    await navigator.clipboard.writeText(prompt);
    if (button) {
      // Said, not assumed. Nothing else on screen would tell the reader that
      // a paste is now the next step rather than a second press.
      button.textContent = 'Copied — paste it';
      setTimeout(() => (button.textContent = 'claude.ai\u2197'), 2600);
    }
    await ext.tabs.create({ url: HANDOFF_URL });
  } catch (error) {
    // Refused because the document was not focused, or the tab was blocked.
    // Saying which is the difference between retrying and giving up.
    if (button) {
      button.textContent = 'Copy failed';
      setTimeout(() => (button.textContent = 'claude.ai\u2197'), 2600);
    }
    console.warn('handoff failed', error);
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
      chat?.done(message.requestId, message.usage, message.backend, message.complete);
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
