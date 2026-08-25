import type { Proxy, ProxyType } from "./types";
import { nowIso, uid } from "./utils";

export type ParsedShareLink = Omit<Proxy, "id" | "createdAt">;

function b64(s: string) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return atob(pad);
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

export function parseShareLink(raw: string): { ok: true; data: ParsedShareLink } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: "请粘贴分享链接" };

  if (text.startsWith("ss://")) {
    try {
      const hash = text.includes("#") ? decodeURIComponent(text.slice(text.indexOf("#") + 1)) : "SS 节点";
      const main = text.slice("ss://".length).split("#")[0];
      let method = "";
      let password = "";
      let host = "";
      let port = 0;
      if (main.includes("@")) {
        const [user, hp] = main.split("@");
        const decoded = b64(user);
        const idx = decoded.indexOf(":");
        method = decoded.slice(0, idx);
        password = decoded.slice(idx + 1);
        const [h, p] = hp.split(":");
        host = h;
        port = Number(p);
      } else {
        const decoded = b64(main);
        const rest = decoded.replace(/^ss:\/\//, "");
        const [user, hp] = rest.split("@");
        const idx = user.indexOf(":");
        method = user.slice(0, idx);
        password = user.slice(idx + 1);
        const [h, p] = hp.split(":");
        host = h;
        port = Number(p);
      }
      if (!host || !port || !method) return { ok: false, error: "ss 链接不完整" };
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
          region: /japan|jp|tokyo/i.test(hash) ? "JP" : "",
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

  return { ok: false, error: "目前支持 ss:// 分享链接" };
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

export function japanSsProxy(): Proxy {
  const parsed = parseShareLink(
    "ss://MjAyMi1ibGFrZTMtYWVzLTEyOC1nY206SjNkN1JjTnBnV3hjMEMwWWp0MmdCdmUybFVLOTNaWTV1VGRLa2hoMTV0az0@38.175.201.137:8443#Japan-BGP-SS2022",
  );
  if (!parsed.ok) {
    return {
      id: "px-jp-ss2022",
      name: "Japan-BGP-SS2022",
      type: "ss",
      host: "38.175.201.137",
      port: 8443,
      username: "",
      stickySessionId: "japan-bgp-ss2022",
      region: "JP",
      status: "active",
      maxAccounts: 8,
      remark: "导入失败",
      createdAt: nowIso(),
    };
  }
  return {
    id: "px-jp-ss2022",
    createdAt: nowIso(),
    ...parsed.data,
    name: "Japan-BGP-SS2022",
    region: "JP",
    stickySessionId: "japan-bgp-ss2022",
  };
}

export function newProxyFromLink(data: ParsedShareLink): Proxy {
  return { ...data, id: uid(), createdAt: nowIso() };
}

export function isSs(type: ProxyType) {
  return type === "ss";
}
