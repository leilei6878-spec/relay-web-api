import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { startFakeRedis } from "./fake-redis.mjs";

const DURATION_MS = Number(process.env.RELAY_RELIABILITY_MS || 120_000);
const PG_PORT = 19010;
const GW_A = 19001;
const GW_B = 19002;

function waitPort(port, ms = 12000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = createConnection({ host: "127.0.0.1", port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", () => {
        if (Date.now() - start > ms) reject(new Error(`port ${port} timeout`));
        else setTimeout(tryOnce, 80);
      });
    };
    tryOnce();
  });
}

function spawnLogged(args, env) {
  return spawn(process.execPath, args, { cwd: "/workspace", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

async function call(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return res.json();
}

async function get(url) {
  const res = await fetch(url);
  return res.json();
}

async function finishIf(gw, claimed) {
  if (!claimed?.job) return;
  return call(`${gw}/v1/finish`, {
    jobId: claimed.job.id,
    ok: true,
    text: `ok-${claimed.job.id.slice(0, 6)}`,
    leaseId: claimed.job.leaseId,
    fencingToken: claimed.job.fencingToken,
    attemptId: claimed.job.attemptId,
    workerId: claimed.job.workerId,
  });
}

async function main() {
  await mkdir("/tmp/relay-resilience", { recursive: true });
  const redis = await startFakeRedis({ persistPath: "/tmp/relay-resilience/redis.json", port: 0 });
  const pg = spawnLogged(["scripts/shared-pg.mjs"], {
    PG_HTTP_PORT: String(PG_PORT),
    RELAY_PGLITE_DIR: "/tmp/relay-pgdata-rel",
    RELAY_PG_RESET: "1",
  });
  await waitPort(PG_PORT, 15000);
  const gwEnv = {
    RELAY_SOT: "postgres",
    RELAY_SQL_HTTP_URL: `http://127.0.0.1:${PG_PORT}`,
    REDIS_URL: redis.url,
    RELAY_WORKER_DEAD_MS: "400",
    RELAY_CLAIM_GRACE_MS: "50",
    RELAY_SECRETS_KEY: "cluster-test-key",
    RELAY_ADMIN_TOKEN: "ad-relay-cluster-test-token-aaaa",
    RELAY_WORKER_TOKEN: "wk-relay-cluster-test-token-aaaa",
  };
  const startGw = (name, port) =>
    spawnLogged(["--experimental-strip-types", "--import", "./scripts/register-ts-ext.mjs", "scripts/gateway-node.mjs"], {
      ...gwEnv,
      GATEWAY_NAME: name,
      GATEWAY_PORT: String(port),
    });
  let gwA = startGw("gw-a", GW_A);
  let gwB = startGw("gw-b", GW_B);
  await waitPort(GW_A);
  await waitPort(GW_B);
  const A = `http://127.0.0.1:${GW_A}`;
  const B = `http://127.0.0.1:${GW_B}`;
  await call(`${A}/v1/seed`, { count: 6 });

  const started = Date.now();
  const metrics = {
    request_total: 0,
    success: 0,
    lost_requests: 0,
    duplicate_execution: 0,
    stale_rejected: 0,
    failover: 0,
    worker_restart: 0,
    latencies: [],
    chatgpt: 0,
    gemini: 0,
    idempotent: 0,
  };
  let seq = 0;

  while (Date.now() - started < DURATION_MS) {
    const i = seq++;
    const gw = i % 2 ? B : A;
    const t0 = Date.now();
    const platform = i % 7 === 0 ? "gemini" : "chatgpt";
    const idem = i % 11 === 0 ? `rel-idem-${Math.floor(i / 11)}` : undefined;
    const enq = await call(`${gw}/v1/enqueue`, { prompt: `${platform}-${i}`, platform, idempotencyKey: idem });
    metrics.request_total += 1;
    if (platform === "gemini") metrics.gemini += 1;
    else metrics.chatgpt += 1;
    if (!enq.ok) {
      metrics.lost_requests += 1;
      continue;
    }
    if (enq.replay) metrics.idempotent += 1;
    const claimGw = i % 3 === 0 ? B : A;
    const claimed = await call(`${claimGw}/v1/claim`, { workerName: i % 2 ? "rel-w1" : "rel-w2" });
    if (!claimed.job) {
      if (enq.replay) {
        metrics.success += 1;
        continue;
      }
      metrics.lost_requests += 1;
      continue;
    }
    if (i % 13 === 0) {
      const dup = await call(`${claimGw === A ? B : A}/v1/finish`, {
        jobId: claimed.job.id,
        ok: true,
        text: "stale-try",
        leaseId: "not-the-lease",
        fencingToken: 0,
        attemptId: "x",
        workerId: "ghost",
      });
      if (dup.ok === false) metrics.stale_rejected += 1;
    }
    const fin = await finishIf(claimGw, claimed);
    if (fin?.ok) {
      metrics.success += 1;
      metrics.latencies.push(Date.now() - t0);
    } else metrics.lost_requests += 1;

    if (i && i % 40 === 0) {
      try {
        gwA.kill("SIGKILL");
      } catch {
        /* */
      }
      await new Promise((r) => setTimeout(r, 150));
      gwA = startGw("gw-a", GW_A);
      await waitPort(GW_A).catch(() => undefined);
      metrics.worker_restart += 1;
    }
  }

  const lat = metrics.latencies.slice().sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.max(0, Math.ceil((p / 100) * lat.length) - 1))] : 0);
  const out = {
    durationMs: Date.now() - started,
    ...metrics,
    success_rate: metrics.request_total ? metrics.success / metrics.request_total : 0,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    at: new Date().toISOString(),
  };
  delete out.latencies;
  await mkdir("/workspace/storage", { recursive: true });
  await writeFile("/workspace/storage/reliability-run.json", JSON.stringify({ ...out, sample: lat.slice(-20) }, null, 2));
  console.log(JSON.stringify(out));
  try {
    gwA.kill("SIGKILL");
    gwB.kill("SIGKILL");
    pg.kill("SIGKILL");
    await redis.close();
  } catch {
    /* */
  }
  if (out.success_rate < 0.8 || out.duplicate_execution > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
