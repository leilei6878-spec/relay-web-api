import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getRequest } from "@tanstack/react-start/server";
import { findApiKey, type ApiKeyRecord } from "./api-keys";

const DIR = resolve("storage");
export const ADMIN_COOKIE = "relay_admin";

export type Principal =
  | { kind: "admin"; token: string }
  | { kind: "customer"; token: string; record: ApiKeyRecord }
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
  const header = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return (m ? m[1] : header).trim();
}

export function readCookie(request: Request, name: string) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function adminCookieHeader(token: string) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
}

export async function classify(request: Request): Promise<Principal | null> {
  const bearer = bearerToken(request);
  const cookie = readCookie(request, ADMIN_COOKIE);
  const admin = await ensureAdminToken();
  const worker = await ensureWorkerToken();
  if (bearer && bearer === admin) return { kind: "admin", token: bearer };
  if (cookie && cookie === admin) return { kind: "admin", token: cookie };
  if (bearer && bearer === worker) return { kind: "worker", token: bearer };
  if (bearer) {
    const rec = await findApiKey(bearer);
    if (rec?.enabled && rec.key.startsWith("sk-relay-")) return { kind: "customer", token: bearer, record: rec };
  }
  return null;
}

export async function assertAdmin(request: Request) {
  const p = await classify(request);
  if (!p || p.kind !== "admin") return { ok: false as const, status: 401, error: "需要管理员凭证" };
  return { ok: true as const, principal: p };
}

export async function assertCustomer(request: Request, scope?: "chat" | "image") {
  const p = await classify(request);
  if (!p || p.kind !== "customer") return { ok: false as const, status: 401, error: "无效的 API Key" };
  if (scope && p.record.scopes.length && !p.record.scopes.includes(scope)) {
    return { ok: false as const, status: 403, error: "此 Key 没有该接口权限" };
  }
  return { ok: true as const, principal: p, record: p.record, key: p.record.key };
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
