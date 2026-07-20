import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "../dist");
const audioPageUrl = `file://${path.resolve(__dirname, "fixtures/audio-page.html")}`;

/**
 * 凍結設計で必須とした最小E2E。時間不足でも省略しない
 * （静的解析・単体テストだけでは「実際にChromeで動く」ことを検証できないため）。
 *
 * 検証する項目：
 * 1. テスト用ページで音声を再生する
 * 2. popupに対象タブが表示される
 * 3. 拡張機能からミュートし、実際にタブがミュート状態になる
 * 4. 一括ミュート／一括解除で、拡張機能がミュートした対象だけが解除される
 *
 * 「ネイティブUIでの再ミュート」「別拡張機能によるミュート」の保護は、
 * Playwrightではネイティブブラウザチロームを直接操作できないため、
 * tests/integration/background.test.ts（sinon-chromeでreason/extensionIdを
 * 明示的に模擬）と、手動確認チェックリストで検証する（凍結設計で明記した方針）。
 */
test("音声タブコントローラー: 拡張ロード・個別ミュート・一括ミュート/解除", async () => {
  test.setTimeout(60_000);

  if (!fs.existsSync(extensionPath)) {
    throw new Error(`ビルド成果物が見つかりません: ${extensionPath}。先に npm run build を実行してください。`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-tab-controller-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
    }
    const extensionId = serviceWorker.url().split("/")[2];
    expect(extensionId).toBeTruthy();

    // 1. テストページで音声を再生する（ユーザー操作としてクリックする）
    const audioPage = await context.newPage();
    await audioPage.goto(audioPageUrl);
    await audioPage.click("#play-btn");
    await expect(audioPage.locator("#status")).toHaveText("playing");

    // popupページを直接開く（ツールバーアイコンのクリックはPlaywrightでは
    // 安定して再現できないため、拡張ページへの直接ナビゲーションで代替する）。
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup/index.html`);

    // 2. popupに対象タブが表示される
    await expect(popupPage.locator("#tab-list li")).toHaveCount(1, { timeout: 15_000 });
    await expect(popupPage.locator("#empty-state")).toBeHidden();

    // 3. 個別ミュートし、実際にタブがミュート状態になることを確認する。
    // 検証はpopup自身が持つtabs権限経由でchrome.tabs.queryを呼び、実タブの
    // mutedInfoを直接確認する（Playwrightにchrome.tabs相当のAPIはないため）。
    await popupPage.locator("#tab-list li button").first().click();

    await expect(async () => {
      const tabs = (await popupPage.evaluate(() =>
        chrome.tabs.query({})
      )) as chrome.tabs.Tab[];
      const target = tabs.find((t) => t.url?.includes("audio-page.html"));
      expect(target?.mutedInfo?.muted).toBe(true);
    }).toPass({ timeout: 5_000 });

    // 個別解除で未ミュートに戻す（一括ミュートの前提を作る）。
    await popupPage.reload();
    await expect(popupPage.locator("#tab-list li")).toHaveCount(1, { timeout: 10_000 });
    await popupPage.locator("#tab-list li button").first().click();

    await expect(async () => {
      const tabs = (await popupPage.evaluate(() =>
        chrome.tabs.query({})
      )) as chrome.tabs.Tab[];
      const target = tabs.find((t) => t.url?.includes("audio-page.html"));
      expect(target?.mutedInfo?.muted).toBe(false);
    }).toPass({ timeout: 5_000 });

    // 4. 一括ミュートを実行し、拡張機能自身がミュート所有者になることを確認する。
    await popupPage.reload();
    await popupPage.locator("#bulk-mute-btn").click();

    await expect(async () => {
      const tabs = (await popupPage.evaluate(() =>
        chrome.tabs.query({})
      )) as chrome.tabs.Tab[];
      const target = tabs.find((t) => t.url?.includes("audio-page.html"));
      expect(target?.mutedInfo?.muted).toBe(true);
      expect(target?.mutedInfo?.reason).toBe("extension");
    }).toPass({ timeout: 5_000 });

    // 一括解除で、拡張機能がミュートした対象が実際に解除されることを確認する。
    await popupPage.locator("#bulk-unmute-btn").click();

    await expect(async () => {
      const tabs = (await popupPage.evaluate(() =>
        chrome.tabs.query({})
      )) as chrome.tabs.Tab[];
      const target = tabs.find((t) => t.url?.includes("audio-page.html"));
      expect(target?.mutedInfo?.muted).toBe(false);
    }).toPass({ timeout: 5_000 });
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
