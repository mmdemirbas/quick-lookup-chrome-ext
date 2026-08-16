/** The message contract between the content script and the service worker. */
import type { Card, PageContext } from '../core/types.ts';
import type { Settings } from '../core/settings.ts';
import type { Capabilities } from '../platform/ai.ts';

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
  | PacksChangedMessage;

/** Partial results stream to the content script as separate messages. */
export type CardUpdateMessage = { type: 'QL_CARD'; card: Card };
export type TriggerLookupMessage = { type: 'QL_TRIGGER_LOOKUP'; text?: string };
export type SettingsChangedMessage = { type: 'QL_SETTINGS_CHANGED'; settings: Settings };

export type ToContent = CardUpdateMessage | TriggerLookupMessage | SettingsChangedMessage;

export type StatusResponse = {
  capabilities: Capabilities;
  version: string;
};
