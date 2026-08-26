#!/usr/bin/env node
/**
 * JSON → PostgreSQL import. Production scheduling never reads JSON;
 * this tool is the supported migration path.
 *
 *   node scripts/migrate-json.mjs --dry-run
 *   node scripts/migrate-json.mjs --apply
 */
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || !args.has("--apply");
const planePath = resolve(process.env.RELAY_PLANE || "storage/control-plane.json");
const keysPath = resolve("storage/api-keys.json");
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
      await client.query(
        `insert into relay_accounts (id, platform, email, remark, status, proxy_id, session_path, fail_count, total_requests, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (id) do update set status=excluded.status, proxy_id=excluded.proxy_id, session_path=excluded.session_path`,
        [
          a.id,
          a.platform,
          a.email,
          a.remark || "",
          a.status,
          a.proxyId || null,
          a.sessionPath || null,
          a.failCount || 0,
          a.totalRequests || 0,
          a.createdAt || new Date().toISOString(),
        ],
      );
    }
    for (const p of proxies) {
      await client.query(
        `insert into relay_proxies (id, name, type, host, port, username, status, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (id) do update set host=excluded.host, port=excluded.port, status=excluded.status`,
        [p.id, p.name, p.type, p.host, p.port, p.username || "", p.status || "active", p.createdAt || new Date().toISOString()],
      );
    }
    if (plane.settings) {
      await client.query(
        `insert into relay_settings (id, body) values ('default', $1::jsonb)
         on conflict (id) do update set body=excluded.body`,
        [JSON.stringify(plane.settings)],
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
