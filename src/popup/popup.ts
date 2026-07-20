import { sendRequest } from "../shared/messages";
import type { Response, TabRow } from "../shared/messages";
import type { AudioState } from "../shared/tab-state";

const tabListEl = document.getElementById("tab-list") as HTMLUListElement;
const emptyStateEl = document.getElementById("empty-state") as HTMLParagraphElement;
const tabErrorEl = document.getElementById("tab-error") as HTMLParagraphElement;
const bulkMuteBtn = document.getElementById("bulk-mute-btn") as HTMLButtonElement;
const bulkUnmuteBtn = document.getElementById("bulk-unmute-btn") as HTMLButtonElement;
const bulkResultEl = document.getElementById("bulk-result") as HTMLParagraphElement;
const addHostForm = document.getElementById("add-host-form") as HTMLFormElement;
const hostInput = document.getElementById("host-input") as HTMLInputElement;
const hostListEl = document.getElementById("host-list") as HTMLUListElement;
const hostErrorEl = document.getElementById("host-error") as HTMLParagraphElement;

const STATE_LABELS: Record<AudioState, string> = {
  audible: "再生中",
  "audible-muted": "再生中（ミュート）",
  "silent-muted": "ミュート（無音）",
  none: "",
};

const SAVE_ERROR_LABELS: Record<string, string> = {
  "quota-exceeded": "保存容量を超えたため追加できません。",
  "invalid-host": "ホスト名の形式が正しくありません（例: example.com）。",
  unknown: "保存に失敗しました。",
};
const DEFAULT_SAVE_ERROR_LABEL = "保存に失敗しました。";

/** 一時的な多重操作（二重クリック等）を防ぐためのフラグ。 */
let operationInFlight = false;

/**
 * chrome.runtime.sendMessage自体の失敗（メッセージポートが応答前に
 * 閉じられた等）を捕捉し、呼び出し元に必ず結果を返す。
 * これがないと、通信失敗時にボタン操作後の無反応になる
 * （実装レビューで発見されたminor）。
 */
async function sendRequestSafely(
  request: Parameters<typeof sendRequest>[0]
): Promise<Response | null> {
  try {
    return await sendRequest(request);
  } catch (error) {
    console.error("sendRequest failed", error);
    return null;
  }
}

async function refreshTabList(): Promise<void> {
  const response = await sendRequestSafely({ type: "GET_TAB_LIST" });
  if (response === null) {
    tabErrorEl.textContent = "タブ一覧の取得に失敗しました。もう一度開き直してください。";
    return;
  }
  if (response.type !== "TAB_LIST") return;
  tabErrorEl.textContent = "";
  renderTabList(response.tabs);
}

function renderTabList(tabs: TabRow[]): void {
  tabListEl.innerHTML = "";
  emptyStateEl.hidden = tabs.length > 0;

  for (const tab of tabs) {
    const li = document.createElement("li");

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || tab.host || "(無題のタブ)";
    li.appendChild(title);

    const state = document.createElement("span");
    state.className = "tab-state";
    state.textContent = STATE_LABELS[tab.state];
    li.appendChild(state);

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    const isMuted = tab.state === "audible-muted" || tab.state === "silent-muted";
    toggleBtn.textContent = isMuted ? "解除" : "ミュート";
    toggleBtn.setAttribute(
      "aria-label",
      `${tab.title || "このタブ"}を${isMuted ? "解除" : "ミュート"}`
    );

    if (tab.alwaysMuted) {
      toggleBtn.disabled = true;
      const reasonId = `always-muted-reason-${tab.tabId}`;
      toggleBtn.setAttribute("aria-describedby", reasonId);
      toggleBtn.title = "このサイトは常時ミュート対象です。解除するにはサイト規則を削除してください。";

      const reason = document.createElement("span");
      reason.id = reasonId;
      reason.hidden = true;
      reason.textContent = toggleBtn.title;
      li.appendChild(reason);
    } else {
      toggleBtn.addEventListener("click", () => void handleToggleTab(tab.tabId));
    }

    li.appendChild(toggleBtn);
    tabListEl.appendChild(li);
  }
}

async function handleToggleTab(tabId: number): Promise<void> {
  if (operationInFlight) return;
  operationInFlight = true;
  try {
    const response = await sendRequestSafely({ type: "TOGGLE_TAB_MUTE", tabId });
    if (response === null) {
      tabErrorEl.textContent = "操作に失敗しました。もう一度お試しください。";
    } else if (response.type === "TOGGLE_RESULT" && !response.ok) {
      tabErrorEl.textContent = "このタブは操作できませんでした。";
    } else {
      tabErrorEl.textContent = "";
    }
    await refreshTabList();
  } finally {
    operationInFlight = false;
  }
}

async function handleBulkMute(): Promise<void> {
  if (operationInFlight) return;
  operationInFlight = true;
  bulkMuteBtn.disabled = true;
  try {
    const response = await sendRequestSafely({ type: "BULK_MUTE" });
    if (response === null) {
      bulkResultEl.textContent = "一括ミュートに失敗しました。もう一度お試しください。";
    } else if (response.type === "BULK_RESULT") {
      bulkResultEl.textContent = `成功: ${response.result.successCount}件 / 失敗: ${response.result.failureCount}件`;
    }
    await refreshTabList();
  } finally {
    operationInFlight = false;
    bulkMuteBtn.disabled = false;
  }
}

async function handleBulkUnmute(): Promise<void> {
  if (operationInFlight) return;
  operationInFlight = true;
  bulkUnmuteBtn.disabled = true;
  try {
    const response = await sendRequestSafely({ type: "BULK_UNMUTE" });
    if (response === null) {
      bulkResultEl.textContent = "一括解除に失敗しました。もう一度お試しください。";
    } else if (response.type === "BULK_RESULT") {
      bulkResultEl.textContent = `成功: ${response.result.successCount}件 / 失敗: ${response.result.failureCount}件`;
    }
    await refreshTabList();
  } finally {
    operationInFlight = false;
    bulkUnmuteBtn.disabled = false;
  }
}

async function refreshHostList(): Promise<void> {
  const response = await sendRequestSafely({ type: "GET_ALWAYS_MUTE_HOSTS" });
  if (response === null) {
    hostErrorEl.textContent = "サイト一覧の取得に失敗しました。";
    return;
  }
  if (response.type !== "ALWAYS_MUTE_HOSTS") return;
  renderHostList(response.hosts);
}

function renderHostList(hosts: string[]): void {
  hostListEl.innerHTML = "";
  for (const host of hosts) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = host;
    li.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "削除";
    removeBtn.setAttribute("aria-label", `${host}を常時ミュート規則から削除`);
    removeBtn.addEventListener("click", () => void handleRemoveHost(host));
    li.appendChild(removeBtn);

    hostListEl.appendChild(li);
  }
}

async function handleAddHost(host: string): Promise<void> {
  hostErrorEl.textContent = "";
  const response = await sendRequestSafely({ type: "ADD_ALWAYS_MUTE_HOST", host });
  if (response === null) {
    hostErrorEl.textContent = "通信に失敗しました。もう一度お試しください。";
    return;
  }
  if (response.type === "SAVE_RESULT" && !response.ok) {
    hostErrorEl.textContent =
      SAVE_ERROR_LABELS[response.error ?? "unknown"] ?? DEFAULT_SAVE_ERROR_LABEL;
    return;
  }
  hostInput.value = "";
  await refreshHostList();
  await refreshTabList();
}

async function handleRemoveHost(host: string): Promise<void> {
  const response = await sendRequestSafely({ type: "REMOVE_ALWAYS_MUTE_HOST", host });
  if (response === null || (response.type === "SAVE_RESULT" && !response.ok)) {
    hostErrorEl.textContent = "削除に失敗しました。もう一度お試しください。";
    return;
  }
  hostErrorEl.textContent = "";
  await refreshHostList();
  await refreshTabList();
}

bulkMuteBtn.addEventListener("click", () => void handleBulkMute());
bulkUnmuteBtn.addEventListener("click", () => void handleBulkUnmute());

addHostForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const host = hostInput.value.trim();
  if (host.length === 0) return;
  void handleAddHost(host);
});

const tabsUpdateListener = () => void refreshTabList();
chrome.tabs.onUpdated.addListener(tabsUpdateListener);
chrome.tabs.onRemoved.addListener(tabsUpdateListener);
window.addEventListener("unload", () => {
  chrome.tabs.onUpdated.removeListener(tabsUpdateListener);
  chrome.tabs.onRemoved.removeListener(tabsUpdateListener);
});

void refreshTabList();
void refreshHostList();
