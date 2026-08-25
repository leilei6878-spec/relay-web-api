import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Platform } from "./types";

export async function probeSessionFile(accountId: string, platform: Platform) {
  const id = accountId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return { ok: false as const, reason: "账号无效" };
  let json: string;
  try {
    json = await readFile(resolve("storage/sessions", `${id}.json`), "utf8");
  } catch {
    return { ok: false as const, reason: "没有登录文件" };
  }
  return inspectSession(json, platform);
}

export function inspectSession(json: string, platform: Platform) {
  try {
    const parsed = JSON.parse(json) as { cookies?: { name?: string; expires?: number; value?: string }[] };
    const cookies = parsed.cookies || [];
    if (!cookies.length) return { ok: false as const, reason: "Cookie 为空" };
    const now = Date.now() / 1000;
    const names = new Set(cookies.map((c) => c.name || ""));
    const dummy = cookies.length <= 1 && cookies.some((c) => (c.value || "").includes("qa"));
    if (dummy) return { ok: false as const, reason: "演示登录不能商用" };
    if (platform === "chatgpt") {
      const has =
        names.has("__Secure-next-auth.session-token") ||
        names.has("oai-did") ||
        names.has("__Secure-next-auth.session-token.0");
      if (!has) return { ok: false as const, reason: "缺少 ChatGPT 登录 Cookie" };
    }
    if (platform === "gemini") {
      const has = names.has("SID") || names.has("__Secure-1PSID") || names.has("__Secure-1PSIDTS");
      if (!has && cookies.length < 8) return { ok: false as const, reason: "缺少 Gemini 登录 Cookie" };
    }
    const sessionCookies = cookies.filter((c) => /session|SID|PSID|auth|oai-did/i.test(c.name || ""));
    const expiries = sessionCookies
      .map((c) => (typeof c.expires === "number" && c.expires > 0 ? c.expires : 0))
      .filter((n) => n > now);
    const expiresAt = expiries.length ? Math.min(...expiries) : 0;
    const stale = sessionCookies.filter(
      (c) => typeof c.expires === "number" && c.expires > 0 && c.expires < now,
    );
    if (stale.length) return { ok: false as const, reason: "登录 Cookie 已过期" };
    const hoursLeft = expiresAt ? (expiresAt - now) / 3600 : 0;
    const warning = hoursLeft > 0 && hoursLeft < 48 ? `登录约 ${Math.max(1, Math.round(hoursLeft))} 小时后过期` : undefined;
    return { ok: true as const, cookieCount: cookies.length, warning, expiresAt: expiresAt || undefined };
  } catch {
    return { ok: false as const, reason: "登录文件无法解析" };
  }
}
