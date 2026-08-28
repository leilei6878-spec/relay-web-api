import { accountHasLeonardoModel } from "./provider/leonardo-models";
import type { Account, GatewaySettings, Platform, Proxy } from "./types";

export function isLocked(account: Account, now = Date.now()) {
  if (!account.lockedUntil) return false;
  return new Date(account.lockedUntil).getTime() > now;
}

export function proxyOf(account: Account, proxies: Proxy[]) {
  if (!account.proxyId) return null;
  return proxies.find((p) => p.id === account.proxyId) ?? null;
}

export function eligibilityReason(
  account: Account,
  proxies: Proxy[],
  settings: GatewaySettings,
  now = Date.now(),
  requestedModel?: string,
): string | null {
  if (account.status !== "healthy" && account.status !== "probing") return "状态不是健康";
  if (!account.sessionPath) return "没有 Session";
  if (isLocked(account, now)) return "账号占用中";
  if (settings.enforceProxy) {
    const p = proxyOf(account, proxies);
    if (!p) return "未绑定 sticky 代理";
    if (p.status !== "active") return "代理已停用";
  }
  if (account.tokenState === "TOKEN_EXHAUSTED") return "额度用尽";
  if (requestedModel && account.platform === "leonardo" && !accountHasLeonardoModel(account, requestedModel)) {
    return `模型不可用（${requestedModel}）`;
  }
  return null;
}

export function listEligible(
  accounts: Account[],
  proxies: Proxy[],
  settings: GatewaySettings,
  platform: Platform,
  excludeIds: string[] = [],
  now = Date.now(),
  requestedModel?: string,
) {
  const usedAt = (value: unknown) => {
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(typeof value === "string" ? value : "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return accounts
    .filter(
      (a) =>
        a.platform === platform &&
        !excludeIds.includes(a.id) &&
        !eligibilityReason(a, proxies, settings, now, requestedModel),
    )
    .sort((a, b) => usedAt(a.lastUsedAt) - usedAt(b.lastUsedAt));
}

export function proxyCapacity(proxy: Proxy, accounts: Account[]) {
  return accounts.filter((a) => a.proxyId === proxy.id).length;
}

export function poolUnavailableMessage(
  platform: Platform,
  accounts: Account[],
  proxies: Proxy[],
  settings: GatewaySettings,
  extra: Record<string, string> = {},
  requestedModel?: string,
) {
  const label = platform === "gemini" ? "Gemini" : platform === "leonardo" ? "Leonardo" : "ChatGPT";
  const mine = accounts.filter((a) => a.platform === platform);
  if (!mine.length) {
    return `没有可调度的健康 ${label} 账号：账号池是空的，请先添加并完成登录`;
  }
  const lines = mine.map((a) => {
    const why = extra[a.id] || eligibilityReason(a, proxies, settings, Date.now(), requestedModel) || "可调度";
    return `${a.email}（${why}）`;
  });
  return `没有可调度的健康 ${label} 账号。当前：${lines.join("；")}`;
}

export const defaultSelectors = {
  chatgpt: {
    input: ["textarea#prompt-textarea", "div[contenteditable='true']#prompt-textarea"],
    send: ["button[data-testid='send-button']", "button[aria-label='Send prompt']"],
    assistant: ["div[data-message-author-role='assistant']"],
    streamingStop: ["button[aria-label='Stop streaming']", "button[data-testid='stop-button']"],
  },
  gemini: {
    input: ["div.ql-editor", "rich-textarea", "div[contenteditable='true']"],
    send: ["button[aria-label*='Send']"],
    assistant: ["model-response"],
    streamingStop: ["button[aria-label*='Stop']"],
  },
  leonardo: {
    input: ["#home-prompt-textarea", "textarea[placeholder*='prompt' i]"],
    send: ['button[aria-label="Generate"]'],
    assistant: [],
    streamingStop: [],
  },
};
