import { createFileRoute } from "@tanstack/react-router";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { adminCookieHeader, assertAdmin, ensureAdminToken } from "@/lib/authz";
import { readControlPlane } from "@/lib/control-plane";
import { getSecret, proxySecretKey } from "@/lib/secrets";
import { loginPackTextFiles, safeName } from "@/lib/session-file";
import { zipStore } from "@/lib/zip-store";

async function singBoxExe() {
  const paths = [
    resolve("public/login-kit/windows/sing-box.exe"),
    resolve("login-kit/windows/sing-box.exe"),
    resolve("/app/public/login-kit/windows/sing-box.exe"),
  ];
  for (const path of paths) {
    try {
      return await readFile(path);
    } catch {
      /* next */
    }
  }
  return null;
}

async function ensureAdmin(request: Request) {
  const auth = await assertAdmin(request);
  if (auth.ok) return { ok: true as const, setCookie: "" };
  if (process.env.RELAY_REQUIRE_ADMIN_LOGIN === "1") {
    return { ok: false as const, error: auth.error };
  }
  const token = await ensureAdminToken();
  const https = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return { ok: true as const, setCookie: adminCookieHeader(token, https) };
}

async function buildPack(request: Request) {
  const auth = await ensureAdmin(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
  let accountId = "";
  let proxyPassword = "";
  if (request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { accountId?: string; proxyPassword?: string };
    accountId = body.accountId || "";
    proxyPassword = body.proxyPassword || "";
  } else {
    accountId = new URL(request.url).searchParams.get("accountId") || "";
  }
  if (!accountId) return Response.json({ error: "缺少账号" }, { status: 400 });
  const plane = await readControlPlane();
  const account = plane.accounts.find((a) => a.id === accountId);
  if (!account) return Response.json({ error: "账号不存在" }, { status: 404 });
  const proxy = plane.proxies.find((p) => p.id === account.proxyId);
  if (!proxy) return Response.json({ error: "先绑定 sticky 代理" }, { status: 400 });
  const stored = await getSecret(proxySecretKey(proxy.id));
  const password = proxyPassword.trim() || stored || proxy.password || "";
  if (proxy.type !== "ss" && proxy.username && !password) {
    return Response.json({ error: "填写代理密码后再下载" }, { status: 400 });
  }
  const files = loginPackTextFiles(account, proxy, password);
  if (proxy.type === "ss") {
    const exe = await singBoxExe();
    if (!exe) return Response.json({ error: "登录组件缺失，请刷新后重试" }, { status: 500 });
    files.push({ name: "sing-box.exe", data: new Uint8Array(exe) });
  }
  const zip = zipStore(files);
  const buf = await zip.arrayBuffer();
  const headers: Record<string, string> = {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${safeName(account.email)}.zip"`,
    "Content-Length": String(buf.byteLength),
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  };
  if (auth.setCookie) headers["Set-Cookie"] = auth.setCookie;
  return new Response(buf, { headers });
}

export const Route = createFileRoute("/api/admin/login-pack")({
  server: {
    handlers: {
      GET: ({ request }) => buildPack(request),
      POST: ({ request }) => buildPack(request),
    },
  },
});
