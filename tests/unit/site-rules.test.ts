import { describe, expect, it } from "vitest";
import {
  addAlwaysMutedHost,
  emptySettings,
  extractNormalizedHost,
  isAlwaysMutedUrl,
  isValidHostInput,
  normalizeHost,
  removeAlwaysMutedHost,
  sanitizeSettings,
} from "../../src/shared/site-rules";

describe("isValidHostInput", () => {
  it("accepts a bare hostname", () => {
    expect(isValidHostInput("example.com")).toBe(true);
    expect(isValidHostInput("mail.example.co.jp")).toBe(true);
    expect(isValidHostInput("  example.com  ")).toBe(true);
  });

  it("rejects a full URL (scheme/path present)", () => {
    expect(isValidHostInput("https://example.com/path")).toBe(false);
    expect(isValidHostInput("http://example.com")).toBe(false);
  });

  it("rejects a hostname with a port", () => {
    expect(isValidHostInput("example.com:8080")).toBe(false);
  });

  it("rejects input containing whitespace in the middle", () => {
    expect(isValidHostInput("exa mple.com")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isValidHostInput("")).toBe(false);
    expect(isValidHostInput("   ")).toBe(false);
  });

  it("rejects userinfo/path/query/fragment characters", () => {
    expect(isValidHostInput("user@example.com")).toBe(false);
    expect(isValidHostInput("example.com/path")).toBe(false);
    expect(isValidHostInput("example.com?x=1")).toBe(false);
    expect(isValidHostInput("example.com#frag")).toBe(false);
  });
});

describe("normalizeHost", () => {
  it("lowercases and strips trailing dot", () => {
    expect(normalizeHost("Example.COM.")).toBe("example.com");
  });

  it("strips a leading www. only", () => {
    expect(normalizeHost("www.example.com")).toBe("example.com");
  });

  it("keeps other subdomains distinct (intentional asymmetry)", () => {
    expect(normalizeHost("mail.example.com")).toBe("mail.example.com");
    expect(normalizeHost("music.example.com")).not.toBe("example.com");
  });
});

describe("extractNormalizedHost", () => {
  it("extracts a normalized host from an http(s) URL", () => {
    expect(extractNormalizedHost("https://WWW.Example.com/path?x=1")).toBe("example.com");
  });

  it("returns null for non-http(s) protocols", () => {
    expect(extractNormalizedHost("chrome://extensions")).toBeNull();
    expect(extractNormalizedHost("file:///C:/foo.html")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(extractNormalizedHost("not a url")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(extractNormalizedHost(undefined)).toBeNull();
  });
});

describe("isAlwaysMutedUrl", () => {
  it("matches when the normalized host is registered", () => {
    const settings = { version: 1 as const, alwaysMutedHosts: ["example.com"] };
    expect(isAlwaysMutedUrl("https://www.example.com/", settings)).toBe(true);
  });

  it("does not match unrelated subdomains", () => {
    const settings = { version: 1 as const, alwaysMutedHosts: ["example.com"] };
    expect(isAlwaysMutedUrl("https://mail.example.com/", settings)).toBe(false);
  });

  it("does not match unparsable urls", () => {
    const settings = { version: 1 as const, alwaysMutedHosts: ["example.com"] };
    expect(isAlwaysMutedUrl("chrome://settings", settings)).toBe(false);
  });
});

describe("addAlwaysMutedHost / removeAlwaysMutedHost", () => {
  it("adds a normalized host without duplicates", () => {
    let settings = emptySettings();
    settings = addAlwaysMutedHost(settings, "WWW.Example.com");
    settings = addAlwaysMutedHost(settings, "example.com");
    expect(settings.alwaysMutedHosts).toEqual(["example.com"]);
  });

  it("removes a host by normalized form", () => {
    let settings = addAlwaysMutedHost(emptySettings(), "example.com");
    settings = removeAlwaysMutedHost(settings, "WWW.example.com.");
    expect(settings.alwaysMutedHosts).toEqual([]);
  });
});

describe("sanitizeSettings", () => {
  it("returns empty settings for null/undefined/non-object", () => {
    expect(sanitizeSettings(null)).toEqual(emptySettings());
    expect(sanitizeSettings(undefined)).toEqual(emptySettings());
    expect(sanitizeSettings("broken")).toEqual(emptySettings());
  });

  it("returns empty settings when version mismatches", () => {
    expect(sanitizeSettings({ version: 2, alwaysMutedHosts: ["example.com"] })).toEqual(
      emptySettings()
    );
  });

  it("returns empty settings when alwaysMutedHosts is not an array", () => {
    expect(sanitizeSettings({ version: 1, alwaysMutedHosts: "example.com" })).toEqual(
      emptySettings()
    );
  });

  it("discards non-string and empty entries while keeping valid ones", () => {
    const result = sanitizeSettings({
      version: 1,
      alwaysMutedHosts: ["example.com", 123, "", "  ", "Other.com"],
    });
    expect(result).toEqual({ version: 1, alwaysMutedHosts: ["example.com", "other.com"] });
  });

  it("deduplicates entries after normalization", () => {
    const result = sanitizeSettings({
      version: 1,
      alwaysMutedHosts: ["example.com", "www.example.com", "EXAMPLE.COM"],
    });
    expect(result.alwaysMutedHosts).toEqual(["example.com"]);
  });
});
