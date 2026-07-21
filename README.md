# 音声タブコントローラー

音が出ているタブの一覧・個別ミュート・一括ミュート／安全な一括解除、
サイト単位の常時ミュートを提供するChrome拡張機能（Manifest V3）。

[ai-council v2](https://github.com/momokuomomo-crypto/ai-council_v2)の
会合で検討・承認された
[稟議書](https://github.com/momokuomomo-crypto/ai-council-output/blob/master/chrome-extension-ideas/稟議書_Chrome拡張機能アイデア.md)
（項目7）をもとに、
[ai-build-council](https://github.com/momokuomomo-crypto/ai-build-council)
のワークフローで設計・実装した。

## 主な機能

- 現在のウィンドウで音声再生中・ミュート中のタブを一覧表示（3状態を区別）
- 個別ミュート／解除
- 一括ミュート、および**拡張機能が一括ミュートしたタブだけ**を安全に
  一括解除（ユーザーがネイティブUIで再ミュートしたタブ・他拡張機能が
  ミュートしたタブは誤って解除しない）
- サイト単位の常時ミュート規則（`storage.sync`に保存、新規タブ・URL遷移・
  ネイティブUIでの解除に対して自動再適用）

## セットアップ

```bash
npm install
npm run build
```

`chrome://extensions` でデベロッパーモードを有効にし、
「パッケージ化されていない拡張機能を読み込む」で`dist/`を選択する。

## 開発

```bash
npm run dev         # 開発用ビルド（watch）
npm run typecheck
npm run lint
npm run test         # 単体・統合テスト（Vitest, sinon-chrome）
npm run build        # 本番ビルド
```

## E2Eテストについて

`npm run test:e2e`（Playwright）は実際のChromeへ拡張機能をロードして
個別ミュート・一括ミュート／解除を検証する。**この開発環境ではPlaywrightの
Chromiumバイナリが起動できない既知の問題があり**（`side-by-side
configuration incorrect`。クリーン再インストールでも再発し、環境固有の
問題と判断）、代わりに [e2e/MANUAL_CHECKLIST.md](e2e/MANUAL_CHECKLIST.md)
による手動確認へ切り替えている。**実際にChromeが動く環境（リリース前）で、
このチェックリストを一度実行すること。** 環境が整えば、
`e2e/voice-tab-controller.spec.ts`はそのまま自動テストとして使える。

## ディレクトリ構成

```
src/
  background.ts        # Service Worker（状態管理・メッセージ処理の中心）
  popup/                # ツールバーpopup UI（Vanilla TS/HTML/CSS）
  shared/               # 純粋関数（状態導出・サイト規則・storage・メッセージ型）
tests/
  unit/                  # 純粋関数の単体テスト（Vitest）
  integration/           # background.tsの統合テスト（sinon-chrome）
e2e/
  voice-tab-controller.spec.ts  # Playwright E2E（環境要件あり）
  MANUAL_CHECKLIST.md           # 手動確認チェックリスト
  fixtures/audio-page.html      # E2E・手動確認用の音声再生テストページ
```

## 収益化方法

無料版で提供。Pro版で曜日別ルール・許可リスト同期を提供する。

## 将来の拡張案

- 勤務時間のみミュート
- 音声タブ履歴

出典：[稟議書_Chrome拡張機能アイデア.md（項目7）](https://github.com/momokuomomo-crypto/ai-council-output/blob/master/chrome-extension-ideas/稟議書_Chrome拡張機能アイデア.md)

## 開発の経緯

このリポジトリの設計・実装は
[ai-build-council](https://github.com/momokuomomo-crypto/ai-build-council)
のゲート付きワークフロー（独立設計→設計査読→実装→テスト→固定diffの
独立実装レビュー→修正→記録）で行われた。実装レビューで、一括解除の
追跡状態をインメモリのみで保持していたためService Worker再起動後に
一括解除が機能しなくなる重大な機能欠陥（blocker）が発見され、
`chrome.storage.session`を使う設計に一度修正した。

その後、実際に使ってみたところ「個別ミュートで既に止めていたタブに
新規音声が流れると、一括ミュート・一括解除のどちらも効かない」という
バグが見つかった。原因は、一括解除の対象を独自の追跡集合（一括ミュート
ボタン経由で止めたタブだけ）に限定しすぎていたこと。安全性は
Chromeの一次情報（`mutedInfo.reason`・`extensionId`）だけで十分に
担保できるため、**追跡集合そのものを廃止**し、常にChromeの現在の状態を
根拠に判定する設計へ簡略化した。これにより、このバグに加えて
Service Worker再起動への依存も構造的になくなっている
（そもそも独自の状態を持たないため）。
