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
): string | null {
  if (account.status !== "healthy") return "状态不是健康";
  if (!account.sessionPath) return "没有 Session";
  if (isLocked(account, now)) return "账号占用中";
  if (settings.enforceProxy) {
    const p = proxyOf(account, proxies);
    if (!p) return "未绑定 sticky 代理";
    if (p.status !== "active") return "代理已停用";
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
) {
  return accounts
    .filter(
      (a) =>
        a.platform === platform &&
        !excludeIds.includes(a.id) &&
        !eligibilityReason(a, proxies, settings, now),
    )
    .sort((a, b) => (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? ""));
}

export function proxyCapacity(proxy: Proxy, accounts: Account[]) {
  return accounts.filter((a) => a.proxyId === proxy.id).length;
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
};
