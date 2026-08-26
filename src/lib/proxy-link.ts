import type { Proxy, ProxyType } from "./types";
import { nowIso, uid } from "./utils";

export type ParsedShareLink = Omit<Proxy, "id" | "createdAt">;

function stripNoise(raw: string) {
  const t = raw.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "").trim();
  const hashAt = t.search(/#/);
  if (hashAt >= 0) return t.slice(0, hashAt).replace(/\s+/g, "") + t.slice(hashAt);
  return t.replace(/\s+/g, "");
}

function b64(s: string) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return atob(pad);
}

function tryB64(s: string) {
  try {
    if (!s) return null;
    return b64(s);
  } catch {
    return null;
  }
}

function parseHostPort(hp: string): { host: string; port: number } {
  let s = (hp || "").replace(/^\/+/, "");
  s = s.split("/")[0]?.split("?")[0] || "";
  const v6 = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6) return { host: v6[1]!, port: Number(v6[2]) };
  const idx = s.lastIndexOf(":");
  if (idx <= 0) return { host: "", port: 0 };
  const host = s.slice(0, idx).replace(/^\[|\]$/g, "");
  const port = Number(s.slice(idx + 1));
  return { host, port: Number.isFinite(port) && port > 0 ? port : 0 };
}

function splitMethodPassword(user: string): { method: string; password: string } {
  const idx = user.indexOf(":");
  if (idx <= 0) return { method: "", password: "" };
  return { method: user.slice(0, idx).trim(), password: user.slice(idx + 1) };
}

function decodeUserInfo(user: string): { method: string; password: string } {
  const decoded = tryB64(user);
  if (decoded && decoded.includes(":")) return splitMethodPassword(decoded);
  try {
    const pct = decodeURIComponent(user);
    if (pct.includes(":")) return splitMethodPassword(pct);
  } catch {
    /* keep */
  }
  return splitMethodPassword(user);
}

export function parseShareLink(raw: string): { ok: true; data: ParsedShareLink } | { ok: false; error: string } {
  const text = stripNoise(raw);
  if (!text) return { ok: false, error: "请粘贴分享链接" };
  if (!/^ss:\/\//i.test(text)) return { ok: false, error: "目前支持 ss:// 分享链接（从 v2rayN / sing-box 复制整行）" };

  try {
    const hashRaw = text.includes("#") ? text.slice(text.indexOf("#") + 1) : "";
    let hash = "SS 节点";
    if (hashRaw) {
      try {
        hash = decodeURIComponent(hashRaw);
      } catch {
        hash = hashRaw;
      }
    }
    const main = text.replace(/^ss:\/\//i, "").split("#")[0] || "";

    let method = "";
    let password = "";
    let host = "";
    let port = 0;

    if (main.includes("@")) {
      const at = main.lastIndexOf("@");
      const mp = decodeUserInfo(main.slice(0, at));
      method = mp.method;
      password = mp.password;
      ({ host, port } = parseHostPort(main.slice(at + 1)));
    } else {
      const decoded = tryB64(main);
      if (decoded && decoded.includes("@")) {
        const at = decoded.lastIndexOf("@");
        const mp = splitMethodPassword(decoded.slice(0, at));
        method = mp.method;
        password = mp.password;
        ({ host, port } = parseHostPort(decoded.slice(at + 1)));
      } else if (decoded && decoded.includes(":")) {
        return {
          ok: false,
          error: "ss 链接缺少主机或端口。当前只贴到了方法和密码，没有 @IP:端口。请从 v2rayN 复制整条分享链接。",
        };
      }
    }

    if (!method) {
      return {
        ok: false,
        error: "ss 链接缺少加密方法。请粘贴整行，格式：ss://方法:密码@主机:端口#备注",
      };
    }
    if (!host || !port) {
      return {
        ok: false,
        error: "ss 链接缺少主机或端口。单行输入框容易只贴上前半段，请确认包含 @IP:端口，例如 …@1.2.3.4:8443#名称",
      };
    }
    method = ssMethodForKey(method, password);
    return {
      ok: true,
      data: {
        name: hash || `${host}:${port}`,
        type: "ss",
        host,
        port,
        username: "",
        password,
        method,
        stickySessionId: `ss-${host}-${port}`,
        region: /japan|jp|tokyo|日本/i.test(hash) ? "JP" : "",
        status: "active",
        maxAccounts: 8,
        remark: "Shadowsocks · 网页 Worker 走本机 SOCKS",
        localPort: 10808,
      },
    };
  } catch {
    return { ok: false, error: "ss 链接无法解析" };
  }
}

function ssMethodForKey(advertised: string, password: string) {
  try {
    const bin = Uint8Array.from(atob(password.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    if (bin.length >= 32 && advertised.includes("128")) return "2022-blake3-aes-256-gcm";
    if (bin.length === 16) return "2022-blake3-aes-128-gcm";
  } catch {
    /* keep advertised */
  }
  return advertised;
}

export function singBoxConfig(proxy: Pick<Proxy, "host" | "port" | "password" | "method" | "localPort" | "name">) {
  return {
    log: { level: "warn" },
    inbounds: [
      {
        type: "socks",
        tag: "socks-in",
        listen: "127.0.0.1",
        listen_port: proxy.localPort || 10808,
      },
    ],
    outbounds: [
      {
        type: "shadowsocks",
        tag: proxy.name || "ss",
        server: proxy.host,
        server_port: proxy.port,
        method: proxy.method || "2022-blake3-aes-256-gcm",
        password: proxy.password || "",
      },
    ],
  };
}

export function newProxyFromLink(data: ParsedShareLink): Proxy {
  return { ...data, id: uid(), createdAt: nowIso() };
}

export function isSs(type: ProxyType) {
  return type === "ss";
}
