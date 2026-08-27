import { coordBackend } from "./coord";
import { dbSource } from "./db";
import { isProduction, mockModeEnabled, readEnv } from "./env-mode";
import { objectStoreConfigured } from "./media-store";
import { persistenceMode } from "./persist-mode";
import { runProductionReadinessCheck, type CheckId, type CheckItem, type CheckStatus } from "./production-guard";
import { releaseIdentity } from "./release";

export type LiveReadiness = {
  production: boolean;
  ready: boolean;
  mockForbidden: boolean;
  blockers: string[];
  items: CheckItem[];
  backend: {
    db: string;
    persist: string;
    coord: string;
    media: string;
  };
  live: Record<CheckId, { ok: boolean; detail: string }>;
};

async function pingDatabase(): Promise<{ ok: boolean; detail: string }> {
  const http = readEnv("RELAY_SQL_HTTP_URL");
  const url = readEnv("DATABASE_URL");
  if (!url && !http) {
    return { ok: !isProduction(), detail: isProduction() ? "DATABASE_URL missing" : "PGLite / SQL HTTP unset" };
  }
  try {
    const { getSql } = await import("./db");
    const sql = await getSql();
    const rows = await sql.query<{ ok: number }>("select 1::int as ok");
    const mig = await sql.query<{ name: string }>("select name from _migrations").catch(() => [] as { name: string }[]);
    return {
      ok: rows[0]?.ok === 1,
      detail: `select 1 ok; migrations=${mig.length}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "db ping failed" };
  }
}

async function pingRedis(): Promise<{ ok: boolean; detail: string }> {
  const url = readEnv("REDIS_URL");
  if (!url) {
    return { ok: !isProduction(), detail: isProduction() ? "REDIS_URL missing" : "memory coord" };
  }
  try {
    const { coordSetNx, coordDel, coordBackend: backend } = await import("./coord");
    const key = `ready:${Date.now()}`;
    const won = await coordSetNx(key, "1", 2000);
    await coordDel(key);
    return { ok: won && backend() === "redis", detail: `PING via SET NX (${backend()})` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "redis ping failed" };
  }
}

function overlay(item: CheckItem, live: { ok: boolean; detail: string }): CheckItem {
  if (live.ok) return { ...item, status: "ok" as CheckStatus, detail: live.detail || item.detail };
  if (!item.required) return { ...item, status: item.status === "ok" ? "degraded" : item.status, detail: live.detail };
  return { ...item, status: "missing", detail: live.detail };
}

export async function runLiveReadinessCheck(): Promise<LiveReadiness> {
  const base = runProductionReadinessCheck();
  const release = releaseIdentity();
  const db = await pingDatabase();
  const redis = await pingRedis();
  const live: LiveReadiness["live"] = {
    database: db,
    redis,
    secret_store: {
      ok: Boolean(readEnv("RELAY_ADMIN_TOKEN") && readEnv("RELAY_WORKER_TOKEN") && (!isProduction() || readEnv("RELAY_SECRETS_KEY"))),
      detail: isProduction() ? "env tokens + encryption key" : "dev mint allowed",
    },
    encryption_key: {
      ok: Boolean(readEnv("RELAY_SECRETS_KEY")) || !isProduction(),
      detail: readEnv("RELAY_SECRETS_KEY") ? "RELAY_SECRETS_KEY set" : "unset",
    },
    media_store: {
      ok: objectStoreConfigured() || !isProduction(),
      detail: objectStoreConfigured() ? "object store configured" : "local media (non-production)",
    },
    worker: {
      ok: Boolean(readEnv("RELAY_WORKER_TOKEN")) || !isProduction(),
      detail: readEnv("RELAY_WORKER_TOKEN") ? "worker token set" : "dev mint",
    },
    migrations: db,
    admin_auth: {
      ok: Boolean(readEnv("RELAY_ADMIN_TOKEN")) || !isProduction(),
      detail: readEnv("RELAY_ADMIN_TOKEN") ? "admin token set" : "dev mint",
    },
    provider_config: {
      ok: !mockModeEnabled() || !isProduction(),
      detail: mockModeEnabled() ? "mock mode" : "ChatGPT + Gemini enabled",
    },
    release_identity: {
      ok: release.commit !== "unknown" || !isProduction(),
      detail: release.commit === "unknown" ? "release commit unknown" : `commit ${release.commit}`,
    },
  };

  const items = base.items.map((it) => {
    const l = live[it.id];
    if (!l) return it;
    if (it.id === "database" || it.id === "redis" || it.id === "migrations") return overlay(it, l);
    return it;
  });

  const blockers = items.filter((i) => i.required && i.status !== "ok").map((i) => `${i.id}: ${i.detail}`);
  return {
    production: base.production,
    ready: blockers.length === 0,
    mockForbidden: base.mockForbidden,
    blockers,
    items,
    backend: {
      db: dbSource,
      persist: persistenceMode(),
      coord: coordBackend(),
      media: objectStoreConfigured() ? "object" : "local",
    },
    live,
  };
}
