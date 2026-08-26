import { observeBrowser } from "./browser-baseline";
import { isCanaryAccount } from "./canary";
import { canDispatch, recordCanaryResult, recordProviderFault } from "./circuit";
import { readSessionJson, writeSessionFile } from "./chatgpt-runner";
import { patchAccount, pickAccount, readControlPlane } from "./control-plane";
import { coordCompareDel, coordDel, coordGet, coordSet, coordSetNx } from "./coord";
import { classifyError, decisionFor, normalizeError } from "./faults";
import { clearJobEvents, publishJobEvent } from "./job-events";
import { assertLease, issueLease, type Lease } from "./leases";
import { persistImageUrl } from "./objects";
import type { EnqueueOpts, Job, WorkerRow } from "./job-queue";
import {
  dbCancelJobAtomic,
  dbClaimJob,
  dbFinishJobAtomic,
  dbGetJob,
  dbGetJobByIdempotency,
  dbInsertJobIdempotent,
  dbListQueuedJobs,
  dbLoadJobs,
  dbLoadWorkers,
  dbReclaimDeadJobs,
  dbTryLockAccount,
  dbUnlockAccount,
  dbUpsertWorker,
} from "./relay-db";
import { addAttempt, finishAttempt } from "./requests";
import { getSecret, proxySecretKey } from "./secrets";
import { proxyServer } from "./session-file";
import { uid } from "./utils";
import { markResilience } from "./resilience-metrics";

const PENDING = "__pending__";

function workerDeadMs() {
  return Number(process.env.RELAY_WORKER_DEAD_MS || 60_000);
}

async function reclaimAll() {
  const plane = await readControlPlane().catch(() => ({ settings: { maxRetry: 3 } }));
  const recovered = await dbReclaimDeadJobs(workerDeadMs(), claimGraceMs(), plane.settings?.maxRetry || 3).catch(() => []);
  for (const j of recovered || []) {
    const id = String(j.id || "");
    const accountId = String(j.accountId || "");
    if (id) await coordDel(`job-claim:${id}`);
    if (accountId) await coordDel(`account-lease:${accountId}`);
  }
  return recovered;
}

function claimGraceMs() {
  return Number(process.env.RELAY_CLAIM_GRACE_MS || 45_000);
}

function asJob(row: Record<string, unknown> | null | undefined): Job | null {
  if (!row || !row.id) return null;
  return row as unknown as Job;
}

export async function enqueuePg(
  platform: Job["platform"],
  prompt: string,
  model: string,
  timeoutMs: number,
  images: string[] = [],
  opts: EnqueueOpts = {},
) {
  if (opts.idempotencyKey) {
    const idemKey = `idem:${opts.idempotencyKey}`;
    const won = await coordSetNx(idemKey, PENDING, 86_400_000);
    if (!won) {
      for (let i = 0; i < 40; i++) {
        const existing = await dbGetJobByIdempotency(opts.idempotencyKey);
        if (existing) return { ok: true as const, job: asJob(existing)!, replay: true };
        await new Promise((r) => setTimeout(r, 25));
      }
      const late = await dbGetJobByIdempotency(opts.idempotencyKey);
      if (late) return { ok: true as const, job: asJob(late)!, replay: true };
    }
  }

  const exclude = [...(opts.excludeAccountIds || [])];
  let account = await pickAccount(platform, exclude);
  const until = new Date(Date.now() + timeoutMs).toISOString();
  while (account) {
    const allowed = await canDispatch(platform, isCanaryAccount(account));
    if (!allowed) {
      if (opts.idempotencyKey) await coordDel(`idem:${opts.idempotencyKey}`);
      return { ok: false as const, error: `PROVIDER circuit OPEN for ${platform}; refusing to consume the account pool` };
    }
    const redisOk = await coordSetNx(`account-lease:${account.id}`, "pending", timeoutMs);
    const sqlOk = redisOk ? await dbTryLockAccount(account.id, until) : false;
    if (redisOk && sqlOk) break;
    if (redisOk) await coordDel(`account-lease:${account.id}`);
    exclude.push(account.id);
    account = await pickAccount(platform, exclude);
  }
  if (!account) {
    if (opts.idempotencyKey) await coordDel(`idem:${opts.idempotencyKey}`);
    const { poolUnavailableMessage } = await import("./eligibility");
    const plane = await readControlPlane();
    const extra: Record<string, string> = {};
    for (const a of plane.accounts.filter((x) => x.platform === platform)) {
      if (await coordGet(`account-lease:${a.id}`)) extra[a.id] = "正在执行其他任务，请稍候再测";
    }
    return {
      ok: false as const,
      error: poolUnavailableMessage(platform, plane.accounts, plane.proxies, plane.settings, extra),
    };
  }

  const job: Job = {
    id: uid(),
    status: "queued",
    platform,
    prompt,
    model,
    accountId: account.id,
    accountEmail: account.email,
    createdAt: new Date().toISOString(),
    timeoutMs,
    images: images.slice(0, 4),
    attempts: 0,
    requestId: opts.requestId || uid(),
    traceId: opts.traceId || uid(),
    idempotencyKey: opts.idempotencyKey,
    excludeAccountIds: exclude,
    proxyId: account.proxyId || undefined,
    kind: opts.kind,
    turns: opts.turns,
    selectorPackVersion: opts.selectorPackVersion,
    requestedModel: model,
  };

  const inserted = await dbInsertJobIdempotent(job as unknown as Record<string, unknown>);
  if (!inserted.inserted) {
    await coordDel(`account-lease:${account.id}`);
    await dbUnlockAccount(account.id).catch(() => undefined);
    if (opts.idempotencyKey) await coordSet(`idem:${opts.idempotencyKey}`, String(inserted.job.id), 86_400_000);
    return { ok: true as const, job: asJob(inserted.job)!, replay: true };
  }
  if (opts.idempotencyKey) await coordSet(`idem:${opts.idempotencyKey}`, job.id, 86_400_000);
  await coordSet(`account-lease:${account.id}`, job.id, timeoutMs);
  await patchAccount(account.id, { lockedUntil: until });
  markResilience("request_total");
  return { ok: true as const, job, replay: false };
}

export async function claimNextPg(
  workerName = "local",
  stats?: {
    capacity?: number;
    activeJobs?: number;
    cpu?: number;
    ram?: number;
    browsers?: number;
    draining?: boolean;
    browserStartMs?: number;
  },
) {
  const plane = await readControlPlane();
  await reclaimAll();
  await dbUpsertWorker({
    name: workerName,
    lastBeat: new Date().toISOString(),
    capacity: stats?.capacity,
    activeJobs: stats?.activeJobs,
    cpu: stats?.cpu,
    ram: stats?.ram,
    browsers: stats?.browsers,
    draining: stats?.draining,
  });
  await coordSet(`hb:worker:${workerName}`, String(Date.now()), 20_000);
  if (stats?.browserStartMs || stats?.ram || stats?.cpu) {
    observeBrowser({ startLatencyMs: stats.browserStartMs, ramMb: stats.ram, cpu: stats.cpu });
  }
  if (stats?.draining) {
    return { job: null as Job | null, storageState: null as unknown, proxy: null };
  }

  const queued = (await dbListQueuedJobs(40)) as unknown as Job[];
  let claimed: Record<string, unknown> | null = null;
  for (const candidate of queued) {
    if (!candidate.id) continue;
    const won = await coordSetNx(`job-claim:${candidate.id}`, workerName, candidate.timeoutMs || 90_000);
    if (!won) continue;
    const leaseId = uid();
    const row = await dbClaimJob(candidate.id, workerName, leaseId);
    if (!row) {
      await coordDel(`job-claim:${candidate.id}`);
      continue;
    }
    claimed = row;
    break;
  }
  if (!claimed) return { job: null as Job | null, storageState: null as unknown, proxy: null };

  const job = asJob(claimed)!;
  const fence = Number(job.fencingToken || 1);
  const lease: Lease = issueLease(job.id, workerName, Math.max(0, fence - 1));
  lease.leaseId = String(job.leaseId);
  lease.fencingToken = fence;
  lease.attemptId = uid();
  job.lease = lease;
  job.leaseId = lease.leaseId;
  job.fencingToken = fence;
  job.attemptId = lease.attemptId;
  job.workerId = workerName;
  job.workerName = workerName;
  await coordSet(`lease:${job.id}`, JSON.stringify(lease), job.timeoutMs || 90_000);
  if (job.accountId) await coordSet(`account-lease:${job.accountId}`, job.id, job.timeoutMs || 90_000);

  const { dbUpsertJob } = await import("./relay-db");
  await dbUpsertJob(job as unknown as Record<string, unknown>);

  if (job.requestId) {
    await addAttempt({
      id: lease.attemptId,
      requestId: job.requestId,
      jobId: job.id,
      accountId: job.accountId,
      proxyId: job.proxyId,
      workerId: workerName,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
    });
  }

  const session = job.accountId ? await readSessionJson(job.accountId) : { ok: false as const, error: "无账号" };
  const acc = plane.accounts.find((a) => a.id === job.accountId);
  const bound = acc ? plane.proxies.find((p) => p.id === acc.proxyId) : null;
  const password = bound ? (await getSecret(proxySecretKey(bound.id))) || "" : "";
  const proxy = bound
    ? {
        server: proxyServer(bound),
        username: bound.type === "ss" ? "" : bound.username,
        password: bound.type === "ss" ? "" : password,
      }
    : null;
  let storageState: { cookies?: unknown[]; origins?: unknown[] } = { cookies: [], origins: [] };
  if (session.ok) {
    try {
      const parsed = JSON.parse(session.json) as { cookies?: unknown[]; origins?: unknown[] };
      storageState = { cookies: parsed.cookies || [], origins: [] };
    } catch {
      storageState = { cookies: [], origins: [] };
    }
  }
  return {
    job,
    storageState,
    proxy,
    lease,
    sessionVersion: acc?.sessionVersion || 0,
    accountId: job.accountId,
    selectors: (await import("./provider/index")).getAdapter(job.platform).selectorPack(job.selectorPackVersion),
    selectorPackVersion: job.selectorPackVersion,
    turns: job.turns || [],
    kind: job.kind || (job.platform === "gemini" ? "image" : "chat"),
  };
}

export async function finishJobPg(
  id: string,
  result: {
    ok: boolean;
    text?: string;
    url?: string;
    error?: string;
    fault?: string;
    leaseId?: string;
    fencingToken?: number;
    attemptId?: string;
    workerId?: string;
    sessionState?: unknown;
    sessionVersion?: number;
    sessionBaseVersion?: number;
    modelActual?: string;
    pageState?: string;
    fingerprint?: string;
    selectorPackVersion?: string;
  },
) {
  const current = asJob(await dbGetJob(id));
  if (!current) return { ok: false as const, error: "任务不存在" };
  if (current.status === "done" || current.status === "error" || current.status === "cancelled" || current.status === "dead") {
    markResilience("stale_rejected");
    return { ok: false as const, error: "STALE_LEASE: job already terminal" };
  }
  const held: Lease | undefined = current.lease || {
    leaseId: current.leaseId || "",
    fencingToken: current.fencingToken || 0,
    attemptId: current.attemptId || "",
    workerId: current.workerId || "",
    jobId: current.id,
  };
  const proof = assertLease(held, result);
  if (!proof.ok) {
    markResilience("stale_rejected");
    return { ok: false as const, error: proof.error };
  }

  const has = Boolean(result.text || result.url);
  const decision = decisionFor(result.error, result.fault);
  const fault = decision.fault_domain || classifyError(result.error);

  if (typeof result.modelActual === "string") {
    const { getAdapter } = await import("./provider/index");
    const verdict = getAdapter(current.platform).verifyModel(current.model, result.modelActual);
    if (!verdict.ok && !(verdict.code === "MODEL_SELECTION_UNCONFIRMED" && process.env.RELAY_MODEL_UNCONFIRMED === "allow")) {
      const extra = {
        ...current,
        status: "error",
        error: `${verdict.code}: requested ${current.model} got ${result.modelActual || "(none)"}`,
        fault: "provider",
        errorCode: verdict.code,
        lease: undefined,
      };
      const applied = await dbFinishJobAtomic({
        jobId: id,
        leaseId: String(current.leaseId),
        fencingToken: Number(current.fencingToken),
        status: "error",
        error: extra.error,
        fault: "provider",
        extra: extra as unknown as Record<string, unknown>,
      });
      if (!applied) {
        markResilience("stale_rejected");
        return { ok: false as const, error: "STALE_LEASE: fencing mismatch" };
      }
      if (current.accountId) await coordCompareDel(`account-lease:${current.accountId}`, current.id);
      await coordDel(`job-claim:${id}`);
      return { ok: false as const, error: extra.error };
    }
  }

  let url = result.url;
  if (current.platform === "gemini" && result.ok) {
    const { assertGeneratedImage } = await import("./provider/index");
    const gate = assertGeneratedImage(url, { allowSvg: process.env.RELAY_ALLOW_MOCK === "1" });
    if (!gate.ok) {
      result = { ...result, ok: false, error: gate.error };
    } else {
      url = gate.url;
    }
  }
  if (url && result.ok && current.platform === "gemini") {
    const stored = await persistImageUrl(url);
    if (stored.ok) url = stored.url;
    else result = { ...result, ok: false, error: `IMAGE_NOT_FOUND: media store ${stored.error}` };
  }

  const status = result.ok && has ? "done" : "error";
  const extra = {
    ...current,
    status,
    text: result.text,
    url,
    error: result.error,
    fault,
    errorCode: decision.code,
    lease: undefined,
  };
  const applied = await dbFinishJobAtomic({
    jobId: id,
    leaseId: String(current.leaseId),
    fencingToken: Number(current.fencingToken),
    status,
    text: result.text,
    url,
    error: result.error,
    fault,
    extra: extra as unknown as Record<string, unknown>,
  });
  if (!applied) {
    markResilience("stale_rejected");
    return { ok: false as const, error: "STALE_LEASE: fencing mismatch or job not running" };
  }

  if (current.accountId) {
    await coordCompareDel(`account-lease:${current.accountId}`, current.id).catch(() => coordDel(`account-lease:${current.accountId}`));
    await dbUnlockAccount(current.accountId).catch(() => undefined);
  }
  await coordDel(`job-claim:${id}`);

  if (current.attemptId) {
    await finishAttempt(current.attemptId, {
      ok: Boolean(result.ok && has),
      errorCode: decision.code,
      faultDomain: fault,
      result: { text: result.text, url },
      workerId: result.workerId,
      leaseId: result.leaseId,
      fencingToken: result.fencingToken,
    });
  }
  if (result.sessionState && current.accountId) {
    const accForSession = (await readControlPlane()).accounts.find((a) => a.id === current.accountId);
    const { applySessionUpdate } = await import("./provider/index");
    const base = result.sessionBaseVersion ?? Math.max(0, (result.sessionVersion || 1) - 1);
    const next = result.sessionVersion || base + 1;
    const decided = applySessionUpdate(
      { id: current.accountId, platform: current.platform, sessionVersion: accForSession?.sessionVersion || 0 },
      {
        accountId: current.accountId,
        baseVersion: base,
        nextVersion: next,
        stateJson: JSON.stringify(result.sessionState),
      },
    );
    if (decided.ok) {
      await writeSessionFile(current.accountId, JSON.stringify(result.sessionState));
      await patchAccount(current.accountId, {
        sessionVersion: decided.sessionVersion,
        lastRefreshAt: decided.lastRefreshAt,
        lastValidatedAt: decided.lastRefreshAt,
      } as never);
    }
  }
  if (current.accountId) {
    const plane = await readControlPlane();
    const acc = plane.accounts.find((a) => a.id === current.accountId);
    const threshold = plane.settings.failThreshold || 5;
    const cool = (plane.settings.coolDownSeconds || 300) * 1000;
    if (acc) {
      if (result.ok && has) {
        if (isCanaryAccount(acc)) await recordCanaryResult(current.platform, true);
        await patchAccount(acc.id, {
          failCount: 0,
          totalRequests: (acc.totalRequests || 0) + 1,
          lastUsedAt: new Date().toISOString(),
          lastError: null,
          lockedUntil: null,
          status: "healthy",
        });
        markResilience("success");
      } else if (decision.provider_circuit_effect === "trip") {
        if (isCanaryAccount(acc)) await recordCanaryResult(current.platform, false);
        else await recordProviderFault(current.platform, decision.code, acc.id);
        await patchAccount(acc.id, {
          totalRequests: (acc.totalRequests || 0) + 1,
          lastUsedAt: new Date().toISOString(),
          lastError: result.error || decision.code,
          lockedUntil: null,
        });
        markResilience("provider_circuit_open");
      } else if (decision.account_health_effect !== "none") {
        const failCount = (acc.failCount || 0) + 1;
        const banned = decision.account_health_effect === "banned";
        const invalid = decision.account_health_effect === "invalid";
        const coolNow = decision.account_health_effect === "cool" || failCount >= threshold;
        await patchAccount(acc.id, {
          failCount,
          totalRequests: (acc.totalRequests || 0) + 1,
          lastUsedAt: new Date().toISOString(),
          lastError: result.error || "任务失败",
          lockedUntil: coolNow ? new Date(Date.now() + cool).toISOString() : null,
          status: banned ? "banned" : invalid ? "invalid" : coolNow ? "cooling" : acc.status,
        });
        markResilience("failover");
      } else {
        await patchAccount(acc.id, {
          totalRequests: (acc.totalRequests || 0) + 1,
          lastUsedAt: new Date().toISOString(),
          lastError: result.error || "infra",
          lockedUntil: null,
        });
      }
    }
  }
  if (result.ok && has) publishJobEvent(id, { type: "done", text: result.text, url });
  else publishJobEvent(id, { type: "error", error: result.error || "任务失败" });
  clearJobEvents(id);
  return { ok: true as const };
}

export async function cancelJobPg(id: string, error: string) {
  const current = asJob(await dbGetJob(id));
  if (!current) return { ok: false as const };
  if (current.status === "done") return { ok: true as const };
  const plane = await readControlPlane();
  const maxRetry = plane.settings.maxRetry || 3;
  if (current.accountId) {
    await coordDel(`account-lease:${current.accountId}`);
    await dbUnlockAccount(current.accountId).catch(() => undefined);
  }
  await coordDel(`job-claim:${id}`);
  const abandon = /TIMEOUT: wait deadline|REQUEST_CANCELLED|客户端断开/.test(error);
  let next: Job;
  if ((current.attempts || 0) < maxRetry && current.status === "running" && !abandon) {
    next = { ...current, status: "queued", error, fault: "infra", lease: undefined };
  } else {
    next = {
      ...current,
      status: "cancelled",
      error,
      fault: error.includes("REQUEST_CANCELLED") ? "client" : "infra",
      errorCode: error.includes("REQUEST_CANCELLED") ? "REQUEST_CANCELLED" : normalizeError(error),
    };
  }
  await dbCancelJobAtomic(id, next as unknown as Record<string, unknown>);
  return { ok: true as const };
}

export async function getJobPg(id: string) {
  await reclaimAll();
  return asJob(await dbGetJob(id));
}

export async function listJobsPg(): Promise<{ jobs: Job[]; workers: WorkerRow[] }> {
  await reclaimAll();
  const jobs = ((await dbLoadJobs()) || []) as unknown as Job[];
  const workers = ((await dbLoadWorkers()) || []) as unknown as WorkerRow[];
  return { jobs, workers };
}

export async function liveWorkerOnlinePg() {
  const workers = ((await dbLoadWorkers()) || []) as unknown as WorkerRow[];
  const now = Date.now();
  return workers.some(
    (w) => w.name !== "preview" && !w.name.startsWith("test") && !w.draining && now - Date.parse(w.lastBeat) < 45_000,
  );
}

export async function beatWorkerPg(
  name: string,
  stats?: { capacity?: number; activeJobs?: number; cpu?: number; ram?: number; browsers?: number; draining?: boolean; browserStartMs?: number },
) {
  const now = new Date().toISOString();
  await dbUpsertWorker({
    name,
    lastBeat: now,
    capacity: stats?.capacity,
    activeJobs: stats?.activeJobs,
    cpu: stats?.cpu,
    ram: stats?.ram,
    browsers: stats?.browsers,
    draining: stats?.draining,
  });
  await coordSet(`hb:worker:${name}`, String(Date.now()), 20_000);
  return { ok: true as const };
}

export async function renewLeasePg(jobId: string, leaseId: string, ttlMs: number) {
  return coordCompareExpireSafe(jobId, leaseId, ttlMs);
}

async function coordCompareExpireSafe(jobId: string, leaseId: string, ttlMs: number) {
  const { coordCompareExpire } = await import("./coord");
  return coordCompareExpire(`lease:${jobId}`, JSON.stringify({ leaseId }), ttlMs).catch(() =>
    coordCompareExpire(`account-lease:${jobId}`, jobId, ttlMs),
  );
}
