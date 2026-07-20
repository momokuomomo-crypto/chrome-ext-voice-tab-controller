/** タブの音声・ミュート状態の導出、および一括ミュート/解除の対象判定を行う純粋関数群。 */

export type AudioState = "audible" | "audible-muted" | "silent-muted" | "none";

export interface MutedInfoLike {
  muted: boolean;
  reason?: string;
  extensionId?: string;
}

export interface TabLike {
  id?: number;
  url?: string;
  audible?: boolean;
  mutedInfo?: MutedInfoLike;
}

/** audible/mutedInfoの組み合わせから表示状態を導出する。 */
export function deriveAudioState(tab: TabLike): AudioState {
  const audible = tab.audible === true;
  const muted = tab.mutedInfo?.muted === true;

  if (audible && !muted) return "audible";
  if (audible && muted) return "audible-muted";
  if (!audible && muted) return "silent-muted";
  return "none";
}

/** 一覧表示の対象にすべきタブかどうか。 */
export function isRelevantTab(tab: TabLike): boolean {
  return deriveAudioState(tab) !== "none";
}

/** 一括ミュートの対象（現在ウィンドウで再生中かつ未ミュート）かどうか。 */
export function isBulkMuteCandidate(tab: TabLike): boolean {
  return tab.audible === true && tab.mutedInfo?.muted !== true;
}

/**
 * 一括解除の対象として安全かどうかを判定する。
 * 「拡張機能が現在のミュート所有者であること」をChromeの一次情報
 * （mutedInfo.reason / mutedInfo.extensionId）で必須ガードとする。
 * ここが崩れると、ユーザーがネイティブUIで再ミュートしたタブを
 * 誤って解除してしまう（凍結設計で修正した安全性の核心部分）。
 */
export function isSafeToBulkUnmute(
  tab: TabLike,
  bulkMuteTabIds: ReadonlySet<number>,
  extensionId: string,
  matchesAlwaysMuteRule: (url: string | undefined) => boolean
): boolean {
  if (tab.id === undefined) return false;
  if (!bulkMuteTabIds.has(tab.id)) return false;
  if (tab.mutedInfo?.muted !== true) return false;
  if (tab.mutedInfo?.reason !== "extension") return false;
  if (tab.mutedInfo?.extensionId !== extensionId) return false;
  if (matchesAlwaysMuteRule(tab.url)) return false;
  return true;
}

/** 集合から、現在ウィンドウに存在するタブIDだけを抽出する（積集合）。 */
export function intersectWithCurrentWindow(
  bulkMuteTabIds: ReadonlySet<number>,
  currentWindowTabIds: ReadonlySet<number>
): Set<number> {
  const result = new Set<number>();
  for (const id of bulkMuteTabIds) {
    if (currentWindowTabIds.has(id)) result.add(id);
  }
  return result;
}
