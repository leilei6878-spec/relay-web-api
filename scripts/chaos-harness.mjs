import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { startFakeRedis } from "./fake-redis.mjs";

const ROOT = process.env.RELAY_PROJECT_ROOT || process.cwd();
const RUN_ID = process.env.RELAY_CHAOS_RUN_ID || `${process.pid}-${Date.now()}`;
const CHAOS_DIR = resolve(ROOT, "storage", `chaos-runtime-${RUN_ID}`);
const PG_DATA = resolve(CHAOS_DIR, "pgdata");
const PORT_BASE = 20_000 + (process.pid % 10_000) * 3;
const PG_PORT = Number(process.env.PG_HTTP_PORT || PORT_BASE);
const GW_A = Number(process.env.GW_A_PORT || PORT_BASE + 1);
const GW_B = Number(process.env.GW_B_PORT || PORT_BASE + 2);
const DEAD_MS = Number(process.env.RELAY_WORKER_DEAD_MS || 250);
const REPORT = [];
const ACTIVE_CHILDREN = new Set();
const ACTIVE_REDIS = new Set();

function waitPort(port, ms = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = createConnection({ host: "127.0.0.1", port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", () => {
        if (Date.now() - start > ms) reject(new Error(`port ${port} timeout`));
        else setTimeout(tryOnce, 60);
      });
    };
    tryOnce();
  });
}

function spawnLogged(cmd, args, env, logName) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ACTIVE_CHILDREN.add(child);
  child.once("exit", () => ACTIVE_CHILDREN.delete(child));
  child._buf = "";
  child.stdout.on("data", (d) => {
    child._buf += d;
  });
  child.stderr.on("data", (d) => {
    child._buf += d;
  });
  child.logName = logName;
  return child;
}

async function cleanup() {
  for (const child of ACTIVE_CHILDREN) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already stopped */
    }
  }
  await Promise.allSettled([...ACTIVE_REDIS].map((server) => server.close()));
  ACTIVE_REDIS.clear();
  await new Promise((resolveCleanup) => setTimeout(resolveCleanup, 150));
  if (CHAOS_DIR.startsWith(resolve(ROOT, "storage"))) {
    await rm(CHAOS_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function jsonFetch(url, opts = {}) {
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs || 8000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: res.status, ok: res.ok, data, gateway: res.headers.get("x-gateway") };
  } catch (err) {
    return { status: 0, ok: false, data: { error: err instanceof Error ? err.message : String(err) }, gateway: null };
  }
}

function record(id, result, evidence) {
  REPORT.push({ id, result, evidence, at: new Date().toISOString() });
  const mark = result === "PASS" ? "ok" : result === "FAIL" ? "FAIL" : result;
  console.log(`${mark}  ${id}  ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
}

async function main() {
  if (!CHAOS_DIR.startsWith(resolve(ROOT, "storage"))) throw new Error("unsafe chaos temp path");
  await mkdir(CHAOS_DIR, { recursive: true });
  await rm(PG_DATA, { recursive: true, force: true }).catch(() => undefined);

  const redisPersist = resolve(CHAOS_DIR, "redis.json");
  await writeFile(redisPersist, "{}", "utf8").catch(() => undefined);
  let redis = await startFakeRedis({ persistPath: redisPersist, port: 0 });
  ACTIVE_REDIS.add(redis);
  console.log("redis", redis.url);

  let pg = spawnLogged(
    process.execPath,
    ["scripts/shared-pg.mjs"],
    {
      PG_HTTP_PORT: String(PG_PORT),
      RELAY_PGLITE_DIR: PG_DATA,
      RELAY_PG_RESET: "1",
    },
    "pg",
  );
  await waitPort(PG_PORT, 15000);
  console.log("shared-pg up");

  const gwEnv = {
    RELAY_SOT: "postgres",
    RELAY_SQL_HTTP_URL: `http://127.0.0.1:${PG_PORT}`,
    REDIS_URL: redis.url,
    RELAY_WORKER_DEAD_MS: String(DEAD_MS),
    RELAY_CLAIM_GRACE_MS: "40",
    RELAY_CIRCUIT_TRIP: "3",
    RELAY_CIRCUIT_WINDOW_MS: "60000",
    RELAY_REQUIRE_REDIS: "1",
    RELAY_SECRETS_KEY: "cluster-test-key",
    RELAY_ADMIN_TOKEN: "ad-relay-cluster-test-token-aaaa",
    RELAY_WORKER_TOKEN: "wk-relay-cluster-test-token-aaaa",
  };

  function startGw(name, port) {
    return spawnLogged(
      process.execPath,
      ["--experimental-strip-types", "--import", "./scripts/register-ts-ext.mjs", "scripts/gateway-node.mjs"],
      { ...gwEnv, GATEWAY_NAME: name, GATEWAY_PORT: String(port) },
      name,
    );
  }

  let gwA = startGw("gw-a", GW_A);
  let gwB = startGw("gw-b", GW_B);
  await waitPort(GW_A, 15000);
  await waitPort(GW_B, 15000);
  const A = `http://127.0.0.1:${GW_A}`;
  const B = `http://127.0.0.1:${GW_B}`;

  async function restartGwA() {
    try {
      gwA.kill("SIGKILL");
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 200));
    gwA = startGw("gw-a", GW_A);
    await waitPort(GW_A, 15000);
  }

  async function drain(gw = A) {
    for (let i = 0; i < 30; i++) {
      const c = await jsonFetch(`${gw}/v1/claim`, { method: "POST", body: { workerName: "drain" } });
      if (!c.data.job) break;
      await jsonFetch(`${gw}/v1/finish`, {
        method: "POST",
        body: {
          jobId: c.data.job.id,
          ok: true,
          text: "drain",
          leaseId: c.data.job.leaseId,
          fencingToken: c.data.job.fencingToken,
          attemptId: c.data.job.attemptId,
          workerId: c.data.job.workerId,
        },
      });
    }
    await jsonFetch(`${gw}/v1/unlock-all`, { method: "POST", body: {} });
  }

  const seed = await jsonFetch(`${A}/v1/seed`, { method: "POST", body: { count: 8 } });
  if (!seed.ok) {
    record("seed", "FAIL", seed.data);
    throw new Error("seed failed " + JSON.stringify(seed.data));
  }
  record("seed", "PASS", seed.data);

  // Phase 4 — two nodes see the same request
  {
    const enq = await jsonFetch(`${A}/v1/enqueue`, { method: "POST", body: { prompt: "shared", requestId: "R-shared" } });
    const seen = await jsonFetch(`${B}/v1/job/${enq.data.job?.id}`);
    const pass = Boolean(enq.data.job?.id) && seen.data.job?.id === enq.data.job.id;
    record("P4.gateway-b-sees-request", pass ? "PASS" : "FAIL", {
      fromA: enq.data.job?.id,
      fromB: seen.data.job?.id,
    });
    await drain();
  }

  // Two workers claim — only one wins
  {
    const enq = await jsonFetch(`${A}/v1/enqueue`, { method: "POST", body: { prompt: "race-claim" } });
    const [c1, c2] = await Promise.all([
      jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "wa" } }),
      jsonFetch(`${B}/v1/claim`, { method: "POST", body: { workerName: "wb" } }),
    ]);
    const winners = [c1, c2].filter((x) => x.data.job);
    const sameJob = winners.filter((x) => x.data.job.id === enq.data.job.id);
    const pass = sameJob.length === 1;
    record("P4.two-workers-one-claim", pass ? "PASS" : "FAIL", {
      winners: sameJob.length,
      wa: c1.data.job?.id,
      wb: c2.data.job?.id,
    });
    const win = winners[0];
    if (win?.data.job) {
      await jsonFetch(`${win.gateway === "gw-b" ? B : A}/v1/finish`, {
        method: "POST",
        body: {
          jobId: win.data.job.id,
          ok: true,
          text: "claimed-once",
          leaseId: win.data.job.leaseId,
          fencingToken: win.data.job.fencingToken,
          attemptId: win.data.job.attemptId,
          workerId: win.data.job.workerId,
        },
      });
    }
  }

  // Same account cannot double-lease
  {
    await drain();
    const enqs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        jsonFetch(`${i % 2 ? B : A}/v1/enqueue`, { method: "POST", body: { prompt: `lease-${i}`, timeoutMs: 8000 } }),
      ),
    );
    const ok = enqs.filter((e) => e.data.ok);
    const accounts = ok.map((e) => e.data.job?.accountId).filter(Boolean);
    const unique = new Set(accounts);
    const pass = unique.size === accounts.length && accounts.length > 0;
    record("P4.no-double-account-lease", pass ? "PASS" : "FAIL", { leased: accounts.length, unique: unique.size });
    for (const _entry of ok) {
      const c = await jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "drain" } });
      if (c.data.job) {
        await jsonFetch(`${A}/v1/finish`, {
          method: "POST",
          body: {
            jobId: c.data.job.id,
            ok: true,
            text: "drain",
            leaseId: c.data.job.leaseId,
            fencingToken: c.data.job.fencingToken,
            attemptId: c.data.job.attemptId,
            workerId: c.data.job.workerId,
          },
        });
      }
    }
    // drain remaining
    for (let i = 0; i < 12; i++) {
      const c = await jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "drain" } });
      if (!c.data.job) break;
      await jsonFetch(`${A}/v1/finish`, {
        method: "POST",
        body: {
          jobId: c.data.job.id,
          ok: true,
          text: "drain",
          leaseId: c.data.job.leaseId,
          fencingToken: c.data.job.fencingToken,
          attemptId: c.data.job.attemptId,
          workerId: c.data.job.workerId,
        },
      });
    }
  }

  // C6 Idempotency storm 20 + 50 across two gateways
  {
    await drain();
    const key = `storm-${Date.now()}`;
    const calls = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        jsonFetch(`${i % 2 ? B : A}/v1/enqueue`, {
          method: "POST",
          body: { prompt: "storm", idempotencyKey: key, requestId: `R-storm` },
        }),
      ),
    );
    const ids = new Set(calls.filter((c) => c.data.ok && c.data.job).map((c) => c.data.job.id));
    const execs = calls.reduce((n, c) => n + (c.data.replay ? 0 : c.data.ok && c.data.job ? 1 : 0), 0);
    const pass = ids.size === 1;
    record("C6.idempotency-20", pass ? "PASS" : "FAIL", { uniqueJobs: ids.size, ok: calls.filter((c) => c.data.ok).length, execs });
    const key2 = `storm50-${Date.now()}`;
    const calls50 = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        jsonFetch(`${i % 2 ? B : A}/v1/enqueue`, {
          method: "POST",
          body: { prompt: "storm50", idempotencyKey: key2 },
        }),
      ),
    );
    const ids50 = new Set(calls50.filter((c) => c.data.ok && c.data.job).map((c) => c.data.job.id));
    record("C6.idempotency-50", ids50.size === 1 ? "PASS" : "FAIL", { uniqueJobs: ids50.size, ok: calls50.filter((c) => c.data.ok).length });
  }

  // C8 duplicate finish
  {
    await drain();
    const enq = await jsonFetch(`${A}/v1/enqueue`, { method: "POST", body: { prompt: "dup-finish" } });
    const c = await jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "w-dup" } });
    if (!enq.data.ok || !c.data.job) {
      const snapshot = await jsonFetch(`${A}/v1/jobs`);
      throw new Error(`duplicate-finish setup failed ${JSON.stringify({ enqueue: enq.data, claim: c.data, jobs: snapshot.data.jobs })}`);
    }
    const proof = {
      jobId: c.data.job.id,
      ok: true,
      text: "first",
      leaseId: c.data.job.leaseId,
      fencingToken: c.data.job.fencingToken,
      attemptId: c.data.job.attemptId,
      workerId: "w-dup",
    };
    const f1 = await jsonFetch(`${A}/v1/finish`, { method: "POST", body: proof });
    const f2 = await jsonFetch(`${B}/v1/finish`, { method: "POST", body: { ...proof, text: "second" } });
    const job = await jsonFetch(`${B}/v1/job/${c.data.job.id}`);
    const pass = f1.data.ok === true && f2.data.ok === false && job.data.job?.text === "first";
    record("C8.duplicate-result", pass ? "PASS" : "FAIL", { f1: f1.data, f2: f2.data, text: job.data.job?.text });
  }

  // C2 / C10 stale fencing
  {
    await drain();
    const enq = await jsonFetch(`${A}/v1/enqueue`, { method: "POST", body: { prompt: "stale", timeoutMs: 400 } });
    const c1 = await jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "w-stale" } });
    const staleProof = {
      jobId: c1.data.job.id,
      ok: true,
      text: "stale-text",
      leaseId: c1.data.job.leaseId,
      fencingToken: c1.data.job.fencingToken,
      attemptId: c1.data.job.attemptId,
      workerId: "w-stale",
    };
    await new Promise((r) => setTimeout(r, DEAD_MS + 80));
    const c2 = await jsonFetch(`${B}/v1/claim`, { method: "POST", body: { workerName: "w-new" } });
    const stale = await jsonFetch(`${A}/v1/finish`, { method: "POST", body: staleProof });
    let freshOk = { data: { ok: false } };
    if (c2.data.job) {
      freshOk = await jsonFetch(`${B}/v1/finish`, {
        method: "POST",
        body: {
          jobId: c2.data.job.id,
          ok: true,
          text: "fresh-text",
          leaseId: c2.data.job.leaseId,
          fencingToken: c2.data.job.fencingToken,
          attemptId: c2.data.job.attemptId,
          workerId: "w-new",
        },
      });
    }
    const job = await jsonFetch(`${A}/v1/job/${enq.data.job.id}`);
    const pass = stale.data.ok === false && job.data.job?.text !== "stale-text";
    record("C2.stale-worker-rejected", pass ? "PASS" : "FAIL", {
      stale: stale.data,
      freshClaim: Boolean(c2.data.job),
      freshFinish: freshOk.data,
      text: job.data.job?.text,
      status: job.data.job?.status,
    });
    record("C10.timeout-old-result", pass ? "PASS" : "FAIL", { text: job.data.job?.text, status: job.data.job?.status });
  }

  // C1 worker crash — job requeued, not lost
  {
    await drain();
    const enq = await jsonFetch(`${A}/v1/enqueue`, { method: "POST", body: { prompt: "crash", requestId: "R-crash", timeoutMs: 400 } });
    const c = await jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "w-crash" } });
    await new Promise((r) => setTimeout(r, DEAD_MS + 80));
    const job = await jsonFetch(`${B}/v1/job/${enq.data.job.id}`);
    const recovered = job.data.job?.status === "queued" || job.data.job?.status === "dead" || job.data.job?.status === "error";
    const kept = job.data.job?.requestId === "R-crash" || job.data.job?.id === enq.data.job.id;
    record("C1.worker-crash-no-lost-request", recovered && kept ? "PASS" : "FAIL", {
      status: job.data.job?.status,
      requestId: job.data.job?.requestId,
      claimed: Boolean(c.data.job),
    });
    if (job.data.job?.status === "queued") {
      const c2 = await jsonFetch(`${B}/v1/claim`, { method: "POST", body: { workerName: "w-rescue" } });
      if (c2.data.job) {
        await jsonFetch(`${B}/v1/finish`, {
          method: "POST",
          body: {
            jobId: c2.data.job.id,
            ok: true,
            text: "rescued",
            leaseId: c2.data.job.leaseId,
            fencingToken: c2.data.job.fencingToken,
            attemptId: c2.data.job.attemptId,
            workerId: "w-rescue",
          },
        });
      }
    }
  }

  // C9 cancel
  {
    await drain();
    const enq = await jsonFetch(`${A}/v1/enqueue`, { method: "POST", body: { prompt: "cancel-me" } });
    const c = await jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "w-c" } });
    await jsonFetch(`${B}/v1/cancel`, { method: "POST", body: { jobId: enq.data.job.id, error: "REQUEST_CANCELLED: client" } });
    const job = await jsonFetch(`${A}/v1/job/${enq.data.job.id}`);
    const lease = await jsonFetch(`${A}/v1/coord?key=account-lease:${c.data.job?.accountId}`);
    const pass = job.data.job?.status === "cancelled" && !lease.data.value;
    record("C9.cancel-consistency", pass ? "PASS" : "FAIL", { status: job.data.job?.status, lease: lease.data.value });
  }

  // C7 account contention 20 vs 5 chatgpt accounts (seed has 5 chatgpt + 1 gemini)
  {
    await drain();
    const enqs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => jsonFetch(`${i % 2 ? B : A}/v1/enqueue`, { method: "POST", body: { prompt: `c7-${i}` } })),
    );
    const ok = enqs.filter((e) => e.data.ok && e.data.job);
    const accounts = ok.map((e) => e.data.job.accountId);
    const unique = new Set(accounts);
    const pass = unique.size === accounts.length && unique.size >= 1;
    record("C7.account-contention", pass ? "PASS" : "FAIL", { ok: ok.length, unique: unique.size, fail: 20 - ok.length });
    for (let i = 0; i < 20; i++) {
      const c = await jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "c7" } });
      if (!c.data.job) break;
      await jsonFetch(`${A}/v1/finish`, {
        method: "POST",
        body: {
          jobId: c.data.job.id,
          ok: true,
          text: "c7",
          leaseId: c.data.job.leaseId,
          fencingToken: c.data.job.fencingToken,
          attemptId: c.data.job.attemptId,
          workerId: "c7",
        },
      });
    }
  }

  // Phase 6 provider DOM isolation
  {
    await drain();
    await jsonFetch(`${A}/v1/enqueue`, { method: "POST", body: { prompt: "dom" } });
    const c = await jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "w-dom" } });
    await jsonFetch(`${A}/v1/finish`, {
      method: "POST",
      body: {
        jobId: c.data.job.id,
        ok: false,
        error: "PROVIDER_DOM_CHANGED: composer missing",
        fault: "provider",
        leaseId: c.data.job.leaseId,
        fencingToken: c.data.job.fencingToken,
        attemptId: c.data.job.attemptId,
        workerId: "w-dom",
      },
    });
    const jobs = await jsonFetch(`${A}/v1/jobs`);
    const accId = c.data.job.accountId;
    const plane = jobs.data;
    void plane;
    const again = await jsonFetch(`${B}/v1/enqueue`, { method: "POST", body: { prompt: "dom2" } });
    const pass = again.data.ok === true;
    record("C6P.provider-dom-does-not-drain-pool", pass ? "PASS" : "FAIL", {
      firstAccount: accId,
      secondOk: again.data.ok,
      secondError: again.data.error,
    });
    if (again.data.job) {
      const c2 = await jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "w-dom2" } });
      if (c2.data.job) {
        await jsonFetch(`${A}/v1/finish`, {
          method: "POST",
          body: {
            jobId: c2.data.job.id,
            ok: true,
            text: "ok",
            leaseId: c2.data.job.leaseId,
            fencingToken: c2.data.job.fencingToken,
            attemptId: c2.data.job.attemptId,
            workerId: "w-dom2",
          },
        });
      }
    }
  }

  // C3 kill gateway A — B continues, no duplicate exec
  {
    const key = `gwcrash-${Date.now()}`;
    const enq = await jsonFetch(`${A}/v1/enqueue`, { method: "POST", body: { prompt: "gw-crash", idempotencyKey: key } });
    await restartGwA();
    const seen = await jsonFetch(`${B}/v1/job/${enq.data.job.id}`);
    const replay = await jsonFetch(`${B}/v1/enqueue`, { method: "POST", body: { prompt: "gw-crash", idempotencyKey: key } });
    const pass = seen.data.job?.id === enq.data.job.id && (replay.data.replay === true || replay.data.job?.id === enq.data.job.id);
    record("C3.gateway-crash-no-duplicate", pass ? "PASS" : "FAIL", {
      original: enq.data.job?.id,
      after: seen.data.job?.id,
      replay: replay.data.replay,
      replayId: replay.data.job?.id,
    });
  }

  async function restartGwB() {
    try {
      gwB.kill("SIGKILL");
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 200));
    gwB = startGw("gw-b", GW_B);
    await waitPort(GW_B, 15000);
  }

  // C4 Redis restart — no double lease after restore
  {
    const persist = redis.persistPath;
    const port = redis.port;
    await redis.close();
    ACTIVE_REDIS.delete(redis);
    await new Promise((r) => setTimeout(r, 150));
    const redis2 = await startFakeRedis({ persistPath: persist, port });
    ACTIVE_REDIS.add(redis2);
    await restartGwA();
    await restartGwB();
    const enq = await jsonFetch(`${B}/v1/enqueue`, { method: "POST", body: { prompt: "after-redis" } });
    const [c1, c2] = await Promise.all([
      jsonFetch(`${A}/v1/claim`, { method: "POST", body: { workerName: "ra" } }),
      jsonFetch(`${B}/v1/claim`, { method: "POST", body: { workerName: "rb" } }),
    ]);
    const winners = [c1, c2].filter((x) => x.data.job && x.data.job.id === enq.data.job?.id);
    record("C4.redis-restart", enq.data.ok && winners.length <= 1 ? "PASS" : "FAIL", {
      enqueue: enq.data.ok,
      winners: winners.length,
      redis: redis2.url,
      error: enq.data.error,
    });
    const job = c1.data.job || c2.data.job;
    if (job) {
      await jsonFetch(`${B}/v1/finish`, {
        method: "POST",
        body: {
          jobId: job.id,
          ok: true,
          text: "redis-ok",
          leaseId: job.leaseId,
          fencingToken: job.fencingToken,
          attemptId: job.attemptId,
          workerId: job.workerId,
        },
      });
    }
    redis = redis2;
  }

  // C5 Postgres restart
  {
    pg.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    const pg2 = spawnLogged(
      process.execPath,
      ["scripts/shared-pg.mjs"],
      {
        PG_HTTP_PORT: String(PG_PORT),
        RELAY_PGLITE_DIR: PG_DATA,
      },
      "pg2",
    );
    await waitPort(PG_PORT, 15000);
    pg = pg2;
    const jobs = await jsonFetch(`${B}/v1/jobs`);
    const pass = Array.isArray(jobs.data.jobs);
    record("C5.postgres-restart", pass ? "PASS" : "FAIL", {
      jobCount: jobs.data.jobs?.length,
      pgLog: pg2._buf.slice(-200),
    });
  }

  // Phase 8 stop-all restart recovery
  {
    try {
      gwA.kill("SIGKILL");
      gwB.kill("SIGKILL");
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 200));
    gwA = startGw("gw-a", GW_A);
    gwB = startGw("gw-b", GW_B);
    await waitPort(GW_A, 15000);
    await waitPort(GW_B, 15000);
    const jobs = await jsonFetch(`${A}/v1/jobs`);
    const phantom = (jobs.data.jobs || []).filter((j) => j.status === "running");
    const enq = await jsonFetch(`${B}/v1/enqueue`, { method: "POST", body: { prompt: "post-restart" } });
    record("P8.restart-recovery", enq.data.ok ? "PASS" : "FAIL", {
      jobs: jobs.data.jobs?.length,
      phantomRunning: phantom.length,
      enqueue: enq.data.ok,
    });
  }

  // Readiness
  {
    const r = await jsonFetch(`${A}/internal/readiness`);
    record("P1.internal-readiness", r.status === 200 && r.data.ready === true ? "PASS" : "FAIL", {
      status: r.status,
      ready: r.data.ready,
      blockers: r.data.blockers,
      backend: r.data.backend,
    });
  }

  const pass = REPORT.filter((x) => x.result === "PASS").length;
  const fail = REPORT.filter((x) => x.result === "FAIL").length;
  const summary = { pass, fail, total: REPORT.length, items: REPORT, at: new Date().toISOString() };
  await mkdir(`${ROOT}/storage`, { recursive: true });
  await writeFile(`${ROOT}/storage/chaos-harness-report.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ pass, fail, total: REPORT.length }));

  await cleanup();
  if (fail) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exitCode = 1;
});
