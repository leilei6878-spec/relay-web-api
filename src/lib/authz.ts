import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getRequest } from "@tanstack/react-start/server";
import { findApiKey, type ApiKeyRecord } from "./api-keys";
import { findTenantApiKey } from "./saas-api-keys";
import type { CommercialApiKey } from "./commercial-types";

const DIR = resolve("storage");
export const ADMIN_COOKIE = "relay_admin";

export type Principal =
  | { kind: "admin"; token: string }
  | { kind: "customer"; token: string; record: ApiKeyRecord }
  | { kind: "commercial"; token: string; record: CommercialApiKey }
  | { kind: "worker"; token: string };

function mint(prefix: string) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function ensureAdminToken() {
  if (process.env.RELAY_ADMIN_TOKEN?.trim()) return process.env.RELAY_ADMIN_TOKEN.trim();
  if (process.env.NODE_ENV === "production") {
    throw new Error("PRODUCTION_FAIL_CLOSED: RELAY_ADMIN_TOKEN required; file mint is forbidden");
  }
  await mkdir(DIR, { recursive: true });
  const file = resolve(DIR, "admin-token.txt");
  try {
    const token = (await readFile(file, "utf8")).trim();
    if (token.startsWith("ad-relay-") && token.length >= 24) return token;
  } catch {
    /* create */
  }
  const token = mint("ad-relay-");
  await writeFile(file, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

export async function ensureWorkerToken() {
  if (process.env.RELAY_WORKER_TOKEN?.trim()) return process.env.RELAY_WORKER_TOKEN.trim();
  if (process.env.NODE_ENV === "production") {
    throw new Error("PRODUCTION_FAIL_CLOSED: RELAY_WORKER_TOKEN required; worker secret infrastructure incomplete");
  }
  await mkdir(DIR, { recursive: true });
  const file = resolve(DIR, "worker-token.txt");
  try {
    const token = (await readFile(file, "utf8")).trim();
    if (token.startsWith("wk-relay-") && token.length >= 24) return token;
  } catch {
    /* create */
  }
  const token = mint("wk-relay-");
  await writeFile(file, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

export function bearerToken(request: Request) {
  const header =
    request.headers.get("authorization") ||
    request.headers.get("x-api-key") ||
    request.headers.get("x-goog-api-key") ||
    "";
  const m = header.match(/^Bearer(?:\s+(.*))?$/i);
  let token = (m ? m[1] || "" : header).trim();
  if (!token) {
    try {
      token = new URL(request.url).searchParams.get("key") || "";
    } catch {
      token = "";
    }
  }
  return token.trim();
}

export function readCookie(request: Request, name: string) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function adminCookieHeader(token: string, secure = false) {
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Max-Age=86400",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Automatic admin login is a local-development convenience only.
 *
 * Production must always require the configured admin credential, even when
 * RELAY_REQUIRE_ADMIN_LOGIN is missing or explicitly set to a falsey value.
 * This keeps a compose/env regression from turning a public GET request into
 * an administrator session.
 */
export function allowAutomaticAdminLogin(
  env: { NODE_ENV?: string; RELAY_REQUIRE_ADMIN_LOGIN?: string } = process.env,
) {
  return env.NODE_ENV !== "production" && env.RELAY_REQUIRE_ADMIN_LOGIN !== "1";
}

export async function classify(request: Request): Promise<Principal | null> {
  const bearer = bearerToken(request);
  const cookie = readCookie(request, ADMIN_COOKIE);
  const admin = await ensureAdminToken();
  const worker = await ensureWorkerToken();
  // Authorization header always wins. Same-origin admin cookie must not
  // shadow a customer API key (the in-app API tester used to 401 this way).
  if (bearer) {
    if (bearer === admin) return { kind: "admin", token: bearer };
    if (bearer === worker) return { kind: "worker", token: bearer };
    if (bearer.startsWith("sk-saas-")) {
      const commercial = await findTenantApiKey(bearer);
      if (commercial?.enabled) return { kind: "commercial", token: bearer, record: commercial };
      return null;
    }
    const rec = await findApiKey(bearer);
    if (rec?.enabled && rec.key.startsWith("sk-relay-")) {
      return { kind: "customer", token: bearer, record: rec };
    }
    return null;
  }
  if (cookie && cookie === admin) return { kind: "admin", token: cookie };
  return null;
}

export async function assertAdmin(request: Request) {
  const p = await classify(request);
  if (!p || p.kind !== "admin") return { ok: false as const, status: 401, error: "需要管理员凭证" };
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
  const browserCookieAuth = !bearerToken(request) && Boolean(readCookie(request, ADMIN_COOKIE));
  if (unsafe && browserCookieAuth && !trustedMutationOrigin(request)) {
    return { ok: false as const, status: 403, error: "管理请求来源校验失败" };
  }
  return { ok: true as const, principal: p };
}

export function trustedMutationOrigin(request: Request) {
  const origin = request.headers.get("origin") || "";
  if (!origin) return false;
  const configured = (process.env.RELAY_PUBLIC_URL || "").trim().replace(/\/$/, "");
  const proto = (request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "")).split(",")[0]!.trim();
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host).split(",")[0]!.trim();
  const expected = `${proto}://${host}`;
  if (origin === expected || (configured && origin === configured)) return true;
  if (process.env.NODE_ENV !== "production") {
    return ["http://localhost:8080", "http://127.0.0.1:8080"].includes(origin);
  }
  return false;
}

export async function assertCustomer(request: Request, scope?: "chat" | "image") {
  const p = await classify(request);
  if (!p || p.kind !== "customer") return { ok: false as const, status: 401, error: "无效的 API Key" };
  if (scope && p.record.scopes.length && !p.record.scopes.includes(scope)) {
    return { ok: false as const, status: 403, error: "此 Key 没有该接口权限" };
  }
  return { ok: true as const, principal: p, record: p.record, key: p.record.key };
}

export async function assertApiClient(request: Request, scope?: "chat" | "image") {
  const p = await classify(request);
  if (!p || (p.kind !== "customer" && p.kind !== "commercial")) {
    return { ok: false as const, status: 401, error: "无效的 API Key" };
  }
  if (scope && p.record.scopes.length && !p.record.scopes.includes(scope)) {
    return { ok: false as const, status: 403, error: "此 Key 没有该接口权限" };
  }
  return { ok: true as const, principal: p, record: p.record, key: p.token, commercial: p.kind === "commercial" };
}

export async function assertWorker(request: Request) {
  const p = await classify(request);
  if (!p || p.kind !== "worker") return { ok: false as const, status: 401, error: "无效的执行器凭证" };
  return { ok: true as const, principal: p };
}

export async function assertAdminFromFn() {
  try {
    const req = getRequest();
    if (!req) return { ok: false as const, status: 401, error: "需要管理员凭证" };
    return assertAdmin(req);
  } catch {
    return { ok: false as const, status: 401, error: "需要管理员凭证" };
  }
}
