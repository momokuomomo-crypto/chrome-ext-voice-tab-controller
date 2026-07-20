import chrome from "sinon-chrome";
import { afterEach, beforeEach } from "vitest";

// sinon-chromeが提供するグローバルchrome APIフェイクを、テスト実行環境へ注入する。
// 手書きモックではなく既存の確立されたフェイクを利用する（凍結設計）。
(globalThis as unknown as { chrome: typeof chrome }).chrome = chrome;

beforeEach(() => {
  chrome.flush();
});

afterEach(() => {
  chrome.flush();
});
