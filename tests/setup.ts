import chrome from "sinon-chrome";
import sinon from "sinon";
import { afterEach, beforeEach } from "vitest";

// sinon-chromeが提供するグローバルchrome APIフェイクを、テスト実行環境へ注入する。
// 手書きモックではなく既存の確立されたフェイクを利用する（凍結設計）。
(globalThis as unknown as { chrome: typeof chrome }).chrome = chrome;

/**
 * sinon-chrome@3.0.1はchrome.storage.sessionを提供していない
 * （比較的新しいAPIのため）。get/setだけの最小限のフェイクを追加する。
 */
const sessionStorageFake = {
  get: sinon.stub(),
  set: sinon.stub(),
};
(chrome.storage as unknown as { session: typeof sessionStorageFake }).session = sessionStorageFake;

beforeEach(() => {
  chrome.flush();
  sessionStorageFake.get.reset();
  sessionStorageFake.set.reset();
  sessionStorageFake.get.resolves({});
  sessionStorageFake.set.resolves(undefined);
});

afterEach(() => {
  chrome.flush();
});
