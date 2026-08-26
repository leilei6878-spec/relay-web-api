import { Badge } from "@/components/ui/badge";
import type { AccountStatus, LogStatus, ProxyStatus } from "@/lib/types";

const accountMap: Record<AccountStatus, { label: string; tone: "ok" | "warn" | "danger" | "info" | "default" }> = {
  healthy: { label: "健康", tone: "ok" },
  pending_login: { label: "待登录", tone: "info" },
  cooling: { label: "冷却", tone: "warn" },
  probing: { label: "探活", tone: "info" },
  invalid: { label: "失效", tone: "danger" },
  banned: { label: "封禁", tone: "danger" },
};

const proxyMap: Record<ProxyStatus, { label: string; tone: "ok" | "default" }> = {
  active: { label: "启用", tone: "ok" },
  disabled: { label: "停用", tone: "default" },
};

const logMap: Record<LogStatus, { label: string; tone: "ok" | "warn" | "danger" }> = {
  success: { label: "成功", tone: "ok" },
  switched: { label: "已切换", tone: "warn" },
  fail: { label: "失败", tone: "danger" },
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const m = accountMap[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function ProxyStatusBadge({ status }: { status: ProxyStatus }) {
  const m = proxyMap[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function LogStatusBadge({ status }: { status: LogStatus }) {
  const m = logMap[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function PlatformBadge({ platform }: { platform: "chatgpt" | "gemini" | "leonardo" }) {
  const label = platform === "chatgpt" ? "ChatGPT" : platform === "gemini" ? "Gemini" : "Leonardo";
  const tone = platform === "chatgpt" ? "info" : platform === "gemini" ? "accent" : "warn";
  return <Badge tone={tone}>{label}</Badge>;
}
