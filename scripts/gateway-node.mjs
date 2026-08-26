import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Minimal Gateway process for distributed correctness tests.
 * Shares PostgreSQL (via RELAY_SQL_HTTP_URL) and Redis (REDIS_URL) with sibling nodes.
 * Same TypeScript modules as the product Gateway — not a mock scheduler.
 */
process.env.RELAY_SOT = process.env.RELAY_SOT || "postgres";
const port = Number(process.env.GATEWAY_PORT || 19001);
const name = process.env.GATEWAY_NAME || "gw-a";

const { enqueueChat, enqueueImage, claimNext, finishJob, cancelJob, getJob, listJobs, beatWorker } =
  await import("../src/lib/job-queue.ts");
const { writeControlPlane } = await import("../src/lib/control-plane.ts");
const { createRelayRequest } = await import("../src/lib/requests.ts");
const { runLiveReadinessCheck } = await import("../src/lib/live-readiness.ts");
const { coordCompareExpire, coordGet, coordDel } = await import("../src/lib/coord.ts");

let providerExecs = 0;

async function seed(count = 5) {
  await mkdir(resolve("storage/sessions"), { recursive: true });
  const accounts = [];
  for (let i = 0; i < count; i++) {
    const id = `ac-${name}-${i}`;
    await writeFile(
      resolve("storage/sessions", `${id}.json`),
      JSON.stringify({
        cookies: [{ name: "session-token", value: "t", domain: ".chatgpt.com", path: "/" }],
        origins: [],
      }),
      "utf8",
    );
    accounts.push({
      id,
      platform: i === count - 1 ? "gemini" : "chatgpt",
      email: `${id}@test.local`,
      remark: "cluster",
      status: "healthy",
      proxyId: "px-1",
      sessionPath: `storage/sessions/${id}.json`,
      failCount: 0,
      totalRequests: 0,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      lockedUntil: null,
      canary: i === 0,
      sessionVersion: 1,
    });
  }
  await writeControlPlane({
    accounts,
    proxies: [
      {
        id: "px-1",
        name: "cluster",
        type: "http",
        host: "127.0.0.1",
        port: 9,
        username: "u",
        stickySessionId: "s",
        region: "QA",
        status: "active",
        maxAccounts: 64,
        remark: "",
        createdAt: new Date().toISOString(),
      },
    ],
    settings: {
      maxRetry: 3,
      failThreshold: 5,
      coolDownSeconds: 1,
      intervalMinMs: 0,
      intervalMaxMs: 1,
      concurrencyPerWorker: 8,
      enforceProxy: true,
      replyTimeoutMs: 8000,
      allowPreviewFallback: false,
      chatgptSelectors: { input: ["textarea"], send: ["button"], assistant: ["article"], streamingStop: [] },
      geminiSelectors: { input: ["textarea"], send: ["button"], assistant: ["article"], streamingStop: [] },
    },
  });
  return { ok: true, accounts: accounts.length };
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("x-gateway", name);
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/internal/readiness") {
      const report = await runLiveReadinessCheck();
      send(res, report.ready ? 200 : 503, report);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/seed") {
      send(res, 200, await seed(Number((await readBody(req).catch(() => ({ count: 5 }))).count || 5)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/enqueue") {
      const body = await readBody(req);
      const platform = body.platform === "gemini" ? "gemini" : "chatgpt";
      const created = await createRelayRequest({
        id: body.requestId,
        idempotencyKey: body.idempotencyKey,
        provider: platform,
        model: body.model || (platform === "gemini" ? "gemini-image" : "gpt-5.6"),
      });
      if (created.replay) {
        const listed = await listJobs();
        const job =
          listed.jobs.find((j) => j.requestId === created.request.id) ||
          listed.jobs.find((j) => body.idempotencyKey && j.idempotencyKey === body.idempotencyKey) ||
          null;
        send(res, 200, { ok: true, replay: true, request: created.request, job, providerExecs, gateway: name });
        return;
      }
      const fn = platform === "gemini" ? enqueueImage : enqueueChat;
      const queued = await fn(body.prompt || "hi", body.model, body.timeoutMs || 8000, body.images || [], {
        idempotencyKey: body.idempotencyKey,
        requestId: created.request.id,
        excludeAccountIds: body.excludeAccountIds,
      });
      if (queued.ok && !queued.replay) providerExecs += 1;
      send(res, queued.ok ? 200 : 409, { ...queued, replay: queued.replay || false, providerExecs, gateway: name });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/claim") {
      const body = await readBody(req);
      const claimed = await claimNext(body.workerName || "w1", body.stats);
      send(res, 200, {
        job: claimed.job,
        lease: claimed.lease || claimed.job?.lease,
        gateway: name,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/finish") {
      const body = await readBody(req);
      const out = await finishJob(body.jobId, body);
      send(res, out.ok ? 200 : 409, { ...out, gateway: name });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/cancel") {
      const body = await readBody(req);
      send(res, 200, await cancelJob(body.jobId, body.error || "REQUEST_CANCELLED: client"));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/renew") {
      const body = await readBody(req);
      const ok = await coordCompareExpire(`lease:${body.jobId}`, JSON.stringify(body.lease || body.leaseId), body.ttlMs || 8000);
      send(res, 200, { ok });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/v1/job/")) {
      const id = url.pathname.slice("/v1/job/".length);
      send(res, 200, { job: await getJob(id), gateway: name });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/jobs") {
      send(res, 200, { ...(await listJobs()), providerExecs, gateway: name });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/beat") {
      const body = await readBody(req);
      send(res, 200, await beatWorker(body.workerName || "w1", body.stats));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/coord") {
      const key = url.searchParams.get("key");
      send(res, 200, { key, value: key ? await coordGet(key) : null });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/unlock-all") {
      const { dbUnlockAllAccounts, dbLoadJobs } = await import("../src/lib/relay-db.ts");
      await dbUnlockAllAccounts();
      const jobs = (await dbLoadJobs()) || [];
      for (const j of jobs) {
        if (j.accountId) await coordDel(`account-lease:${j.accountId}`);
        if (j.id) await coordDel(`job-claim:${j.id}`);
      }
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/crash") {
      send(res, 200, { ok: true });
      setTimeout(() => process.exit(99), 30);
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ ok: true, name, port, url: `http://127.0.0.1:${port}` }) + "\n");
});
