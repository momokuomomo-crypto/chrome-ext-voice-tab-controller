import { describe, expect, it } from "vitest";
import {
  deriveAudioState,
  intersectWithCurrentWindow,
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
    expect(isSafeToBulkUnmute(tab, new Set([1]), extensionId, noAlwaysMuteRule)).toBe(true);
  });

  it("blocks unmute when user re-muted via native UI (reason=user)", () => {
    const tab = {
      id: 1,
      mutedInfo: { muted: true, reason: "user", extensionId },
    };
    expect(isSafeToBulkUnmute(tab, new Set([1]), extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when a different extension owns the mute", () => {
    const tab = {
      id: 1,
      mutedInfo: { muted: true, reason: "extension", extensionId: "other-ext" },
    };
    expect(isSafeToBulkUnmute(tab, new Set([1]), extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when tab is not in the tracked set", () => {
    const tab = {
      id: 2,
      mutedInfo: { muted: true, reason: "extension", extensionId },
    };
    expect(isSafeToBulkUnmute(tab, new Set([1]), extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when tab is already unmuted", () => {
    const tab = { id: 1, mutedInfo: { muted: false, reason: "extension", extensionId } };
    expect(isSafeToBulkUnmute(tab, new Set([1]), extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when mutedInfo is missing (fail-safe)", () => {
    const tab = { id: 1 };
    expect(isSafeToBulkUnmute(tab, new Set([1]), extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when tab id is undefined", () => {
    const tab = { mutedInfo: { muted: true, reason: "extension", extensionId } };
    expect(isSafeToBulkUnmute(tab, new Set([1]), extensionId, noAlwaysMuteRule)).toBe(false);
  });

  it("blocks unmute when the always-mute rule matches", () => {
    const tab = { id: 1, mutedInfo: { muted: true, reason: "extension", extensionId } };
    expect(isSafeToBulkUnmute(tab, new Set([1]), extensionId, alwaysMuteRule)).toBe(false);
  });
});

describe("intersectWithCurrentWindow", () => {
  it("keeps only ids present in the current window", () => {
    const global = new Set([1, 2, 3]);
    const currentWindow = new Set([2, 3, 4]);
    expect(intersectWithCurrentWindow(global, currentWindow)).toEqual(new Set([2, 3]));
  });

  it("returns an empty set when there is no overlap", () => {
    expect(intersectWithCurrentWindow(new Set([1]), new Set([2]))).toEqual(new Set());
  });
});
