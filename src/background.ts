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
  intersectWithCurrentWindow,
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
 * 一括ミュートで拡張機能がミュートしたタブIDの集合（ウィンドウ非依存）を
 * chrome.storage.sessionへ保存する。MV3のService Workerは非操作状態が
 * 続くと（目安30秒程度で）終了・再起動されるため、モジュールスコープの
 * インメモリ変数では実運用下で高確率に消失し、一括解除が機能しなくなる
 * （実装レビューで発見されたblocker）。storage.sessionはSW再起動を
 * またいで保持され、ブラウザ終了時にのみ消える。
 * 解除の最終判定はmutedInfo.reason/extensionIdに委ねているため、
 * この集合自体はあくまで「一括ミュート由来か」の内部区別用途にとどまる。
 */
const BULK_MUTE_SESSION_KEY = "bulkMuteTabIdsV1";

async function loadBulkMuteTabIds(): Promise<Set<number>> {
  const result = await chrome.storage.session.get(BULK_MUTE_SESSION_KEY);
  const raw = result[BULK_MUTE_SESSION_KEY];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is number => typeof v === "number"));
}

async function saveBulkMuteTabIds(ids: ReadonlySet<number>): Promise<void> {
  await chrome.storage.session.set({
    [BULK_MUTE_SESSION_KEY]: Array.from(ids),
  });
}

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

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const ids = await loadBulkMuteTabIds();
    if (ids.delete(tabId)) {
      await saveBulkMuteTabIds(ids);
    }
  })();
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
    if (!nextMuted) {
      // 個別解除されたタブは一括解除の追跡対象から外す。
      const ids = await loadBulkMuteTabIds();
      if (ids.delete(tabId)) {
        await saveBulkMuteTabIds(ids);
      }
    }
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

  const bulkMuteTabIds = await loadBulkMuteTabIds();
  let successCount = 0;
  let failureCount = 0;
  results.forEach((result, index) => {
    const tab = candidates[index];
    if (tab === undefined) return;
    if (result.status === "fulfilled") {
      bulkMuteTabIds.add(tab.id);
      successCount += 1;
    } else {
      failureCount += 1;
    }
  });
  await saveBulkMuteTabIds(bulkMuteTabIds);

  return { successCount, failureCount };
}

async function bulkUnmuteCurrentWindow(): Promise<OperationResult> {
  const extensionId = chrome.runtime.id;
  const settings = await loadSettingsSafely();
  const bulkMuteTabIds = await loadBulkMuteTabIds();

  const windowTabs = await chrome.tabs.query({ currentWindow: true });
  const currentWindowTabIds = new Set(
    windowTabs.map((tab) => tab.id).filter((id): id is number => id !== undefined)
  );

  // 一括解除の実行対象は「現在のウィンドウ」に限定する（凍結設計の裁定）。
  // bulkMuteTabIdsはウィンドウ非依存のグローバル集合だが、UIのスコープは
  // 常に「今見えているタブ」に保つため積集合を取る。
  const candidateIds = intersectWithCurrentWindow(bulkMuteTabIds, currentWindowTabIds);

  let successCount = 0;
  let failureCount = 0;
  const idsToRemove = new Set<number>();

  const results = await Promise.allSettled(
    Array.from(candidateIds).map(async (tabId) => {
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        idsToRemove.add(tabId);
        throw new Error("tab-not-found");
      }

      const tabLike: TabLike = {
        id: tab.id,
        url: tab.url,
        audible: tab.audible,
        mutedInfo: tab.mutedInfo
          ? { muted: tab.mutedInfo.muted, reason: tab.mutedInfo.reason, extensionId: tab.mutedInfo.extensionId }
          : undefined,
      };

      if (
        !isSafeToBulkUnmute(tabLike, bulkMuteTabIds, extensionId, (url) =>
          isAlwaysMutedUrl(url, settings)
        )
      ) {
        // 安全条件を満たさない（ユーザーが再ミュートした等）。
        // 追跡対象からは外し、解除もしない。
        idsToRemove.add(tabId);
        throw new Error("not-safe-to-unmute");
      }

      await chrome.tabs.update(tabId, { muted: false });
      idsToRemove.add(tabId);
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      successCount += 1;
    } else {
      failureCount += 1;
    }
  }

  if (idsToRemove.size > 0) {
    for (const id of idsToRemove) bulkMuteTabIds.delete(id);
    await saveBulkMuteTabIds(bulkMuteTabIds);
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
