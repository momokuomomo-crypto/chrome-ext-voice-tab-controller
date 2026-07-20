import { emptySettings, sanitizeSettings, type StoredSettingsV1 } from "./site-rules";

const STORAGE_KEY = "alwaysMuteSettingsV1";

/** chrome.storage.syncの1アイテムあたりの容量上限（QUOTA_BYTES_PER_ITEM）。 */
const QUOTA_BYTES_PER_ITEM = 8192;

export interface SaveResult {
  ok: boolean;
  error?: "quota-exceeded" | "unknown";
}

/** 保存済みの常時ミュート設定を読み込む。壊れていれば安全な空設定を返す。 */
export async function loadSettings(): Promise<StoredSettingsV1> {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const raw = result[STORAGE_KEY];
  if (raw === undefined) return emptySettings();
  return sanitizeSettings(raw);
}

/**
 * 常時ミュート設定を保存する。書き込み前にサイズを検査し、
 * 容量超過が見込まれる場合は既存値を壊さずに失敗を返す。
 */
export async function saveSettings(settings: StoredSettingsV1): Promise<SaveResult> {
  const serialized = JSON.stringify(settings);
  const sizeBytes = new TextEncoder().encode(serialized).length;
  // キー名分の余裕を見て判定する。
  if (sizeBytes + STORAGE_KEY.length > QUOTA_BYTES_PER_ITEM) {
    return { ok: false, error: "quota-exceeded" };
  }

  try {
    await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
    return { ok: true };
  } catch {
    return { ok: false, error: "unknown" };
  }
}
