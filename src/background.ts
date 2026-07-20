import { loadSettings, saveSettings } from "./shared/storage";
import {
  addAlwaysMutedHost,
  extractNormalizedHost,
  isAlwaysMutedUrl,
  isValidHostInput,
  removeAlwaysMutedHost,
} from "./shared/site-rules";
import {
  deriveAudioState,
  isBulkMuteCandidate,
  isRelevantTab,
  isSafeToBulkUnmute,
  type TabLike,
} from "./shared/tab-state";
import type {
  OperationResult,
  Request,
  Response,
  TabRow,
} from "./shared/messages";

/**
 * 常時ミュート設定への書き込みを直列化する。ADD/REMOVEが並行実行されると
 * 互いに古い読み取り結果を上書きし合うレースコンディションが起きる
 * （実装レビューで発見されたmajor）。
 */
let settingsWriteQueue: Promise<unknown> = Promise.resolve();

function enqueueSettingsWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = settingsWriteQueue.then(task, task);
  // キューが例外で止まらないようにする（個々の結果はresultで返す）。
  settingsWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * MV3のService Workerはいつ破棄されてもよい。
 * すべてのイベントリスナーはこのファイルの評価時（トップレベル）で
 * 同期的に登録し、非同期処理（storage読み込み等）はハンドラ内部で行う。
 * リスナー登録を非同期初期化の完了後に置くと、SW復帰直後のイベントを
 * 取りこぼす（凍結設計 major6 で修正した制約）。
 */
chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  handleRequest(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      // 未捕捉の例外でsendResponseが呼ばれないと、呼び出し元（popup）が
      // ハングしたままになる（実装レビューで発見されたmajor）。
      console.error("handleRequest failed", error);
      sendResponse({ type: "SAVE_RESULT", ok: false, error: "unknown" } satisfies Response);
    });
  return true; // 非同期でsendResponseを呼ぶことを示す
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined) {
    void applyAlwaysMuteRuleToTab(tabId, tab.url);
    return;
  }
  // 常時ミュート対象タブが、ネイティブUI等（拡張機能のpopup以外の経路）で
  // 解除された場合に規則を再適用する（実装レビューで発見されたmajor。
  // popup側のボタン無効化はUI層の防御に過ぎず、Chrome標準UIからの解除は
  // 防げないため、background側でも再適用が必要）。
  if (changeInfo.mutedInfo?.muted === false) {
    void applyAlwaysMuteRuleToTab(tabId, tab.url);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void reapplyAlwaysMuteRulesToAllTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void reapplyAlwaysMuteRulesToAllTabs();
});

async function handleRequest(request: Request): Promise<Response> {
  switch (request.type) {
    case "GET_TAB_LIST":
      return { type: "TAB_LIST", tabs: await getCurrentWindowTabRows() };
    case "TOGGLE_TAB_MUTE":
      return { type: "TOGGLE_RESULT", ok: await toggleTabMute(request.tabId) };
    case "BULK_MUTE":
      return { type: "BULK_RESULT", result: await bulkMuteCurrentWindow() };
    case "BULK_UNMUTE":
      return { type: "BULK_RESULT", result: await bulkUnmuteCurrentWindow() };
    case "GET_ALWAYS_MUTE_HOSTS": {
      const settings = await loadSettingsSafely();
      return { type: "ALWAYS_MUTE_HOSTS", hosts: settings.alwaysMutedHosts };
    }
    case "ADD_ALWAYS_MUTE_HOST": {
      if (!isValidHostInput(request.host)) {
        return { type: "SAVE_RESULT", ok: false, error: "invalid-host" };
      }
      const result = await enqueueSettingsWrite(async () => {
        const settings = await loadSettingsSafely();
        const updated = addAlwaysMutedHost(settings, request.host);
        return saveSettings(updated);
      });
      if (result.ok) void reapplyAlwaysMuteRulesToAllTabs();
      return { type: "SAVE_RESULT", ok: result.ok, error: result.error };
    }
    case "REMOVE_ALWAYS_MUTE_HOST": {
      const result = await enqueueSettingsWrite(async () => {
        const settings = await loadSettingsSafely();
        const updated = removeAlwaysMutedHost(settings, request.host);
        return saveSettings(updated);
      });
      return { type: "SAVE_RESULT", ok: result.ok, error: result.error };
    }
    default: {
      const exhaustiveCheck: never = request;
      throw new Error(`unknown request: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** storage.sync.get()自体が失敗しても安全な空設定にフォールバックする。 */
async function loadSettingsSafely(): ReturnType<typeof loadSettings> {
  try {
    return await loadSettings();
  } catch (error) {
    console.error("loadSettings failed", error);
    return { version: 1, alwaysMutedHosts: [] };
  }
}

async function getCurrentWindowTabRows(): Promise<TabRow[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const settings = await loadSettingsSafely();

  const rows: TabRow[] = [];
  for (const tab of tabs) {
    const tabLike: TabLike = {
      id: tab.id,
      url: tab.url,
      audible: tab.audible,
      mutedInfo: tab.mutedInfo
        ? {
            muted: tab.mutedInfo.muted,
            reason: tab.mutedInfo.reason,
            extensionId: tab.mutedInfo.extensionId,
          }
        : undefined,
    };
    if (!isRelevantTab(tabLike) || tab.id === undefined) continue;

    rows.push({
      tabId: tab.id,
      title: tab.title ?? "",
      host: extractNormalizedHost(tab.url),
      state: deriveAudioState(tabLike),
      alwaysMuted: isAlwaysMutedUrl(tab.url, settings),
    });
  }
  return rows;
}

async function toggleTabMute(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const nextMuted = !(tab.mutedInfo?.muted === true);

    if (!nextMuted) {
      // 解除しようとしている場合、常時ミュート対象なら拒否する
      // （popupのボタン無効化はUI層の防御に過ぎないため、正のソース・
      // オブ・トゥルースであるbackground側でも多層防御として確認する。
      // 実装レビューで指摘されたminor）。
      const settings = await loadSettingsSafely();
      if (isAlwaysMutedUrl(tab.url, settings)) {
        return false;
      }
    }

    await chrome.tabs.update(tabId, { muted: nextMuted });
    return true;
  } catch {
    return false;
  }
}

async function bulkMuteCurrentWindow(): Promise<OperationResult> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const candidates = tabs.filter((tab): tab is chrome.tabs.Tab & { id: number } => {
    if (tab.id === undefined) return false;
    return isBulkMuteCandidate({
      id: tab.id,
      audible: tab.audible,
      mutedInfo: tab.mutedInfo
        ? { muted: tab.mutedInfo.muted, reason: tab.mutedInfo.reason, extensionId: tab.mutedInfo.extensionId }
        : undefined,
    });
  });

  const results = await Promise.allSettled(
    candidates.map((tab) => chrome.tabs.update(tab.id, { muted: true }))
  );

  let successCount = 0;
  let failureCount = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      successCount += 1;
    } else {
      failureCount += 1;
    }
  }

  return { successCount, failureCount };
}

/**
 * 一括解除は、独自の追跡状態を一切持たず、常にChromeの一次情報
 * （mutedInfo.reason / mutedInfo.extensionId）だけを根拠に判定する。
 * 対象は「現在のウィンドウで、かつ拡張機能自身が現在のミュート所有者
 * であるタブ」の全てであり、それが一括ミュート経由か個別ミュート
 * ボタン経由かは問わない。これにより、以前の実装が抱えていた
 * 「独自の追跡集合に載っていない限り解除できない」という過剰な制限
 * （実運用で発見されたバグ）を解消する。ユーザーのネイティブ操作・
 * 他拡張機能によるミュート・常時ミュート規則は、いずれもこの条件を
 * 満たさないため引き続き保護される。
 */
async function bulkUnmuteCurrentWindow(): Promise<OperationResult> {
  const extensionId = chrome.runtime.id;
  const settings = await loadSettingsSafely();

  const windowTabs = await chrome.tabs.query({ currentWindow: true });
  const candidates = windowTabs.filter((tab): tab is chrome.tabs.Tab & { id: number } => {
    if (tab.id === undefined) return false;
    const tabLike: TabLike = {
      id: tab.id,
      url: tab.url,
      audible: tab.audible,
      mutedInfo: tab.mutedInfo
        ? { muted: tab.mutedInfo.muted, reason: tab.mutedInfo.reason, extensionId: tab.mutedInfo.extensionId }
        : undefined,
    };
    return isSafeToBulkUnmute(tabLike, extensionId, (url) => isAlwaysMutedUrl(url, settings));
  });

  const results = await Promise.allSettled(
    candidates.map((tab) => chrome.tabs.update(tab.id, { muted: false }))
  );

  let successCount = 0;
  let failureCount = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      successCount += 1;
    } else {
      failureCount += 1;
    }
  }

  return { successCount, failureCount };
}

async function applyAlwaysMuteRuleToTab(tabId: number, url: string | undefined): Promise<void> {
  const settings = await loadSettingsSafely();
  if (!isAlwaysMutedUrl(url, settings)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.mutedInfo?.muted === true) return;
    await chrome.tabs.update(tabId, { muted: true });
  } catch {
    // タブが既に閉じられている等は無視する。
  }
}

async function reapplyAlwaysMuteRulesToAllTabs(): Promise<void> {
  const settings = await loadSettingsSafely();
  if (settings.alwaysMutedHosts.length === 0) return;

  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id !== undefined && isAlwaysMutedUrl(tab.url, settings))
      .map(async (tab) => {
        if (tab.mutedInfo?.muted === true) return;
        try {
          await chrome.tabs.update(tab.id as number, { muted: true });
        } catch {
          // 無視する。
        }
      })
  );
}
