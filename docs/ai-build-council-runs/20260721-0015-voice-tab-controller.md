# ai-build-council 実行記録 — 20260721-0015-voice-tab-controller

[ai-build-council](https://github.com/momokuomomo-crypto/ai-build-council)
のワークフローによる初回実装の要約。生ログ・diff等の詳細は
`.ai-build-council/runs/`（git管理対象外）を参照。

## 概要

- テーマ：Chrome拡張機能「音声タブコントローラー」の設計・実装
- 参考情報：ai-council_v2の稟議書（音声タブコントローラー案）
- 裁定：条件付き承認 → 実装 → 実装レビューで1件のblocker・複数のmajor/minorを
  発見・修正 → Test Gate B通過

## 発見された重大な欠陥（blocker）と修正

一括ミュートしたタブの追跡状態（`bulkMuteTabIds`）をService Worker内の
インメモリ変数のみで管理していたため、MV3 Service Workerが非操作状態で
自動終了する挙動（目安30秒程度）により、実運用下で高確率に一括解除機能が
機能しなくなる欠陥が実装レビューで発見された。`chrome.storage.session`
（Service Worker再起動を跨いで保持され、ブラウザ終了時のみ消える）へ
移行して修正し、専用の統合テストで「一括ミュート→SW再起動を模した
モジュール再ロード→一括解除」が正しく動作することを確認した。

## その他の主な修正

- 常時ミュート対象タブをネイティブUIで解除しても再適用されない不具合を修正
  （`tabs.onUpdated`が`mutedInfo`の変化も監視するよう拡張）
- 常時ミュート設定の追加・削除を並行実行した際のロストアップデートを修正
  （書き込みの直列化）
- `storage.sync`読み込み失敗時のフォールバック処理を追加
- 常時ミュート登録欄のホスト名入力検証を追加
- メッセージハンドラの未捕捉例外への対処、popup側のエラー表示を追加

## テスト

- Test Gate A・Bともに typecheck・lint・build は通過
- 単体・統合テストは70件（Vitest + sinon-chrome）
- Playwright自動E2Eは開発環境のインフラ制約（Chromiumバイナリの起動不可）
  により未実行。[e2e/MANUAL_CHECKLIST.md](../../e2e/MANUAL_CHECKLIST.md)
  による手動確認に切り替え済み。**リリース前に実機Chromeでの実行が必須。**

## 詳細

- 稟議書相当の裁定・指摘処理記録：`.ai-build-council/runs/20260721-0015-voice-tab-controller/`
  （`decisions/implementation-review-decisions.md`、`final/report.md`等）
