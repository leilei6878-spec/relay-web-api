import { eligibilityReason, listEligible } from "./eligibility";
import type { Account, GatewaySettings, Proxy } from "./types";

const REASON_ZH: Record<string, string> = {
  "状态不是健康": "账号还没登录或已下线",
  "没有 Session": "还没完成登录",
  "账号占用中": "正在处理上一条请求",
  "未绑定 sticky 代理": "还没绑定代理",
  "代理已停用": "绑定的代理已停用",
  "业务已过期": "账号业务期限已到",
  "登录态已过期": "登录态已过期，需要重新登录",
  "登录 IP 漂移": "登录 IP 与绑定代理不一致",
  "代理出口不可用": "绑定代理当前无法取得出口 IP",
};

export function whyBlocked(account: Account, proxies: Proxy[], settings: GatewaySettings) {
  const raw = eligibilityReason(account, proxies, settings);
  if (!raw) return null;
  if (account.status === "pending_login") return "还没登录";
  if (account.status === "banned") return "已封禁";
  if (account.status === "invalid") return "已失效，需要重新登录";
  return REASON_ZH[raw] ?? raw;
}

export function isCallable(account: Account, proxies: Proxy[], settings: GatewaySettings) {
  return !whyBlocked(account, proxies, settings);
}

export type NextStep = {
  id: string;
  title: string;
  detail: string;
  href: "/" | "/accounts" | "/proxies" | "/playground" | "/settings" | "/console";
  cta: string;
};

export function nextStep(input: {
  accounts: Account[];
  proxies: Proxy[];
  settings: GatewaySettings;
}): NextStep {
  const { accounts, proxies, settings } = input;
  const activeProxy = proxies.some((p) => p.status === "active");
  if (!activeProxy) {
    return {
      id: "proxy",
      title: "先加一条代理",
      detail: "登录和之后调用必须走同一出口，否则容易封号。",
      href: "/proxies",
      cta: "去添加代理",
    };
  }
  if (accounts.length === 0) {
    return {
      id: "account",
      title: "添加一个 ChatGPT 账号",
      detail: "填邮箱、绑刚才那条代理，再点登录。",
      href: "/accounts",
      cta: "去账号池",
    };
  }
  const gpt = listEligible(accounts, proxies, settings, "chatgpt");
  if (gpt.length === 0) {
    const pending = accounts.find((a) => a.platform === "chatgpt" && a.status === "pending_login");
    if (pending) {
      return {
        id: "login",
        title: "完成登录",
        detail: `${pending.email} 还差登录文件。点登录 → 下载登录包 → 把生成的文件拖回来。`,
        href: "/accounts",
        cta: "去登录",
      };
    }
    return {
      id: "bind",
      title: "让账号变成可调用",
      detail: "健康 + 已登录 + 已绑代理，三条齐了才能被 API 选中。",
      href: "/accounts",
      cta: "去账号池",
    };
  }
  return {
    id: "try",
    title: "用开放 API 测一条",
    detail: "打开 API 实时测试。执行器默认跑在服务器上，不必在自己电脑下载 Worker。",
    href: "/console",
    cta: "打开 API 测试",
  };
}
