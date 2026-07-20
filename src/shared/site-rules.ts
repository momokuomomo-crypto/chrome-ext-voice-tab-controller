/** サイト単位の常時ミュート規則（ホスト名の正規化・判定）を扱う純粋関数群。 */

export const SETTINGS_SCHEMA_VERSION = 1 as const;

export interface StoredSettingsV1 {
  version: 1;
  alwaysMutedHosts: string[];
}

export function emptySettings(): StoredSettingsV1 {
  return { version: SETTINGS_SCHEMA_VERSION, alwaysMutedHosts: [] };
}

/**
 * ホスト名を正規化する。小文字化・末尾ドット除去・先頭www.のみ除去する。
 * 他のサブドメイン（mail.example.com等）は意図的に区別したままにする
 * （凍結設計で明記した意図的な非対称性）。
 */
export function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  host = host.replace(/\.$/, "");
  if (host.startsWith("www.")) {
    host = host.slice(4);
  }
  return host;
}

/**
 * ユーザーが常時ミュート登録欄に入力した文字列が、素のホスト名として
 * 妥当かを検証する（例："example.com"はOK、"https://example.com/path"や
 * "example.com:443"、空白を含む文字列はNG）。
 * 検証なしで受け入れると、実タブから抽出される正規化ホスト名（常に
 * scheme・path・portを持たない）と二度と一致しない規則が静かに
 * 作られてしまう（実装レビューで発見されたmajor）。
 */
const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

export function isValidHostInput(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("://")) return false;
  if (/[\s/\\?#@:]/.test(trimmed)) return false;
  return HOSTNAME_PATTERN.test(trimmed);
}

/** HTTP/HTTPS以外・不正URL・Chrome内部ページ等は対象外として null を返す。 */
export function extractNormalizedHost(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return normalizeHost(parsed.hostname);
}

export function isAlwaysMutedUrl(
  url: string | undefined,
  settings: StoredSettingsV1
): boolean {
  const host = extractNormalizedHost(url);
  if (host === null) return false;
  return settings.alwaysMutedHosts.includes(host);
}

export function addAlwaysMutedHost(
  settings: StoredSettingsV1,
  host: string
): StoredSettingsV1 {
  const normalized = normalizeHost(host);
  if (settings.alwaysMutedHosts.includes(normalized)) return settings;
  return {
    version: SETTINGS_SCHEMA_VERSION,
    alwaysMutedHosts: [...settings.alwaysMutedHosts, normalized],
  };
}

export function removeAlwaysMutedHost(
  settings: StoredSettingsV1,
  host: string
): StoredSettingsV1 {
  const normalized = normalizeHost(host);
  return {
    version: SETTINGS_SCHEMA_VERSION,
    alwaysMutedHosts: settings.alwaysMutedHosts.filter((h) => h !== normalized),
  };
}

/**
 * 保存データを検証し、正常な規則だけを残す（破損データの安全なフォールバック）。
 * トップレベル構造・バージョンが解釈不能なら空設定を返す。
 * 型不一致・空文字・不正なホスト名は個別に破棄する。
 */
export function sanitizeSettings(raw: unknown): StoredSettingsV1 {
  if (typeof raw !== "object" || raw === null) return emptySettings();
  const obj = raw as Record<string, unknown>;
  if (obj.version !== SETTINGS_SCHEMA_VERSION) return emptySettings();
  if (!Array.isArray(obj.alwaysMutedHosts)) return emptySettings();

  const cleaned: string[] = [];
  for (const item of obj.alwaysMutedHosts) {
    if (typeof item !== "string") continue;
    const normalized = normalizeHost(item);
    if (normalized.length === 0) continue;
    if (!cleaned.includes(normalized)) cleaned.push(normalized);
  }
  return { version: SETTINGS_SCHEMA_VERSION, alwaysMutedHosts: cleaned };
}
