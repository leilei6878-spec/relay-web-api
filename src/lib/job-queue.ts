import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { observeBrowser } from "./browser-baseline";
import { isCanaryAccount } from "./canary";
import { canDispatch, recordCanaryResult, recordProviderFault } from "./circuit";
import { readSessionJson, writeSessionFile } from "./chatgpt-runner";
import { patchAccount, pickAccount, readControlPlane } from "./control-plane";
import { coordDel, coordGet, coordIncr, coordSet, coordSetNx, releaseJobLeases } from "./coord";
import { poolUnavailableMessage } from "./eligibility";
import { classifyError, decisionFor, normalizeError, type FaultClass } from "./faults";
import { clearJobEvents, publishJobEvent } from "./job-events";
import { assertLease, issueLease, type Lease } from "./leases";
import { persistImageUrl } from "./objects";
import { jsonAllowedFor, persistenceMode, pgSotActive } from "./persist-mode";
import { addAttempt, finishAttempt } from "./requests";
import { getSecret, proxySecretKey } from "./secrets";
import { proxyServer } from "./session-file";
import { uid } from "./utils";
import { applySessionUpdate, getAdapter, assertGeneratedImage } from "./provider/index";
import type { ChatTurn } from "./provider/types";

export type Job = {
  id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled" | "dead";
  platform: "chatgpt" | "gemini" | "leonardo";
  prompt: string;
  model: string;
  accountId: string | null;
  accountEmail: string;
  createdAt: string;
  timeoutMs: number;
  images?: string[];
  attempts?: number;
  startedAt?: string;
  workerName?: string;
  requestId?: string;
  traceId?: string;
  idempotencyKey?: string;
  attemptId?: string;
  leaseId?: string;
  fencingToken?: number;
  workerId?: string;
  proxyId?: string;
  fault?: FaultClass;
  errorCode?: string;
  excludeAccountIds?: string[];
  text?: string;
  url?: string;
  error?: string;
  lease?: Lease;
  kind?: "chat" | "image" | "edit" | "canary";
  turns?: ChatTurn[];
  selectorPackVersion?: string;
  pageState?: string;
  requestedModel?: string;
  actualModel?: string;
  timing?: Record<string, unknown>;
  actualProfile?: string;
  profileVerified?: boolean;
  recoveryLevel?: number;
  n?: number;
  size?: string;
  quality?: string;
  backendMode?: "web_account" | "official_api";
};

export type EnqueueOpts = {
  idempotencyKey?: string;
  requestId?: string;
  traceId?: string;
  excludeAccountIds?: string[];
  kind?: Job["kind"];
  turns?: ChatTurn[];
  selectorPackVersion?: string;
  n?: number;
  size?: string;
  quality?: string;
};

export type WorkerRow = {
  id: string;
  lastBeat: string;
  name: string;
  capacity?: number;
  activeJobs?: number;
  cpu?: number;
  ram?: number;
  browsers?: number;
  draining?: boolean;
  browserStartMs?: number;
};

type Store = { jobs: Job[]; workers: WorkerRow[] };

function jobsFile() {
  return resolve(process.env.RELAY_STORAGE_DIR || "storage", "jobs.json");
}

let chain: Promise<unknown> = Promise.resolve();
let memStore: Store = { jobs: [], workers: [] };
let fileWrites = 0;

export function fileWriteCount() {
  return fileWrites;
}

export function resetJobStoreForTests() {
  memStore = { jobs: [], workers: [] };
  fileWrites = 0;
  chain = Promise.resolve();
}

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function workerDeadMs() {
  return Number(process.env.RELAY_WORKER_DEAD_MS || 60_000);
}

function claimGraceMs() {
  return Number(process.env.RELAY_CLAIM_GRACE_MS || 45_000);
}

async function persist(store: Store) {
  if (persistenceMode() === "postgres") {
    if (process.env.RELAY_SKIP_DB === "1") {
      memStore = { jobs: store.jobs.slice(), workers: store.workers.slice() };
      return;
    }
    const { dbUpsertJob, dbUpsertWorker, safeDb } = await import("./relay-db");
    await Promise.all(store.jobs.slice(0, 80).map((j) => safeDb(() => dbUpsertJob(j as unknown as Record<string, unknown>))));
    await Promise.all(
      store.workers.map((w) =>
        safeDb(() =>
          dbUpsertWorker({
            name: w.name,
            lastBeat: w.lastBeat,
            capacity: w.capacity,
            activeJobs: w.activeJobs,
            cpu: w.cpu,
            ram: w.ram,
            browsers: w.browsers,
            draining: w.draining,
          }),
        ),
      ),
    );
    return;
  }
  await mkdir(resolve(process.env.RELAY_STORAGE_DIR || "storage"), { recursive: true });
  fileWrites += 1;
  await writeFile(jobsFile(), JSON.stringify(store), "utf8");
  if (process.env.RELAY_SKIP_DB === "1") return;
  const { dbUpsertJob, safeDb } = await import("./relay-db");
  await Promise.all(store.jobs.slice(0, 80).map((j) => safeDb(() => dbUpsertJob(j as unknown as Record<string, unknown>))));
}

async function reclaim(store: Store): Promise<Store> {
  const now = Date.now();
  const plane = await readControlPlane();
  const maxRetry = plane.settings.maxRetry || 3;
  const deadMs = workerDeadMs();
  const graceMs = claimGraceMs();
  for (const job of store.jobs) {
    if (job.status === "queued") {
      if (now - Date.parse(job.createdAt) > (job.timeoutMs || 90_000) + 8_000) {
        job.status = "error";
        job.error = "任务过期";
        job.fault = "infra";
        job.errorCode = "GENERATION_TIMEOUT";
      }
      continue;
    }
    if (job.status !== "running") continue;
    const start = Date.parse(job.startedAt || job.createdAt);
    const timedOut = now - start > (job.timeoutMs || 90_000) + 8_000;
    const worker = job.workerName ? store.workers.find((w) => w.name === job.workerName) : null;
    const grace = now - start < graceMs;
    let hbFresh = false;
    if (job.workerName) {
      const hb = await coordGet(`hb:worker:${job.workerName}`);
      const ts = Number(hb);
      hbFresh = Number.isFinite(ts) ? now - ts < deadMs : Boolean(hb);
    }
    const workerDead = !grace && !hbFresh && (!worker || now - Date.parse(worker.lastBeat) > deadMs);
    if (!timedOut && !workerDead) continue;
    if (job.accountId) await coordDel(`account-lease:${job.accountId}`);
    if (job.id) await coordDel(`job-claim:${job.id}`);
    const attempts = job.attempts || 1;
    if (attempts < maxRetry) {
      job.status = "queued";
      job.error = workerDead ? "WORKER_CRASH: 执行器掉线，已回队" : "WORKER_TIMEOUT: 已回队";
      job.fault = workerDead ? "worker" : "infra";
      job.errorCode = workerDead ? "WORKER_CRASH" : "WORKER_TIMEOUT";
      job.workerName = undefined;
      job.startedAt = undefined;
      job.lease = undefined;
    } else {
      job.status = "dead";
      job.error = timedOut ? "WORKER_TIMEOUT: dead-letter" : "WORKER_CRASH: dead-letter";
      job.fault = workerDead ? "worker" : "infra";
      job.errorCode = timedOut ? "WORKER_TIMEOUT" : "WORKER_CRASH";
    }
  }
  return store;
}

async function load(): Promise<Store> {
  if (persistenceMode() === "postgres") {
    if (process.env.RELAY_SKIP_DB === "1") return reclaim({ jobs: memStore.jobs.slice(), workers: memStore.workers.slice() });
    const mod = await import("./relay-db");
    const fromDb = await mod.safeDb(() => mod.dbLoadJobs());
    const workers = (await mod.safeDb(() => mod.dbLoadWorkers())) || [];
    const store: Store = {
      jobs: (fromDb as unknown as Job[]) || [],
      workers: workers as unknown as WorkerRow[],
    };
    return reclaim(store);
  }
  let store: Store;
  try {
    store = JSON.parse(await readFile(jobsFile(), "utf8")) as Store;
  } catch {
    const fromDb = process.env.RELAY_SKIP_DB === "1" ? null : await (await import("./relay-db")).safeDb(() =>
      import("./relay-db").then((m) => m.dbLoadJobs()),
    );
    store = fromDb?.length ? { jobs: fromDb as unknown as Job[], workers: [] } : { jobs: [], workers: [] };
  }
  return reclaim(store);
}

async function save(store: Store) {
  await persist(store);
}

function isClientAbandon(error: string) {
  return /TIMEOUT: wait deadline|REQUEST_CANCELLED|客户端断开/.test(error);
}

async function releaseZombieAccountLease(accountId: string) {
  const store = await load();
  const job = store.jobs.find(
    (j) => j.accountId === accountId && (j.status === "running" || j.status === "queued"),
  );
  if (!job) {
    await coordDel(`account-lease:${accountId}`);
    return true;
  }
  const age = Date.now() - Date.parse(job.startedAt || job.createdAt);
  const zombie =
    isClientAbandon(job.error || "") ||
    job.status === "cancelled" ||
    age > (job.timeoutMs || 90_000) + 8_000;
  if (!zombie) return false;
  job.status = "cancelled";
  job.error = job.error || "TIMEOUT: wait deadline";
  job.fault = "infra";
  job.errorCode = "GENERATION_TIMEOUT";
  job.lease = undefined;
  await coordDel(`account-lease:${accountId}`);
  await coordDel(`job-claim:${job.id}`);
  await save(store);
  await patchAccount(accountId, { lockedUntil: null }).catch(() => undefined);
  return true;
}

async function unavailableMessage(platform: Job["platform"], extra: Record<string, string> = {}) {
  const plane = await readControlPlane();
  for (const a of plane.accounts.filter((x) => x.platform === platform)) {
    if (extra[a.id]) continue;
    if (await coordGet(`account-lease:${a.id}`)) extra[a.id] = "正在执行其他任务，请稍候再测";
  }
  return poolUnavailableMessage(platform, plane.accounts, plane.proxies, plane.settings, extra);
}

async function enqueue(
  platform: Job["platform"],
  prompt: string,
  model: string,
  timeoutMs: number,
  images: string[] = [],
  opts: EnqueueOpts = {},
) {
  return locked(async () => {
    if (opts.idempotencyKey) {
      const idemKey = `idem:${opts.idempotencyKey}`;
      const holder = "__pending__";
      const won = await coordSetNx(idemKey, holder, 86_400_000);
      if (!won) {
        const store = await load();
        const existingId = await import("./coord").then((m) => m.coordGet(idemKey));
        const hit = store.jobs.find(
          (j) => j.idempotencyKey === opts.idempotencyKey || (existingId && existingId !== holder && j.id === existingId),
        );
        if (hit && (hit.status === "queued" || hit.status === "running" || hit.status === "done")) {
          return { ok: true as const, job: hit, replay: true };
        }
        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 20));
          const id = await import("./coord").then((m) => m.coordGet(idemKey));
          const again = await load();
          const found = again.jobs.find(
            (j) => j.idempotencyKey === opts.idempotencyKey || (id && id !== holder && j.id === id),
          );
          if (found) return { ok: true as const, job: found, replay: true };
        }
      }
    }
    const exclude = [...(opts.excludeAccountIds || [])];
    let account = await pickAccount(platform, exclude, { model });
    while (account) {
      const allowed = await canDispatch(platform, isCanaryAccount(account));
      if (!allowed) {
        return {
          ok: false as const,
          error: `PROVIDER circuit OPEN for ${platform}; refusing to consume the account pool`,
        };
      }
      const lockedOk = await coordSetNx(`account-lease:${account.id}`, "pending", timeoutMs);
      if (!lockedOk) {
        const stolen = await releaseZombieAccountLease(account.id);
        if (stolen) {
          const retry = await coordSetNx(`account-lease:${account.id}`, "pending", timeoutMs);
          if (retry) break;
        }
        exclude.push(account.id);
        account = await pickAccount(platform, exclude, { model });
        continue;
      }
      break;
    }
    if (!account) {
      if (opts.idempotencyKey) await coordDel(`idem:${opts.idempotencyKey}`);
      return { ok: false as const, error: await unavailableMessage(platform) };
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
      n: opts.n,
      size: opts.size,
      quality: opts.quality,
      backendMode: platform === "leonardo" ? "web_account" : undefined,
    };
    if (opts.idempotencyKey) await coordSet(`idem:${opts.idempotencyKey}`, job.id, 86_400_000);
    await patchAccount(account.id, {
      lockedUntil: new Date(Date.now() + timeoutMs).toISOString(),
    });
    const store = await load();
    store.jobs.unshift(job);
    store.jobs = store.jobs.slice(0, 200);
    for (const old of store.jobs.slice(12)) delete old.images;
    await save(store);
    return { ok: true as const, job };
  });
}

export function enqueueChat(
  prompt: string,
  model = "gpt-5.6",
  timeoutMs = 90_000,
  images: string[] = [],
  opts?: EnqueueOpts,
) {
  if (pgSotActive()) {
    return import("./pg-jobs").then((m) => m.enqueuePg("chatgpt", prompt, model, timeoutMs, images, opts));
  }
  return enqueue("chatgpt", prompt, model, timeoutMs, images, opts);
}

export function enqueueImage(
  prompt: string,
  model = "gemini-image",
  timeoutMs = 90_000,
  images: string[] = [],
  opts?: EnqueueOpts,
) {
  const platform = model.startsWith("leonardo-") || model === "gpt-image-2" ? "leonardo" : "gemini";
  if (pgSotActive()) {
    return import("./pg-jobs").then((m) => m.enqueuePg(platform, prompt, model, timeoutMs, images, opts));
  }
  return enqueue(platform, prompt, model, timeoutMs, images, opts);
}

export function claimNext(workerName = "local", stats?: { capacity?: number; activeJobs?: number; cpu?: number; ram?: number; browsers?: number; draining?: boolean; browserStartMs?: number }) {
  if (pgSotActive()) {
    return import("./pg-jobs").then((m) => m.claimNextPg(workerName, stats));
  }
  return locked(async () => {
    const store = await load();
    let worker = store.workers.find((w) => w.name === workerName);
    if (!worker) {
      worker = { id: uid(), name: workerName, lastBeat: new Date().toISOString(), ...stats };
      store.workers.push(worker);
    } else {
      worker.lastBeat = new Date().toISOString();
      if (stats) Object.assign(worker, stats);
    }
    await coordSet(`hb:worker:${workerName}`, String(Date.now()), 20_000);
    if (stats?.browserStartMs || stats?.ram || stats?.cpu) {
      observeBrowser({
        startLatencyMs: stats.browserStartMs,
        ramMb: stats.ram,
        cpu: stats.cpu,
      });
    }
    if (worker.draining || stats?.draining) {
      await save(store);
      return { job: null as Job | null, storageState: null as unknown, proxy: null };
    }
    const plane = await readControlPlane();
    const cap = stats?.capacity || worker.capacity || plane.settings.concurrencyPerWorker || 3;
    const runningHere = store.jobs.filter((j) => j.status === "running" && j.workerName === workerName).length;
    if (runningHere >= cap) {
      await save(store);
      return { job: null as Job | null, storageState: null as unknown, proxy: null };
    }
    const testWorker = workerName === "preview" || workerName.startsWith("test");
    const busyAccounts = new Set(
      store.jobs.filter((j) => j.status === "running" && j.accountId).map((j) => j.accountId as string),
    );
    const queued = store.jobs.filter(
      (j) =>
        j.status === "queued" &&
        !(testWorker && j.platform === "chatgpt") &&
        !(j.accountId && busyAccounts.has(j.accountId)),
    );
    let job: Job | undefined;
    for (const candidate of queued) {
      const won = await coordSetNx(`job-claim:${candidate.id}`, workerName, candidate.timeoutMs || 90_000);
      if (!won) continue;
      job = candidate;
      break;
    }
    if (!job) {
      // Persist worker heartbeat only — never write a stale jobs snapshot that
      // could regress another process's running claim back to queued.
      const workersOnly: Store = { jobs: [], workers: store.workers };
      if (persistenceMode() === "postgres") {
        const { dbUpsertWorker, safeDb } = await import("./relay-db");
        const w = store.workers.find((row) => row.name === workerName);
        if (w) {
          await safeDb(() =>
            dbUpsertWorker({
              name: w.name,
              lastBeat: w.lastBeat,
              capacity: w.capacity,
              activeJobs: w.activeJobs,
              cpu: w.cpu,
              ram: w.ram,
              browsers: w.browsers,
              draining: w.draining,
            }),
          );
        }
      } else {
        void workersOnly;
        await save(store);
      }
      return { job: null as Job | null, storageState: null as unknown, proxy: null };
    }
    job.status = "running";
    job.attempts = (job.attempts || 0) + 1;
    job.startedAt = new Date().toISOString();
    job.workerName = workerName;
    const fence = await coordIncr(`job-fence:${job.id}`, 86_400_000);
    const lease = issueLease(job.id, workerName, Math.max(0, fence - 1));
    lease.fencingToken = fence;
    job.lease = lease;
    job.leaseId = lease.leaseId;
    job.fencingToken = lease.fencingToken;
    job.attemptId = lease.attemptId;
    job.workerId = workerName;
    await coordSet(`lease:${job.id}`, JSON.stringify(lease), job.timeoutMs || 90_000);
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
    await save(store);
    if (job.accountId) await coordSet(`account-lease:${job.accountId}`, job.id, job.timeoutMs || 90_000);
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
      selectors: getAdapter(job.platform).selectorPack(job.selectorPackVersion),
      selectorPackVersion: job.selectorPackVersion || getAdapter(job.platform).selectorPack().version,
      turns: job.turns || [],
      kind: job.kind || (job.platform === "gemini" ? "image" : "chat"),
    };
  });
}

export async function liveWorkerOnline() {
  if (pgSotActive()) {
    const m = await import("./pg-jobs");
    return m.liveWorkerOnlinePg();
  }
  const store = await load();
  const now = Date.now();
  return store.workers.some(
    (w) =>
      w.name !== "preview" &&
      !w.name.startsWith("test") &&
      !w.draining &&
      now - Date.parse(w.lastBeat) < 45_000,
  );
}

export function finishJob(
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
    timing?: Record<string, unknown>;
    actualProfile?: string;
    profileVerified?: boolean;
    recoveryLevel?: number;
    availableModels?: string[];
    tokenState?: string;
    backendMode?: "web_account" | "official_api";
    queueDepth?: number;
  },
) {
  if (pgSotActive()) {
    return import("./pg-jobs").then((m) => m.finishJobPg(id, result));
  }
  return locked(async () => {
    const store = await load();
    const job = store.jobs.find((j) => j.id === id);
    if (!job) return { ok: false as const, error: "任务不存在" };
    if (job.status === "done" || job.status === "error" || job.status === "cancelled" || job.status === "dead") {
      return { ok: false as const, error: "STALE_LEASE: job already terminal" };
    }
    const proof = assertLease(job.lease, result);
    if (!proof.ok) return { ok: false as const, error: proof.error };
    const has = Boolean(result.text || result.url);
    const decision = decisionFor(result.error, result.fault);
    const fault = decision.fault_domain || classifyError(result.error);
    if (result.timing) job.timing = result.timing;
    if (result.actualProfile) job.actualProfile = result.actualProfile;
    if (typeof result.profileVerified === "boolean") job.profileVerified = result.profileVerified;
    if (typeof result.recoveryLevel === "number") job.recoveryLevel = result.recoveryLevel;
    if (typeof result.modelActual === "string") {
      const verdict = getAdapter(job.platform).verifyModel(job.model, result.modelActual);
      job.actualModel = result.modelActual;
      job.requestedModel = job.model;
      if (!verdict.ok) {
        const allowUnconfirmed =
          verdict.code === "MODEL_SELECTION_UNCONFIRMED" && process.env.RELAY_MODEL_UNCONFIRMED === "allow";
        if (!allowUnconfirmed) {
          job.status = "error";
          job.error = `${verdict.code}: requested ${job.model} got ${result.modelActual || "(none)"}`;
          job.fault = "provider";
          job.errorCode = verdict.code;
          if (job.accountId) await coordDel(`account-lease:${job.accountId}`);
          await coordDel(`job-claim:${job.id}`);
          await save(store);
          publishJobEvent(id, { type: "error", error: job.error });
          return { ok: false as const, error: job.error };
        }
      }
    }
    let url = result.url;
    if ((job.platform === "gemini" || job.platform === "leonardo") && result.ok && job.kind !== "canary" && result.text !== "CANARY") {
      const gate = assertGeneratedImage(url, { allowSvg: process.env.RELAY_ALLOW_MOCK === "1" });
      if (!gate.ok) {
        result = { ...result, ok: false, error: gate.error };
      } else {
        url = gate.url;
      }
    }
    if (url && result.ok && (job.platform === "gemini" || job.platform === "leonardo") && job.kind !== "canary") {
      const stored = await persistImageUrl(url);
      if (stored.ok) url = stored.url;
      else {
        result = { ...result, ok: false, error: `IMAGE_NOT_FOUND: media store ${stored.error}` };
      }
    }
    job.status = result.ok && has && !result.error ? "done" : "error";
    job.text = result.text;
    job.url = url;
    job.error = result.error;
    job.fault = fault;
    job.errorCode = decision.code;
    job.pageState = result.pageState;
    job.selectorPackVersion = result.selectorPackVersion || job.selectorPackVersion;
    job.lease = undefined;
    await save(store);
    if (job.accountId) await releaseJobLeases(job.id, job.accountId, job.workerName || job.workerId);
    await coordDel(`job-claim:${job.id}`);
    if (job.attemptId) {
      await finishAttempt(job.attemptId, {
        ok: Boolean(result.ok && has),
        errorCode: decision.code,
        faultDomain: fault,
        result: { text: result.text, url },
        workerId: result.workerId,
        leaseId: result.leaseId,
        fencingToken: result.fencingToken,
      });
    }
    if (result.sessionState && job.accountId) {
      const accForSession = (await readControlPlane()).accounts.find((a) => a.id === job.accountId);
      const base = result.sessionBaseVersion ?? Math.max(0, (result.sessionVersion || 1) - 1);
      const next = result.sessionVersion || base + 1;
      const decided = applySessionUpdate(
        { id: job.accountId, platform: job.platform, sessionVersion: accForSession?.sessionVersion || 0 },
        { accountId: job.accountId, baseVersion: base, nextVersion: next, stateJson: JSON.stringify(result.sessionState) },
      );
      if (decided.ok) {
        await writeSessionFile(job.accountId, JSON.stringify(result.sessionState), job.platform);
        await patchAccount(job.accountId, {
          sessionVersion: decided.sessionVersion,
          lastRefreshAt: decided.lastRefreshAt,
          lastValidatedAt: decided.lastRefreshAt,
        } as never);
      }
    }
    if (job.accountId) {
      const plane = await readControlPlane();
      const acc = plane.accounts.find((a) => a.id === job.accountId);
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
        if (result.ok && has) {
          if (isCanaryAccount(acc) || job.kind === "canary") await recordCanaryResult(job.platform, true);
          await patchAccount(acc.id, {
            failCount: 0,
            totalRequests: (acc.totalRequests || 0) + 1,
            lastUsedAt: new Date().toISOString(),
            lastError: null,
            lockedUntil: null,
            status: "healthy",
          });
        } else if (decision.provider_circuit_effect === "trip") {
          if (isCanaryAccount(acc) || job.kind === "canary") await recordCanaryResult(job.platform, false);
          else await recordProviderFault(job.platform, decision.code, acc.id);
          await patchAccount(acc.id, {
            totalRequests: (acc.totalRequests || 0) + 1,
            lastUsedAt: new Date().toISOString(),
            lastError: result.error || decision.code,
            lockedUntil: null,
          });
        } else if (job.kind === "canary") {
          await recordCanaryResult(job.platform, false);
          await patchAccount(acc.id, {
            totalRequests: (acc.totalRequests || 0) + 1,
            lastUsedAt: new Date().toISOString(),
            lastError: result.error || "canary",
            lockedUntil: null,
          });
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
  });
}

export async function getJob(id: string) {
  if (pgSotActive()) {
    const m = await import("./pg-jobs");
    return m.getJobPg(id);
  }
  const store = await load();
  return store.jobs.find((j) => j.id === id) ?? null;
}

export function beatWorker(
  name: string,
  stats?: { capacity?: number; activeJobs?: number; cpu?: number; ram?: number; browsers?: number; draining?: boolean; browserStartMs?: number },
) {
  if (pgSotActive()) {
    return import("./pg-jobs").then((m) => m.beatWorkerPg(name, stats));
  }
  return locked(async () => {
    const store = await load();
    const row = store.workers.find((w) => w.name === name);
    const now = new Date().toISOString();
    if (row) {
      row.lastBeat = now;
      if (stats) Object.assign(row, stats);
    } else {
      store.workers.push({ id: uid(), name, lastBeat: now, ...stats });
    }
    await coordSet(`hb:worker:${name}`, String(Date.now()), 20_000);
    if (stats?.browserStartMs || stats?.ram || stats?.cpu) {
      observeBrowser({ startLatencyMs: stats.browserStartMs, ramMb: stats.ram, cpu: stats.cpu });
    }
    await save(store);
    if (process.env.RELAY_SKIP_DB !== "1" && jsonAllowedFor("scheduling")) {
      const { dbUpsertWorker, safeDb } = await import("./relay-db");
      const cur = store.workers.find((w) => w.name === name)!;
      await safeDb(() =>
        dbUpsertWorker({
          name,
          lastBeat: now,
          capacity: cur.capacity,
          activeJobs: cur.activeJobs,
          cpu: cur.cpu,
          ram: cur.ram,
          browsers: cur.browsers,
          draining: cur.draining,
        }),
      );
    }
    return { ok: true as const };
  });
}

export async function listJobs() {
  if (pgSotActive()) {
    const m = await import("./pg-jobs");
    return m.listJobsPg();
  }
  return load();
}

export async function waitJob(id: string, timeoutMs: number) {
  const queuedDeadline = Date.now() + timeoutMs + 20_000;
  while (Date.now() < queuedDeadline) {
    const job = await getJob(id);
    if (!job) return { ok: false as const, error: "任务丢失" };
    if (job.status === "done" && (job.text || job.url)) {
      return { ok: true as const, text: job.text, url: job.url, job };
    }
    if (job.status === "error" || job.status === "dead" || job.status === "cancelled") {
      return { ok: false as const, error: job.error || "任务失败", job };
    }
    if (job.status === "running" && job.startedAt) {
      const remain = Date.parse(job.startedAt) + (job.timeoutMs || timeoutMs) + 5_000 - Date.now();
      if (remain <= 0) break;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  await cancelJob(id, "TIMEOUT: wait deadline");
  return { ok: false as const, error: "TIMEOUT: wait deadline, job cancelled" };
}

export function cancelJob(id: string, error: string) {
  if (pgSotActive()) {
    return import("./pg-jobs").then((m) => m.cancelJobPg(id, error));
  }
  return locked(async () => {
    const store = await load();
    const job = store.jobs.find((j) => j.id === id);
    if (!job) return { ok: false as const };
    if (job.status === "done") return { ok: true as const };
    const plane = await readControlPlane();
    const maxRetry = plane.settings.maxRetry || 3;
    if (job.accountId) await coordDel(`account-lease:${job.accountId}`);
    await coordDel(`job-claim:${job.id}`);
    const abandon = isClientAbandon(error);
    if ((job.attempts || 0) < maxRetry && job.status === "running" && !abandon) {
      job.status = "queued";
      job.error = error;
      job.fault = "infra";
      job.lease = undefined;
    } else {
      job.status = "cancelled";
      job.error = error;
      job.fault = abandon && error.includes("REQUEST_CANCELLED") ? "client" : "infra";
      job.errorCode = error.includes("REQUEST_CANCELLED") ? "REQUEST_CANCELLED" : normalizeError(error);
      if (job.accountId) await patchAccount(job.accountId, { lockedUntil: null }).catch(() => undefined);
    }
    await save(store);
    return { ok: true as const };
  });
}

export function markWorkerDraining(name: string, draining = true) {
  return beatWorker(name, { draining });
}

export { persistenceMode, jsonAllowedFor };
