import { beforeEach, describe, expect, it, vi } from "vitest";
import chrome from "sinon-chrome";
import type sinon from "sinon";
import type { Request, Response } from "../../src/shared/messages";

const EXTENSION_ID = "test-extension-id";

/**
 * chrome.storage.sessionの簡易フェイクストア。呼び出しをまたいで値を
 * 保持する（実際のstorage.sessionと同じく、Service Worker再起動を
 * 模した`vi.resetModules()`後もデータは残る＝この関数の外側でstoreを
 * 保持することで、モジュール再ロード（SW再起動相当）とストレージの
 * 永続化を区別してテストできる）。
 */
function wireFakeSessionStorage(): { store: Record<string, unknown> } {
  const session = (
    chrome.storage as unknown as {
      session: { get: sinon.SinonStub; set: sinon.SinonStub };
    }
  ).session;
  const state = { store: {} as Record<string, unknown> };
  session.get.callsFake(async (key: string) => ({
    [key]: state.store[key],
  }));
  session.set.callsFake(async (items: Record<string, unknown>) => {
    state.store = { ...state.store, ...items };
  });
  return state;
}

/** background.tsを新規にロードし直し、モジュールスコープの状態をリセットする（SW再起動を模す）。 */
async function loadBackgroundFresh(): Promise<void> {
  vi.resetModules();
  chrome.runtime.id = EXTENSION_ID;
  await import("../../src/background");
}

/** onMessageに登録されたリスナーへ直接リクエストを送り、レスポンスを受け取る。 */
async function dispatch(request: Request): Promise<Response> {
  const listener = chrome.runtime.onMessage.addListener.lastCall.args[0] as (
    request: Request,
    sender: unknown,
    sendResponse: (response: Response) => void
  ) => boolean;

  return new Promise<Response>((resolve) => {
    listener(request, {}, resolve);
  });
}

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  audible: boolean;
  mutedInfo: { muted: boolean; reason?: string; extensionId?: string };
}

function makeTab(overrides: Partial<FakeTab> = {}): FakeTab {
  return {
    id: 1,
    windowId: 1,
    url: "https://example.com/",
    title: "Example",
    audible: false,
    mutedInfo: { muted: false },
    ...overrides,
  };
}

beforeEach(() => {
  chrome.storage.sync.get.resolves({});
  chrome.storage.sync.set.resolves(undefined);
  // ADD_ALWAYS_MUTE_HOST等が内部で発火するreapplyAlwaysMuteRulesToAllTabs()
  // （fire-and-forget）がchrome.tabs.query({})を呼ぶため、個別に上書きしない
  // 限りは空配列を返す安全な既定値にしておく。
  chrome.tabs.query.resolves([]);
});

describe("background: リスナー登録", () => {
  it("インポート時点で同期的にリスナーを登録する（非同期初期化を待たない）", async () => {
    await loadBackgroundFresh();
    expect(chrome.runtime.onMessage.addListener.called).toBe(true);
    expect(chrome.tabs.onUpdated.addListener.called).toBe(true);
    expect(chrome.tabs.onRemoved.addListener.called).toBe(true);
    expect(chrome.runtime.onInstalled.addListener.called).toBe(true);
    expect(chrome.runtime.onStartup.addListener.called).toBe(true);
  });
});

describe("background: 一括ミュート／一括解除の安全性", () => {
  it("拡張機能自身が一括ミュートしたタブは一括解除できる", async () => {
    wireFakeSessionStorage();
    await loadBackgroundFresh();

    const tab = makeTab({ id: 1, audible: true, mutedInfo: { muted: false } });
    chrome.tabs.query.resolves([tab]);
    chrome.tabs.update.callsFake(async (tabId: number, props: { muted: boolean }) => {
      tab.mutedInfo = { muted: props.muted, reason: "extension", extensionId: EXTENSION_ID };
      return tab;
    });

    const bulkMuteResult = await dispatch({ type: "BULK_MUTE" });
    expect(bulkMuteResult).toEqual({ type: "BULK_RESULT", result: { successCount: 1, failureCount: 0 } });

    chrome.tabs.get.resolves(tab);
    const bulkUnmuteResult = await dispatch({ type: "BULK_UNMUTE" });
    expect(bulkUnmuteResult).toEqual({
      type: "BULK_RESULT",
      result: { successCount: 1, failureCount: 0 },
    });
    expect(chrome.tabs.update.lastCall.args).toEqual([1, { muted: false }]);
  });

  it("セッション集合に含まれていてもreason==='user'なら解除しない", async () => {
    wireFakeSessionStorage();
    await loadBackgroundFresh();

    const tab = makeTab({ id: 1, audible: true, mutedInfo: { muted: false } });
    chrome.tabs.query.resolves([tab]);
    chrome.tabs.update.callsFake(async (tabId: number, props: { muted: boolean }) => {
      tab.mutedInfo = { muted: props.muted, reason: "extension", extensionId: EXTENSION_ID };
      return tab;
    });
    await dispatch({ type: "BULK_MUTE" });

    // ユーザーがネイティブUIで手動再ミュートした状態を模倣する。
    tab.mutedInfo = { muted: true, reason: "user", extensionId: undefined };
    chrome.tabs.get.resolves(tab);

    const result = await dispatch({ type: "BULK_UNMUTE" });
    expect(result).toEqual({ type: "BULK_RESULT", result: { successCount: 0, failureCount: 1 } });
    // update呼び出しは一括ミュート時の1回のみで、解除は実行されていない。
    expect(chrome.tabs.update.callCount).toBe(1);
  });

  it("extensionIdが別拡張なら解除しない", async () => {
    wireFakeSessionStorage();
    await loadBackgroundFresh();

    const tab = makeTab({ id: 1, audible: true, mutedInfo: { muted: false } });
    chrome.tabs.query.resolves([tab]);
    chrome.tabs.update.callsFake(async (tabId: number, props: { muted: boolean }) => {
      tab.mutedInfo = { muted: props.muted, reason: "extension", extensionId: EXTENSION_ID };
      return tab;
    });
    await dispatch({ type: "BULK_MUTE" });

    tab.mutedInfo = { muted: true, reason: "extension", extensionId: "some-other-extension" };
    chrome.tabs.get.resolves(tab);

    const result = await dispatch({ type: "BULK_UNMUTE" });
    expect(result).toEqual({ type: "BULK_RESULT", result: { successCount: 0, failureCount: 1 } });
    expect(chrome.tabs.update.callCount).toBe(1);
  });

  it("常時ミュート規則に該当するタブは一括解除しない", async () => {
    wireFakeSessionStorage();
    chrome.storage.sync.get.resolves({
      alwaysMuteSettingsV1: { version: 1, alwaysMutedHosts: ["example.com"] },
    });
    await loadBackgroundFresh();

    const tab = makeTab({
      id: 1,
      audible: true,
      url: "https://example.com/",
      mutedInfo: { muted: false },
    });
    chrome.tabs.query.resolves([tab]);
    chrome.tabs.update.callsFake(async (tabId: number, props: { muted: boolean }) => {
      tab.mutedInfo = { muted: props.muted, reason: "extension", extensionId: EXTENSION_ID };
      return tab;
    });
    await dispatch({ type: "BULK_MUTE" });

    chrome.tabs.get.resolves(tab);
    const result = await dispatch({ type: "BULK_UNMUTE" });
    expect(result).toEqual({ type: "BULK_RESULT", result: { successCount: 0, failureCount: 1 } });
  });

  it("一括解除の対象は現在のウィンドウに限定される（グローバル集合との積集合）", async () => {
    wireFakeSessionStorage();
    await loadBackgroundFresh();

    const tabInWindow1 = makeTab({ id: 1, windowId: 1, audible: true, mutedInfo: { muted: false } });
    chrome.tabs.query.withArgs({ currentWindow: true }).resolves([tabInWindow1]);
    chrome.tabs.update.callsFake(async (tabId: number, props: { muted: boolean }) => {
      tabInWindow1.mutedInfo = { muted: props.muted, reason: "extension", extensionId: EXTENSION_ID };
      return tabInWindow1;
    });
    await dispatch({ type: "BULK_MUTE" });

    // タブが別ウィンドウへ移動した状況を模倣する（IDは維持されるがwindowIdが変わる）。
    const movedTab = { ...tabInWindow1, windowId: 2 };
    // 「現在のウィンドウ」は別ウィンドウ(id=1)のままで、movedTabはもうそこにいない。
    chrome.tabs.query.withArgs({ currentWindow: true }).resolves([]);
    chrome.tabs.get.resolves(movedTab);

    const result = await dispatch({ type: "BULK_UNMUTE" });
    // 現在のウィンドウには対象タブがいないため、解除処理そのものが発生しない。
    expect(result).toEqual({ type: "BULK_RESULT", result: { successCount: 0, failureCount: 0 } });
  });

  it("タブ消滅やAPIエラーを安全にスキップし、他タブの処理を継続する", async () => {
    wireFakeSessionStorage();
    await loadBackgroundFresh();

    const tabA = makeTab({ id: 1, audible: true, mutedInfo: { muted: false } });
    const tabB = makeTab({ id: 2, audible: true, mutedInfo: { muted: false } });
    chrome.tabs.query.resolves([tabA, tabB]);
    chrome.tabs.update.callsFake(async (tabId: number, props: { muted: boolean }) => {
      const tab = tabId === 1 ? tabA : tabB;
      tab.mutedInfo = { muted: props.muted, reason: "extension", extensionId: EXTENSION_ID };
      return tab;
    });
    await dispatch({ type: "BULK_MUTE" });

    chrome.tabs.get.withArgs(1).rejects(new Error("no tab"));
    chrome.tabs.get.withArgs(2).resolves(tabB);

    const result = await dispatch({ type: "BULK_UNMUTE" });
    expect(result).toEqual({ type: "BULK_RESULT", result: { successCount: 1, failureCount: 1 } });
  });

  it("[blocker修正の検証] Service Worker再起動後も、一括ミュートしたタブを一括解除できる", async () => {
    const session = wireFakeSessionStorage();
    await loadBackgroundFresh();

    const tab = makeTab({ id: 42, audible: true, mutedInfo: { muted: false } });
    chrome.tabs.query.resolves([tab]);
    chrome.tabs.update.callsFake(async (tabId: number, props: { muted: boolean }) => {
      tab.mutedInfo = { muted: props.muted, reason: "extension", extensionId: EXTENSION_ID };
      return tab;
    });

    const bulkMuteResult = await dispatch({ type: "BULK_MUTE" });
    expect(bulkMuteResult).toEqual({ type: "BULK_RESULT", result: { successCount: 1, failureCount: 0 } });
    // storage.sessionに実際に書き込まれている（インメモリ変数ではなく永続化先を使っている証跡）。
    expect(session.store.bulkMuteTabIdsV1).toEqual([42]);

    // Service Workerの再起動を模す：モジュールを再ロードし、インメモリ状態を
    // 全て破棄する。ただしstorage.sessionのフェイクストア（session.store）は
    // このテスト関数のクロージャ内に残り続けるため、実際のブラウザにおける
    // 「SWは再起動するがstorage.sessionは保持される」を再現できる。
    await loadBackgroundFresh();

    chrome.tabs.get.resolves(tab);
    const bulkUnmuteResult = await dispatch({ type: "BULK_UNMUTE" });
    expect(bulkUnmuteResult).toEqual({
      type: "BULK_RESULT",
      result: { successCount: 1, failureCount: 0 },
    });
  });
});

describe("background: storageの安全性", () => {
  it("storage全体が破損している場合は空規則にフォールバックする", async () => {
    wireFakeSessionStorage();
    chrome.storage.sync.get.resolves({ alwaysMuteSettingsV1: "not-an-object" });
    await loadBackgroundFresh();

    const result = await dispatch({ type: "GET_ALWAYS_MUTE_HOSTS" });
    expect(result).toEqual({ type: "ALWAYS_MUTE_HOSTS", hosts: [] });
  });

  it("容量超過時は既存のstorage.sync.setを呼ばずに失敗を返す", async () => {
    wireFakeSessionStorage();
    chrome.storage.sync.get.resolves({
      alwaysMuteSettingsV1: { version: 1, alwaysMutedHosts: ["example.com"] },
    });
    await loadBackgroundFresh();

    // isValidHostInputを通過しつつ（各ラベルは63文字以内）、8KB上限を超える
    // ホスト名を組み立てる。
    const hugeHost = Array.from({ length: 140 }, () => "a".repeat(60)).join(".");
    const result = await dispatch({ type: "ADD_ALWAYS_MUTE_HOST", host: hugeHost });
    expect(result).toEqual({ type: "SAVE_RESULT", ok: false, error: "quota-exceeded" });
    expect(chrome.storage.sync.set.called).toBe(false);
  });

  it("storage.sync.get()自体が失敗しても空設定へフォールボックし、メッセージ応答が返る", async () => {
    wireFakeSessionStorage();
    chrome.storage.sync.get.rejects(new Error("storage unavailable"));
    await loadBackgroundFresh();

    const result = await dispatch({ type: "GET_ALWAYS_MUTE_HOSTS" });
    expect(result).toEqual({ type: "ALWAYS_MUTE_HOSTS", hosts: [] });
  });

  it("不正なホスト名（URL全体やポート付き）は登録前に拒否される", async () => {
    wireFakeSessionStorage();
    await loadBackgroundFresh();

    const result = await dispatch({
      type: "ADD_ALWAYS_MUTE_HOST",
      host: "https://example.com/path",
    });
    expect(result).toEqual({ type: "SAVE_RESULT", ok: false, error: "invalid-host" });
    expect(chrome.storage.sync.set.called).toBe(false);
  });

  it("常時ミュート規則の追加と削除を並行実行しても更新が失われない", async () => {
    wireFakeSessionStorage();
    // 実際のstorage.syncのように、set()した値を後続のget()が返すフェイクにする。
    let stored: unknown = { version: 1, alwaysMutedHosts: ["existing.com"] };
    chrome.storage.sync.get.callsFake(async () => ({ alwaysMuteSettingsV1: stored }));
    chrome.storage.sync.set.callsFake(async (items: Record<string, unknown>) => {
      stored = items.alwaysMuteSettingsV1;
    });
    await loadBackgroundFresh();

    // 追加と削除をほぼ同時に発行する（レースコンディションの再現）。
    const [addResult, removeResult] = await Promise.all([
      dispatch({ type: "ADD_ALWAYS_MUTE_HOST", host: "new-site.com" }),
      dispatch({ type: "REMOVE_ALWAYS_MUTE_HOST", host: "existing.com" }),
    ]);
    expect((addResult as { ok: boolean }).ok).toBe(true);
    expect((removeResult as { ok: boolean }).ok).toBe(true);

    const finalHosts = (stored as { alwaysMutedHosts: string[] }).alwaysMutedHosts;
    // 直列化されていれば、追加も削除も両方が反映されているはず
    // （直列化なしだと、片方の書き込みがもう片方を上書きして消してしまう）。
    expect(finalHosts).toContain("new-site.com");
    expect(finalHosts).not.toContain("existing.com");
  });
});

describe("background: 常時ミュートの多層防御", () => {
  it("常時ミュート対象タブはTOGGLE_TAB_MUTEでも解除できない（サーバー側の防御）", async () => {
    wireFakeSessionStorage();
    chrome.storage.sync.get.resolves({
      alwaysMuteSettingsV1: { version: 1, alwaysMutedHosts: ["example.com"] },
    });
    await loadBackgroundFresh();

    const tab = makeTab({
      id: 7,
      url: "https://example.com/",
      mutedInfo: { muted: true, reason: "extension", extensionId: EXTENSION_ID },
    });
    chrome.tabs.get.resolves(tab);

    const result = await dispatch({ type: "TOGGLE_TAB_MUTE", tabId: 7 });
    expect(result).toEqual({ type: "TOGGLE_RESULT", ok: false });
    expect(chrome.tabs.update.called).toBe(false);
  });

  it("常時ミュート対象サイトでネイティブUI相当の解除が行われると再ミュートする", async () => {
    wireFakeSessionStorage();
    chrome.storage.sync.get.resolves({
      alwaysMuteSettingsV1: { version: 1, alwaysMutedHosts: ["example.com"] },
    });
    await loadBackgroundFresh();

    const tab = makeTab({ id: 8, url: "https://example.com/", mutedInfo: { muted: false } });
    chrome.tabs.get.resolves(tab);
    chrome.tabs.update.resolves(tab);

    const onUpdatedListener = chrome.tabs.onUpdated.addListener.lastCall.args[0] as (
      tabId: number,
      changeInfo: { url?: string; mutedInfo?: { muted: boolean } },
      tab: FakeTab
    ) => void;

    // URLは変わらないが、ネイティブUI等でミュートが解除されたイベントを模す。
    onUpdatedListener(8, { mutedInfo: { muted: false } }, tab);

    await vi.waitFor(() => {
      expect(chrome.tabs.update.calledWith(8, { muted: true })).toBe(true);
    });
  });

  it("常時ミュート対象でないタブの通常のミュート変更では再ミュートしない", async () => {
    wireFakeSessionStorage();
    await loadBackgroundFresh();

    const tab = makeTab({ id: 8, url: "https://not-muted.com/", mutedInfo: { muted: false } });

    const onUpdatedListener = chrome.tabs.onUpdated.addListener.lastCall.args[0] as (
      tabId: number,
      changeInfo: { url?: string; mutedInfo?: { muted: boolean } },
      tab: FakeTab
    ) => void;

    onUpdatedListener(8, { mutedInfo: { muted: false } }, tab);

    // 常時ミュート規則がないので、update呼び出しは発生しない。
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chrome.tabs.update.called).toBe(false);
  });
});

describe("background: onUpdated/onRemovedによる常時ミュート適用", () => {
  it("常時ミュート対象サイトへの遷移でタブを自動ミュートする", async () => {
    wireFakeSessionStorage();
    chrome.storage.sync.get.resolves({
      alwaysMuteSettingsV1: { version: 1, alwaysMutedHosts: ["example.com"] },
    });
    await loadBackgroundFresh();

    const tab = makeTab({ id: 5, url: "https://example.com/page", mutedInfo: { muted: false } });
    chrome.tabs.get.resolves(tab);
    chrome.tabs.update.resolves(tab);

    const onUpdatedListener = chrome.tabs.onUpdated.addListener.lastCall.args[0] as (
      tabId: number,
      changeInfo: { url?: string },
      tab: FakeTab
    ) => void;

    onUpdatedListener(5, { url: tab.url }, tab);
    await vi.waitFor(() => {
      expect(chrome.tabs.update.calledWith(5, { muted: true })).toBe(true);
    });
  });

  it("タブが閉じられたら一括ミュート追跡集合から除去する（onRemoved）", async () => {
    wireFakeSessionStorage();
    await loadBackgroundFresh();

    const tab = makeTab({ id: 9, audible: true, mutedInfo: { muted: false } });
    chrome.tabs.query.resolves([tab]);
    chrome.tabs.update.callsFake(async (tabId: number, props: { muted: boolean }) => {
      tab.mutedInfo = { muted: props.muted, reason: "extension", extensionId: EXTENSION_ID };
      return tab;
    });
    await dispatch({ type: "BULK_MUTE" });

    const onRemovedListener = chrome.tabs.onRemoved.addListener.lastCall.args[0] as (
      tabId: number
    ) => void;
    onRemovedListener(9);
    await new Promise((resolve) => setTimeout(resolve, 10));

    chrome.tabs.get.resolves(tab);
    const result = await dispatch({ type: "BULK_UNMUTE" });
    // 既に追跡集合から除去されているため、対象0件で解除処理自体が走らない。
    expect(result).toEqual({ type: "BULK_RESULT", result: { successCount: 0, failureCount: 0 } });
  });
});

describe("background: 主要メッセージのディスパッチ", () => {
  it("GET_TAB_LISTは音声関連タブだけを状態つきで返す", async () => {
    wireFakeSessionStorage();
    await loadBackgroundFresh();

    const audibleTab = makeTab({ id: 1, title: "再生中タブ", audible: true, mutedInfo: { muted: false } });
    const irrelevantTab = makeTab({ id: 2, title: "無関係タブ", audible: false, mutedInfo: { muted: false } });
    chrome.tabs.query.withArgs({ currentWindow: true }).resolves([audibleTab, irrelevantTab]);

    const result = await dispatch({ type: "GET_TAB_LIST" });
    expect(result.type).toBe("TAB_LIST");
    const tabs = (result as { type: "TAB_LIST"; tabs: { tabId: number; state: string }[] }).tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ tabId: 1, state: "audible" });
  });

  it("TOGGLE_TAB_MUTEは対象タブのミュート状態を反転する", async () => {
    wireFakeSessionStorage();
    await loadBackgroundFresh();

    const tab = makeTab({ id: 3, mutedInfo: { muted: false } });
    chrome.tabs.get.resolves(tab);
    chrome.tabs.update.resolves(tab);

    const result = await dispatch({ type: "TOGGLE_TAB_MUTE", tabId: 3 });
    expect(result).toEqual({ type: "TOGGLE_RESULT", ok: true });
    expect(chrome.tabs.update.calledWith(3, { muted: true })).toBe(true);
  });

  it("REMOVE_ALWAYS_MUTE_HOSTは規則から該当ホストを取り除く", async () => {
    wireFakeSessionStorage();
    let stored: unknown = { version: 1, alwaysMutedHosts: ["example.com", "other.com"] };
    chrome.storage.sync.get.callsFake(async () => ({ alwaysMuteSettingsV1: stored }));
    chrome.storage.sync.set.callsFake(async (items: Record<string, unknown>) => {
      stored = items.alwaysMuteSettingsV1;
    });
    await loadBackgroundFresh();

    const result = await dispatch({ type: "REMOVE_ALWAYS_MUTE_HOST", host: "example.com" });
    expect(result).toEqual({ type: "SAVE_RESULT", ok: true, error: undefined });
    expect((stored as { alwaysMutedHosts: string[] }).alwaysMutedHosts).toEqual(["other.com"]);
  });
});
