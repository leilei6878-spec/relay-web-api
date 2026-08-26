#!/usr/bin/env node
/**
 * JSON → PostgreSQL import. Production scheduling never reads JSON;
 * this tool is the supported migration path.
 *
 *   node scripts/migrate-json.mjs --dry-run
 *   node scripts/migrate-json.mjs --apply
 */
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || !args.has("--apply");
const planePath = resolve(process.env.RELAY_PLANE || "storage/control-plane.json");
const keysPath = resolve(process.env.RELAY_KEYS || "storage/api-keys.json");
const jobsPath = resolve("storage/jobs.json");

async function loadJson(path) {
  try {
    await access(path);
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function count(label, n) {
  return `${label}: ${n}`;
}

function hashApiKey(token) {
  return createHash("sha256").update(token).digest("hex");
}

function hint(key) {
  const s = String(key || "");
  if (s.length < 8) return "****";
  return `${s.slice(0, 10)}…${s.slice(-4)}`;
}

async function main() {
  const plane = (await loadJson(planePath)) || { accounts: [], proxies: [], settings: {} };
  const keysDoc = (await loadJson(keysPath)) || { keys: [] };
  const jobsDoc = (await loadJson(jobsPath)) || { jobs: [] };
  const accounts = plane.accounts || [];
  const proxies = plane.proxies || [];
  const keys = keysDoc.keys || (keysDoc.apiKey ? [{ id: "default", key: keysDoc.apiKey }] : []);
  const jobs = jobsDoc.jobs || (Array.isArray(jobsDoc) ? jobsDoc : []);

  console.log("JSON import plan");
  console.log(count("accounts", accounts.length));
  console.log(count("proxies", proxies.length));
  console.log(count("api_keys", keys.length));
  console.log(count("jobs", jobs.length));
  console.log(`source plane: ${planePath}`);
  console.log(`mode: ${dryRun ? "dry-run (no writes)" : "apply"}`);

  if (dryRun) {
    console.log("dry-run complete — pass --apply to write into PostgreSQL");
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required for --apply");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const a of accounts) {
      const extra = { ...a };
      await client.query(
        `insert into relay_accounts (id, platform, email, remark, status, proxy_id, session_path, session_version, fail_count, total_requests,
           last_used_at, locked_until, last_error, last_probe_at, session_warning, created_at, extra)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
         on conflict (id) do update set
           status=excluded.status, proxy_id=excluded.proxy_id, session_path=excluded.session_path,
           last_error=excluded.last_error, extra=excluded.extra`,
        [
          a.id,
          a.platform,
          a.email,
          a.remark || "",
          a.status,
          a.proxyId || null,
          a.sessionPath || null,
          a.sessionVersion || 0,
          a.failCount || 0,
          a.totalRequests || 0,
          a.lastUsedAt || null,
          a.lockedUntil || null,
          a.lastError || null,
          a.lastProbeAt || null,
          a.sessionWarning || null,
          a.createdAt || new Date().toISOString(),
          JSON.stringify(extra),
        ],
      );
    }
    for (const p of proxies) {
      const extra = { ...p };
      delete extra.password;
      await client.query(
        `insert into relay_proxies (id, name, type, host, port, username, sticky_session_id, region, status, max_accounts, remark, created_at, extra)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
         on conflict (id) do update set host=excluded.host, port=excluded.port, status=excluded.status, extra=excluded.extra`,
        [
          p.id,
          p.name,
          p.type,
          p.host,
          p.port,
          p.username || "",
          p.stickySessionId || "",
          p.region || "",
          p.status || "active",
          p.maxAccounts || 8,
          p.remark || "",
          p.createdAt || new Date().toISOString(),
          JSON.stringify(extra),
        ],
      );
    }
    if (plane.settings) {
      await client.query(
        `insert into relay_settings (id, body) values ('default', $1::jsonb)
         on conflict (id) do update set body=excluded.body`,
        [JSON.stringify({ settings: plane.settings, savedAt: plane.savedAt || new Date().toISOString() })],
      );
    }
    for (const k of keys) {
      const token = k.key || "";
      if (!token) continue;
      await client.query(
        `insert into relay_api_keys (id, name, key_hash, key_hint, enabled, scopes, daily_limit, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (id) do update set
           name=excluded.name, key_hash=excluded.key_hash, key_hint=excluded.key_hint,
           enabled=excluded.enabled, scopes=excluded.scopes, daily_limit=excluded.daily_limit`,
        [
          k.id,
          k.name || "",
          hashApiKey(token),
          hint(token),
          k.enabled !== false,
          (k.scopes || ["chat", "image"]).join(","),
          k.dailyLimit || 0,
          k.createdAt || new Date().toISOString(),
        ],
      );
    }
    await client.query("COMMIT");
    console.log("apply complete");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
