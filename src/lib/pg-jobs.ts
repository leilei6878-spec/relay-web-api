import { observeBrowser } from "./browser-baseline";
import { isCanaryAccount } from "./canary";
import { canDispatch, recordCanaryResult, recordProviderFault } from "./circuit";
import { readSessionJson, writeSessionFile } from "./chatgpt-runner";
import { patchAccount, pickAccount, readControlPlane } from "./control-plane";
import { coordDel, coordGet, coordSet, coordSetNx, releaseJobLeases } from "./coord";
import { classifyError, decisionFor, normalizeError } from "./faults";
import { clearJobEvents, publishJobEvent } from "./job-events";
import { assertLease, issueLease, type Lease } from "./leases";
import { persistImageUrl, persistImageUrls } from "./objects";
import type { EnqueueOpts, Job, JobTiming, WorkerRow } from "./job-queue";
import {
  dbCancelJobAtomic,
  dbCheckpointJobAtomic,
  dbClaimJob,
  dbFinishJobAtomic,
  dbGetJob,
  dbGetJobByIdempotency,
  dbInsertJobIdempotent,
  dbListQueuedJobs,
  dbLoadJobs,
  dbLoadWorkers,
  dbQueueCounts,
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
import { isWebModelAlias } from "./provider/chatgpt";
import { activeSelectorPack } from "./selector-promotion";
import { processStructuralCanaryResult } from "./canary-result";
import { queueCapability, withQueueAdmission } from "./queue-admission";
import {
  applySubmissionCheckpoint,
  recoveryDisposition,
  resetSubmissionForRetry,
  type SubmissionCheckpoint,
} from "./job-recovery";

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
    if (accountId && j.status === "queued") {
      await coordSet(`account-lease:${accountId}`, id, Number(j.timeoutMs || 90_000));
    } else if (accountId) {
      await coordDel(`account-lease:${accountId}`);
      await dbUnlockAccount(accountId).catch(() => undefined);
      await patchAccount(accountId, { lockedUntil: null }).catch(() => undefined);
    }
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
  const targetAccount = opts.targetAccountId
    ? (await readControlPlane()).accounts.find((item) => item.id === opts.targetAccountId && item.platform === platform) || null
    : null;
  let account = opts.targetAccountId
    ? opts.allowUnhealthyTarget
      ? targetAccount
      : null
    : await pickAccount(platform, exclude, { model });
  const until = new Date(Date.now() + timeoutMs).toISOString();
  while (account) {
    const allowed = opts.kind === "inspection" || await canDispatch(platform, isCanaryAccount(account));
    if (!allowed) {
      if (opts.idempotencyKey) await coordDel(`idem:${opts.idempotencyKey}`);
      return { ok: false as const, error: `PROVIDER circuit OPEN for ${platform}; refusing to consume the account pool` };
    }
    const redisOk = await coordSetNx(`account-lease:${account.id}`, "pending", timeoutMs);
    const sqlOk = redisOk ? await dbTryLockAccount(account.id, until) : false;
    if (redisOk && sqlOk) break;
    if (redisOk) await coordDel(`account-lease:${account.id}`);
    if (opts.targetAccountId) {
      account = null;
    } else {
      exclude.push(account.id);
      account = await pickAccount(platform, exclude, { model });
    }
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
    images: images.slice(0, platform === "leonardo" ? 6 : 4),
    referenceAssets: opts.referenceAssets?.slice(0, platform === "leonardo" ? 6 : 4),
    historicalHashes: account.recentResultHashes?.slice(-64) || [],
    attempts: 0,
    requestId: opts.requestId || uid(),
    traceId: opts.traceId || uid(),
    idempotencyKey: opts.idempotencyKey,
    keyId: opts.keyId,
    excludeAccountIds: exclude,
    proxyId: account.proxyId || undefined,
    kind: opts.kind,
    inspectionId: opts.inspectionId,
    turns: opts.turns,
    selectorPackVersion:
      opts.kind === "canary" && opts.selectorPackVersion
        ? opts.selectorPackVersion
        : await activeSelectorPack(platform),
    requestedModel: model,
    n: opts.n,
    size: opts.size,
    quality: opts.quality,
    aspect: opts.aspect,
    tier: opts.tier,
    backendMode: platform === "leonardo" ? "web_account" : undefined,
  };

  const admission = await withQueueAdmission({
    platform,
    hasKey: Boolean(opts.keyId),
    bypass: opts.kind === "canary",
    readCounts: () => dbQueueCounts(platform, queueCapability(platform), opts.keyId),
    insert: () => dbInsertJobIdempotent(job as unknown as Record<string, unknown>),
  });
  if (admission.error || !admission.inserted) {
    await coordDel(`account-lease:${account.id}`);
    await dbUnlockAccount(account.id).catch(() => undefined);
    if (opts.idempotencyKey) await coordDel(`idem:${opts.idempotencyKey}`);
    return { ok: false as const, error: admission.error || "QUEUE_FULL: 503 admission failed retry_after=5" };
  }
  const inserted = admission.inserted;
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
  const boundId = job.proxyId || acc?.proxyId;
  const bound = boundId ? plane.proxies.find((p) => p.id === boundId) : null;
  const password = bound ? (await getSecret(proxySecretKey(bound.id))) || "" : "";
  const proxy = bound
    ? {
        id: bound.id,
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
    kind: job.kind || (job.platform === "gemini" || job.platform === "leonardo" ? "image" : "chat"),
  };
}

export async function finishJobPg(
  id: string,
  result: {
    ok: boolean;
    text?: string;
    url?: string;
    urls?: string[];
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
    fingerprint?: import("./provider/types").WorkerFingerprint;
    selectorPackVersion?: string;
    timing?: JobTiming;
    actualProfile?: string;
    profileVerified?: boolean;
    recoveryLevel?: number;
    availableModels?: string[];
    tokenState?: string;
    backendMode?: "web_account" | "official_api";
    queueDepth?: number;
    retrySafety?: "SAFE" | "UNSAFE" | "UNKNOWN";
    submissionState?: string;
    resultConfidences?: import("./provider/generation-boundary").ResultConfidence[];
    resultAssets?: import("./image-asset").ImageAssetRecord[];
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

  const has = Boolean(result.text || result.url || (result.urls && result.urls.length));
  const decision = decisionFor(result.error, result.fault);
  const fault = decision.fault_domain || classifyError(result.error);
  if (result.timing) current.timing = result.timing;
  if (result.actualProfile) current.actualProfile = result.actualProfile;
  if (typeof result.profileVerified === "boolean") current.profileVerified = result.profileVerified;
  if (typeof result.recoveryLevel === "number") current.recoveryLevel = result.recoveryLevel;
  if (result.retrySafety) current.retrySafety = result.retrySafety;
  if (result.submissionState) current.submissionState = result.submissionState;
  if (result.fingerprint) current.fingerprint = result.fingerprint;

  if (result.ok && (current.platform === "chatgpt" || typeof result.modelActual === "string")) {
    const { getAdapter } = await import("./provider/index");
    const modelLabel = typeof result.modelActual === "string" ? result.modelActual : "";
    const verdict = getAdapter(current.platform).verifyModel(current.model, modelLabel);
    current.actualModelLabel = modelLabel || undefined;
    current.actualModel = verdict.ok ? verdict.actual : "unknown";
    current.modelVerified = verdict.ok;
    const allowUnconfirmed =
      !verdict.ok &&
      verdict.code === "MODEL_SELECTION_UNCONFIRMED" &&
      (isWebModelAlias(current.model) || process.env.RELAY_MODEL_UNCONFIRMED === "allow");
    if (!verdict.ok && !allowUnconfirmed) {
      const extra = {
        ...current,
        status: "error",
        error: `${verdict.code}: requested ${current.model} got ${modelLabel || "(none)"}`,
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
      if (current.accountId) {
        await releaseJobLeases(id, current.accountId, current.workerName || current.workerId);
        await dbUnlockAccount(current.accountId).catch(() => undefined);
        await patchAccount(current.accountId, { lockedUntil: null }).catch(() => undefined);
      }
      await coordDel(`job-claim:${id}`);
      return { ok: false as const, error: extra.error };
    }
  }

  const rawUrls = (Array.isArray(result.urls) ? result.urls : []).filter((u) => typeof u === "string" && u);
  if (result.url && !rawUrls.includes(result.url)) rawUrls.unshift(result.url);
  let url = result.url;
  let urls = rawUrls;
  if ((current.platform === "gemini" || current.platform === "leonardo") && result.ok && current.kind !== "canary" && current.kind !== "inspection" && result.text !== "CANARY") {
    const { validateJobImageUrls } = await import("./provider/image-result-validator");
    const { describeDataUrl } = await import("./provider/reference-verify");
    const pending = urls.length ? urls : url ? [url] : [];
    const refHashes = current.referenceAssets?.length
      ? current.referenceAssets.map((asset) => asset.sha256)
      : (current.images || [])
          .map((u) => describeDataUrl(u)?.sha256)
          .filter((x): x is string => Boolean(x));
    const report = await validateJobImageUrls(pending, {
      n: current.n || 1,
      model: current.model,
      size: current.size,
      aspect: current.aspect,
      tier: current.tier,
      referenceHashes: refHashes,
      historicalHashes: current.historicalHashes || [],
      confidences: result.resultConfidences,
      requireConfidence: true,
    });
    if (!report.ok) {
      result = { ...result, ok: false, error: report.error };
    } else if (report.results[0]) {
      const metadataMismatch = report.results.some((item, index) => {
        const supplied = result.resultAssets?.[index];
        return Boolean(
          supplied &&
            (supplied.sha256 !== item.sha256 ||
              supplied.mime !== item.mime ||
              supplied.bytes !== item.bytes ||
              supplied.width !== item.width ||
              supplied.height !== item.height ||
              supplied.confidence !== item.confidence),
        );
      });
      if (metadataMismatch) {
        result = { ...result, ok: false, error: "IMAGE_NOT_FOUND: worker asset metadata mismatch" };
      }
      current.requestedSize = report.results[0].requestedSize;
      current.actualWidth = report.results[0].width;
      current.actualHeight = report.results[0].height;
      current.actualAspect = report.results[0].actualAspect;
      current.requestedTier = report.results[0].requestedTier;
      current.actualTier = report.results[0].actualTier;
      current.resultHashes = report.results.map((item) => item.sha256);
      current.resultConfidences = report.results.map((item) => item.confidence);
      current.resultAssets = report.results.map((item, index) => ({
        assetId:
          result.resultAssets?.[index]?.assetId ||
          (urls[index]?.match(/\/api\/media\/([^/?#]+)/)?.[1] ?? ""),
        url: urls[index] || "",
        sha256: item.sha256,
        mime: item.mime,
        bytes: item.bytes,
        width: item.width,
        height: item.height,
        confidence: item.confidence,
      }));
    }
  }
  if (urls.length && result.ok && (current.platform === "gemini" || current.platform === "leonardo") && current.kind !== "inspection") {
    const needsPersist = urls.some((u) => u.startsWith("data:"));
    if (needsPersist) {
      const stored = await persistImageUrls(urls);
      if (stored.ok) {
        urls = stored.urls;
        url = stored.urls[0];
      } else result = { ...result, ok: false, error: `IMAGE_NOT_FOUND: media store ${stored.error}` };
    }
  }

  const status = result.ok && has ? "done" : "error";
  const extra = {
    ...current,
    status,
    text: result.text,
    url,
    urls,
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

  if (current.kind === "canary") {
    const { getAdapter } = await import("./provider/index");
    await processStructuralCanaryResult({
      provider: current.platform,
      selectorPackVersion: current.selectorPackVersion || getAdapter(current.platform).selectorPack().version,
      ok: Boolean(result.ok && has && !result.error),
      error: result.error,
      errorCode: decision.code,
      fingerprint: result.fingerprint,
    });
  }

  if (current.accountId) {
    await releaseJobLeases(id, current.accountId, current.workerName || current.workerId);
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
      await writeSessionFile(current.accountId, JSON.stringify(result.sessionState), current.platform);
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
      const capabilityPatch: Record<string, unknown> = {};
      if (Array.isArray(result.availableModels) && result.availableModels.length) {
        capabilityPatch.availableModels = result.availableModels;
      }
      if (result.tokenState === "TOKEN_EXHAUSTED" || decision.code === "LEONARDO_TOKEN_EXHAUSTED") {
        capabilityPatch.tokenState = "TOKEN_EXHAUSTED";
      } else if (result.tokenState === "TOKEN_AVAILABLE" || result.tokenState === "TOKEN_LOW" || result.tokenState === "UNKNOWN") {
        capabilityPatch.tokenState = result.tokenState;
      }
      if (result.pageState) capabilityPatch.lastPageState = result.pageState;
      if (typeof result.queueDepth === "number") capabilityPatch.queueDepthHint = result.queueDepth;
      if (Object.keys(capabilityPatch).length) {
        await patchAccount(acc.id, capabilityPatch as never);
      }
      if (current.kind === "inspection") {
        await patchAccount(acc.id, {
          lockedUntil: null,
          inspectionId: null,
          lastError: result.ok ? null : result.error || "登录态查看异常结束",
        });
      } else if (result.ok && has) {
        if (current.kind !== "canary" && isCanaryAccount(acc)) await recordCanaryResult(current.platform, true);
        await patchAccount(acc.id, {
          failCount: 0,
          totalRequests: (acc.totalRequests || 0) + 1,
          lastUsedAt: new Date().toISOString(),
          lastError: null,
          lockedUntil: null,
          status: "healthy",
          recentResultHashes: [
            ...(acc.recentResultHashes || []),
            ...(current.resultHashes || []),
          ].slice(-64),
        });
        markResilience("success");
      } else if (decision.provider_circuit_effect === "trip") {
        if (current.kind !== "canary") {
          if (isCanaryAccount(acc)) await recordCanaryResult(current.platform, false);
          else await recordProviderFault(current.platform, decision.code, acc.id);
        }
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

export async function checkpointJobPg(
  id: string,
  checkpoint: SubmissionCheckpoint & {
    leaseId?: string;
    fencingToken?: number;
    attemptId?: string;
    workerId?: string;
  },
) {
  const current = asJob(await dbGetJob(id));
  if (!current) return { ok: false as const, error: "任务不存在" };
  if (current.status !== "running") {
    return { ok: false as const, error: "STALE_LEASE: job is not running" };
  }
  const held: Lease = current.lease || {
    leaseId: current.leaseId || "",
    fencingToken: current.fencingToken || 0,
    attemptId: current.attemptId || "",
    workerId: current.workerId || current.workerName || "",
    jobId: current.id,
  };
  const proof = assertLease(held, checkpoint);
  if (!proof.ok) return { ok: false as const, error: proof.error };
  const next = applySubmissionCheckpoint(current, checkpoint);
  const applied = await dbCheckpointJobAtomic({
    jobId: id,
    leaseId: held.leaseId,
    fencingToken: held.fencingToken,
    submissionRank: next.submissionRank,
    retrySafetyRank: next.retrySafetyRank,
    extra: next as unknown as Record<string, unknown>,
  });
  if (!applied) return { ok: false as const, error: "STALE_LEASE: checkpoint race" };
  return {
    ok: true as const,
    submissionState: next.submissionState,
    retrySafety: next.retrySafety,
  };
}

export async function cancelJobPg(id: string, error: string) {
  const current = asJob(await dbGetJob(id));
  if (!current) return { ok: false as const };
  if (current.status === "done") return { ok: true as const };
  const plane = await readControlPlane();
  const maxRetry = plane.settings.maxRetry || 3;
  const abandon = /TIMEOUT: wait deadline|REQUEST_CANCELLED|客户端断开/.test(error);
  const disposition = recoveryDisposition(current, maxRetry);
  if (current.status === "running" && disposition === "uncertain") {
    return { ok: true as const, retained: true as const, status: current.status };
  }
  let next: Job;
  if (disposition === "requeue" && current.status === "running" && !abandon) {
    next = resetSubmissionForRetry({
      ...current,
      status: "queued",
      error,
      fault: "infra",
      lease: undefined,
      leaseId: undefined,
      attemptId: undefined,
      workerId: undefined,
      workerName: undefined,
      startedAt: undefined,
    });
  } else {
    next = {
      ...current,
      status: "cancelled",
      error,
      fault: error.includes("REQUEST_CANCELLED") ? "client" : "infra",
      errorCode: error.includes("REQUEST_CANCELLED") ? "REQUEST_CANCELLED" : normalizeError(error),
      lease: undefined,
    };
  }
  const applied = await dbCancelJobAtomic({
    jobId: id,
    extra: next as unknown as Record<string, unknown>,
    expectedStatus: current.status === "running" ? "running" : "queued",
    leaseId: current.leaseId,
    fencingToken: current.fencingToken,
  });
  if (!applied) return { ok: false as const, error: "STALE_LEASE: cancel race" };
  await coordDel(`job-claim:${id}`);
  if (current.accountId && next.status === "queued") {
    await coordSet(`account-lease:${current.accountId}`, id, current.timeoutMs || 90_000);
  } else if (current.accountId) {
    await coordDel(`account-lease:${current.accountId}`);
    await dbUnlockAccount(current.accountId).catch(() => undefined);
    await patchAccount(current.accountId, { lockedUntil: null }).catch(() => undefined);
  }
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
