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
 *
 * 「拡張機能が現在のミュート所有者であること」はChromeの一次情報
 * （mutedInfo.reason / mutedInfo.extensionId）だけで完全に判定できる。
 * 独自のタブID追跡集合（旧bulkMuteTabIds）は安全性の担保に不要であり、
 * むしろ「個別ミュートボタンで止めた場合」や「拡張機能導入前から既に
 * ミュートされていたタブに新規音声が流れた場合」を、本来解除してよい
 * にもかかわらず無意味に除外してしまう副作用があった（実運用で発見された
 * バグ）。安全性はreason/extensionId/常時ミュート規則の3条件だけで
 * 十分に担保され、それ以上の制限は過剰である。
 */
export function isSafeToBulkUnmute(
  tab: TabLike,
  extensionId: string,
  matchesAlwaysMuteRule: (url: string | undefined) => boolean
): boolean {
  if (tab.id === undefined) return false;
  if (tab.mutedInfo?.muted !== true) return false;
  if (tab.mutedInfo?.reason !== "extension") return false;
  if (tab.mutedInfo?.extensionId !== extensionId) return false;
  if (matchesAlwaysMuteRule(tab.url)) return false;
  return true;
}
