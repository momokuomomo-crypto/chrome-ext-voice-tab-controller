import type { AudioState } from "./tab-state";

/** popup <-> background(Service Worker) 間のメッセージ定義。 */

export interface TabRow {
  tabId: number;
  title: string;
  host: string | null;
  state: AudioState;
  alwaysMuted: boolean;
}

export type Request =
  | { type: "GET_TAB_LIST" }
  | { type: "TOGGLE_TAB_MUTE"; tabId: number }
  | { type: "BULK_MUTE" }
  | { type: "BULK_UNMUTE" }
  | { type: "GET_ALWAYS_MUTE_HOSTS" }
  | { type: "ADD_ALWAYS_MUTE_HOST"; host: string }
  | { type: "REMOVE_ALWAYS_MUTE_HOST"; host: string };

export interface OperationResult {
  successCount: number;
  failureCount: number;
}

export type Response =
  | { type: "TAB_LIST"; tabs: TabRow[] }
  | { type: "TOGGLE_RESULT"; ok: boolean }
  | { type: "BULK_RESULT"; result: OperationResult }
  | { type: "ALWAYS_MUTE_HOSTS"; hosts: string[] }
  | { type: "SAVE_RESULT"; ok: boolean; error?: string };

export function sendRequest(request: Request): Promise<Response> {
  return chrome.runtime.sendMessage(request);
}
