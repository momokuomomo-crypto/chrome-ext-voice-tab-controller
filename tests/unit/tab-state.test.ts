import { describe, expect, it } from "vitest";
import {
  deriveAudioState,
  isBulkMuteCandidate,
  isRelevantTab,
  isSafeToBulkUnmute,
} from "../../src/shared/tab-state";

describe("deriveAudioState", () => {
  it.each([
    [{ audible: true, mutedInfo: { muted: false } }, "audible"],
    [{ audible: true, mutedInfo: { muted: true } }, "audible-muted"],
    [{ audible: false, mutedInfo: { muted: true } }, "silent-muted"],
    [{ audible: false, mutedInfo: { muted: false } }, "none"],
    [{}, "none"],
  ] as const)("derives %o -> %s", (tab, expected) => {
    expect(deriveAudioState(tab)).toBe(expected);
  });
});

describe("isRelevantTab", () => {
  it("is true for any non-none state", () => {
    expect(isRelevantTab({ audible: true })).toBe(true);
    expect(isRelevantTab({ mutedInfo: { muted: true } })).toBe(true);
  });

  it("is false when neither audible nor muted", () => {
    expect(isRelevantTab({ audible: false, mutedInfo: { muted: false } })).toBe(false);
  });
});

describe("isBulkMuteCandidate", () => {
  it("targets audible and not-yet-muted tabs", () => {
    expect(isBulkMuteCandidate({ audible: true, mutedInfo: { muted: false } })).toBe(true);
  });

  it("excludes already muted tabs", () => {
    expect(isBulkMuteCandidate({ audible: true, mutedInfo: { muted: true } })).toBe(false);
  });

  it("excludes non-audible tabs", () => {
    expect(isBulkMuteCandidate({ audible: false })).toBe(false);
  });
});

describe("isSafeToBulkUnmute", () => {
  const extensionId = "self-ext-id";
  const noAlwaysMuteRule = () => false;
  const alwaysMuteRule = () => true;

  it("allows unmute when extension itself owns the mute", () => {
    const tab = {
      id: 1,
      mutedInfo: { muted: true, reason: "extension", extensionId },
    };
    expect(isSafeToBulkUnmute(tab, extensionId, noAlwaysMuteRule)).toBe(true);
  });

  it("[バグ修正の検証] 個別ミュートボタンで止めたタブも解除対象になる（独自の追跡集合に依存しない）", () => {
    // 「個別ミュートボタンで止めた」「拡張機能導入前から既にミュートされていた
    // タブに新規音声が流れた」のいずれも、Chrome上ではmutedInfo.reason=
    // 'extension'かつextensionIdが自分自身であれば同じ状態になる。
    // 独自の追跡集合を経由したかどうかに関わらず、この条件だけで解除可能と
    // 判定できるべき（実運用で発見されたバグの修正）。
    const tab = {
      id: 999,
      mutedInfo: { muted: true, reason: "extension", extensionId },
    };
    expect(isSafeToBulkUnmute(tab, extensionId, noAlwaysMuteRule)).toBe(true);
  });

  it("blocks unmute when user re-muted via native UI (reason=user)", () => {
    const tab = {
      id: 1,
      mutedInfo: { muted: true, reason: "user", extensionId },
    };
    expect(isSafeToBulkUnmute(tab, extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when a different extension owns the mute", () => {
    const tab = {
      id: 1,
      mutedInfo: { muted: true, reason: "extension", extensionId: "other-ext" },
    };
    expect(isSafeToBulkUnmute(tab, extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when tab is already unmuted", () => {
    const tab = { id: 1, mutedInfo: { muted: false, reason: "extension", extensionId } };
    expect(isSafeToBulkUnmute(tab, extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when mutedInfo is missing (fail-safe)", () => {
    const tab = { id: 1 };
    expect(isSafeToBulkUnmute(tab, extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when tab id is undefined", () => {
    const tab = { mutedInfo: { muted: true, reason: "extension", extensionId } };
    expect(isSafeToBulkUnmute(tab, extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when the always-mute rule matches", () => {
    const tab = { id: 1, mutedInfo: { muted: true, reason: "extension", extensionId } };
    expect(isSafeToBulkUnmute(tab, extensionId, alwaysMuteRule)).toBe(false);
  });
});
