import { describe, expect, it } from "vitest";
import chrome from "sinon-chrome";
import { loadSettings, saveSettings } from "../../src/shared/storage";

describe("loadSettings", () => {
  it("returns empty settings when nothing is stored", async () => {
    chrome.storage.sync.get.resolves({});
    const settings = await loadSettings();
    expect(settings).toEqual({ version: 1, alwaysMutedHosts: [] });
  });

  it("sanitizes corrupted stored data instead of throwing", async () => {
    chrome.storage.sync.get.resolves({
      alwaysMuteSettingsV1: { version: 999, alwaysMutedHosts: ["x"] },
    });
    const settings = await loadSettings();
    expect(settings).toEqual({ version: 1, alwaysMutedHosts: [] });
  });

  it("returns sanitized valid data", async () => {
    chrome.storage.sync.get.resolves({
      alwaysMuteSettingsV1: { version: 1, alwaysMutedHosts: ["example.com", "Example.com"] },
    });
    const settings = await loadSettings();
    expect(settings.alwaysMutedHosts).toEqual(["example.com"]);
  });
});

describe("saveSettings", () => {
  it("writes to storage.sync when within quota", async () => {
    chrome.storage.sync.set.resolves(undefined);
    const result = await saveSettings({ version: 1, alwaysMutedHosts: ["example.com"] });
    expect(result.ok).toBe(true);
    expect(chrome.storage.sync.set.calledOnce).toBe(true);
  });

  it("refuses to write and does not touch storage when over quota", async () => {
    const hugeHosts = Array.from({ length: 2000 }, (_, i) => `host-${i}.example.com`);
    const result = await saveSettings({ version: 1, alwaysMutedHosts: hugeHosts });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("quota-exceeded");
    expect(chrome.storage.sync.set.called).toBe(false);
  });

  it("reports failure without throwing when the write rejects", async () => {
    chrome.storage.sync.set.rejects(new Error("boom"));
    const result = await saveSettings({ version: 1, alwaysMutedHosts: ["example.com"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown");
  });
});
