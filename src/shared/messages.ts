/** The message contract between the content script and the service worker. */
import type { Card, PageContext } from '../core/types.ts';
import type { Settings } from '../core/settings.ts';
import type { HistoryItem } from '../core/store.ts';
import type { Capabilities } from '../platform/ai.ts';
import type { Attachment, ChatBackend, ChatUsage, Conversation } from '../core/chat.ts';

export type LookupMessage = {
  type: 'QL_LOOKUP';
  requestId: string;
  text: string;
  page: PageContext;
};

export type CancelMessage = { type: 'QL_CANCEL'; requestId: string };
export type GetSettingsMessage = { type: 'QL_GET_SETTINGS' };
export type SaveSettingsMessage = { type: 'QL_SAVE_SETTINGS'; settings: Settings };
export type SetSiteModeMessage = {
  type: 'QL_SET_SITE_MODE';
  host: string;
  mode: Settings['trigger']['mode'] | null;
};
export type GetStatusMessage = { type: 'QL_GET_STATUS' };
export type GetHistoryMessage = { type: 'QL_GET_HISTORY' };
export type StarMessage = { type: 'QL_STAR'; query: string; host: string };
export type ClearHistoryMessage = { type: 'QL_CLEAR_HISTORY' };
/**
 * A dictionary pack was installed or removed. The settings page writes to
 * IndexedDB directly, so nothing else would tell the service worker that what
 * it read on startup is no longer what is installed.
 */
export type PacksChangedMessage = { type: 'QL_PACKS_CHANGED' };

/**
 * Send a conversation and stream the answer back.
 *
 * The whole conversation travels rather than just the new question, because
 * the service worker is torn down after about thirty seconds of inactivity
 * and would otherwise have forgotten the thread between two questions. The
 * panel is the one that stays alive, so the panel is where the thread lives.
 */
export type ChatSendMessage = {
  type: 'QL_CHAT_SEND';
  requestId: string;
  conversation: Conversation;
};
export type ChatCancelMessage = { type: 'QL_CHAT_CANCEL' };
/**
 * Claim the page staged by the context menu, if one is waiting.
 *
 * Taken rather than read: the panel may not have been open when the reader
 * asked for it, so the worker holds one until somebody collects it, and a
 * page collected twice would attach itself to an unrelated question.
 */
export type ChatTakeAttachmentMessage = { type: 'QL_CHAT_TAKE_ATTACHMENT' };
/** Whether a key is stored, and enough of it to recognise. Never the key. */
export type ChatKeyStateMessage = { type: 'QL_CHAT_KEY_STATE' };
export type ChatSaveKeyMessage = {
  type: 'QL_CHAT_SAVE_KEY';
  apiKey: string;
  /** Which secret this is. Absent means the API key, which came first. */
  which?: 'api' | 'bridge';
};

export type ToBackground =
  | LookupMessage
  | CancelMessage
  | GetSettingsMessage
  | SaveSettingsMessage
  | SetSiteModeMessage
  | GetStatusMessage
  | GetHistoryMessage
  | StarMessage
  | ClearHistoryMessage
  | PacksChangedMessage
  | ChatSendMessage
  | ChatCancelMessage
  | ChatTakeAttachmentMessage
  | ChatKeyStateMessage
  | ChatSaveKeyMessage;

/** Partial results stream to the content script as separate messages. */
export type CardUpdateMessage = { type: 'QL_CARD'; card: Card };
/**
 * The list of recent lookups changed.
 *
 * Sent after the write, not with the card: a card is finished before its
 * lookup is recorded, so a surface that refetched on the card would ask a
 * moment too early and draw the list without the word it just showed.
 */
export type HistoryChangedMessage = { type: 'QL_HISTORY'; items: HistoryItem[] };
export type TriggerLookupMessage = { type: 'QL_TRIGGER_LOOKUP'; text?: string };
export type SettingsChangedMessage = { type: 'QL_SETTINGS_CHANGED'; settings: Settings };
/**
 * Collect the page for a conversation.
 *
 * Only the content script can: the readable text comes from a `TreeWalker`
 * over the live DOM, and the worker has no document. Answered synchronously
 * so the context menu's gesture is not spent waiting.
 */
export type CollectContextMessage = { type: 'QL_COLLECT_CONTEXT' };

export type ToContent =
  | CardUpdateMessage
  | HistoryChangedMessage
  | TriggerLookupMessage
  | SettingsChangedMessage
  | CollectContextMessage;

/** One fragment of an answer, as it is generated. */
export type ChatDeltaMessage = {
  type: 'QL_CHAT_DELTA';
  requestId: string;
  kind: 'text' | 'thinking';
  text: string;
};
export type ChatDoneMessage = {
  type: 'QL_CHAT_DONE';
  requestId: string;
  usage: ChatUsage;
  /**
   * Which backend answered. The panel needs it to say what the turn cost:
   * the API bills dollars and the bridge spends subscription quota, and
   * printing a dollar figure for the second is a made-up number.
   */
  backend: ChatBackend;
};
/**
 * The turn did not finish. `message` is the API's own wording where there
 * was one, because "rate limited, try in a moment" and "that key is wrong"
 * call for opposite reactions from the reader.
 */
export type ChatFailedMessage = {
  type: 'QL_CHAT_FAILED';
  requestId: string;
  message: string;
  retryable: boolean;
};
/** A page was staged by the context menu and is waiting to be asked about. */
export type ChatAttachMessage = { type: 'QL_CHAT_ATTACH'; attachment: Attachment };

export type ToPanel =
  | ChatDeltaMessage
  | ChatDoneMessage
  | ChatFailedMessage
  | ChatAttachMessage;

/** What the content script answers a `QL_COLLECT_CONTEXT` with. */
export type CollectedContext = { attachment: Attachment };

/** What the options page and the panel learn about the stored key. */
export type KeyState = {
  present: boolean;
  masked: string;
  bridgePresent: boolean;
  bridgeMasked: string;
};

export type StatusResponse = {
  capabilities: Capabilities;
  version: string;
};
