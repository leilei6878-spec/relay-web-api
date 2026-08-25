import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSessionJson } from "./chatgpt-runner";
import { patchAccount, pickAccount, readControlPlane } from "./control-plane";
import { proxyServer } from "./session-file";
import { uid } from "./utils";

export type Job = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  platform: "chatgpt" | "gemini";
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
  text?: string;
  url?: string;
  error?: string;
};

type Store = { jobs: Job[]; workers: { id: string; lastBeat: string; name: string }[] };

const FILE = resolve("storage", "jobs.json");
let chain: Promise<unknown> = Promise.resolve();

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function load(): Promise<Store> {
  let store: Store;
  try {
    store = JSON.parse(await readFile(FILE, "utf8")) as Store;
  } catch {
    store = { jobs: [], workers: [] };
  }
  const now = Date.now();
  for (const job of store.jobs) {
    if (job.status === "queued") {
      if (now - Date.parse(job.createdAt) > (job.timeoutMs || 90_000) + 8_000) {
        job.status = "error";
        job.error = "任务过期";
      }
      continue;
    }
    if (job.status !== "running") continue;
    const start = Date.parse(job.startedAt || job.createdAt);
    const timedOut = now - start > (job.timeoutMs || 90_000) + 8_000;
    const worker = job.workerName ? store.workers.find((w) => w.name === job.workerName) : null;
    const workerDead = !worker || now - Date.parse(worker.lastBeat) > 15_000;
    if (!timedOut && !workerDead) continue;
    const attempts = job.attempts || 1;
    if (attempts < 3) {
      job.status = "queued";
      job.error = workerDead ? "执行器掉线，已回队" : "等待超时，已回队";
      job.workerName = undefined;
      job.startedAt = undefined;
    } else {
      job.status = "error";
      job.error = timedOut ? "任务过期" : "执行器反复掉线";
    }
  }
  return store;
}

async function save(store: Store) {
  await mkdir(resolve("storage"), { recursive: true });
  await writeFile(FILE, JSON.stringify(store), "utf8");
}

async function enqueue(
  platform: Job["platform"],
  prompt: string,
  model: string,
  timeoutMs: number,
  images: string[] = [],
) {
  return locked(async () => {
    const account = await pickAccount(platform);
    if (!account) {
      return {
        ok: false as const,
        error:
          platform === "gemini"
            ? "没有可调度的健康 Gemini 账号（需 Session + sticky，且未占用）"
            : "没有可调度的健康 ChatGPT 账号（需 Session + sticky，且未占用）",
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
    };
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

export function enqueueChat(prompt: string, model = "gpt-5.6", timeoutMs = 90_000, images: string[] = []) {
  return enqueue("chatgpt", prompt, model, timeoutMs, images);
}

export function enqueueImage(prompt: string, model = "gemini-image", timeoutMs = 90_000, images: string[] = []) {
  return enqueue("gemini", prompt, model, timeoutMs, images);
}

export function claimNext(workerName = "local") {
  return locked(async () => {
    const store = await load();
    const testWorker = workerName === "preview" || workerName.startsWith("test");
    const job = store.jobs.find(
      (j) => j.status === "queued" && !(testWorker && j.platform === "chatgpt"),
    );
    if (!job) return { job: null as Job | null, storageState: null as unknown, proxy: null };
    job.status = "running";
    job.attempts = (job.attempts || 0) + 1;
    job.startedAt = new Date().toISOString();
    job.workerName = workerName;
    await save(store);
    const session = job.accountId ? await readSessionJson(job.accountId) : { ok: false as const, error: "无账号" };
    const plane = await readControlPlane();
    const acc = plane.accounts.find((a) => a.id === job.accountId);
    const bound = acc ? plane.proxies.find((p) => p.id === acc.proxyId) : null;
    const proxy = bound
      ? {
          server: proxyServer(bound),
          username: bound.type === "ss" ? "" : bound.username,
          password: bound.type === "ss" ? "" : bound.password || "",
        }
      : null;
    return {
      job,
      storageState: session.ok ? JSON.parse(session.json) : { cookies: [], origins: [] },
      proxy,
    };
  });
}

export async function liveWorkerOnline() {
  const store = await load();
  const now = Date.now();
  return store.workers.some(
    (w) => w.name !== "preview" && !w.name.startsWith("test") && now - Date.parse(w.lastBeat) < 20_000,
  );
}

export function finishJob(id: string, result: { ok: boolean; text?: string; url?: string; error?: string }) {
  return locked(async () => {
    const store = await load();
    const job = store.jobs.find((j) => j.id === id);
    if (!job) return { ok: false as const, error: "任务不存在" };
    const has = Boolean(result.text || result.url);
    job.status = result.ok && has ? "done" : "error";
    job.text = result.text;
    job.url = result.url;
    job.error = result.error;
    await save(store);
    if (job.accountId) {
      const plane = await readControlPlane();
      const acc = plane.accounts.find((a) => a.id === job.accountId);
      const threshold = plane.settings.failThreshold || 5;
      const cool = (plane.settings.coolDownSeconds || 300) * 1000;
      if (acc) {
        if (result.ok && has) {
          await patchAccount(acc.id, {
            failCount: 0,
            totalRequests: (acc.totalRequests || 0) + 1,
            lastUsedAt: new Date().toISOString(),
            lastError: null,
            lockedUntil: null,
            status: "healthy",
          });
        } else {
          const failCount = (acc.failCount || 0) + 1;
          await patchAccount(acc.id, {
            failCount,
            totalRequests: (acc.totalRequests || 0) + 1,
            lastUsedAt: new Date().toISOString(),
            lastError: result.error || "任务失败",
            lockedUntil: failCount >= threshold ? new Date(Date.now() + cool).toISOString() : null,
            status: failCount >= threshold ? "invalid" : acc.status,
          });
        }
      }
    }
    return { ok: true as const };
  });
}

export async function getJob(id: string) {
  const store = await load();
  return store.jobs.find((j) => j.id === id) ?? null;
}

export function beatWorker(name: string) {
  return locked(async () => {
    const store = await load();
    const row = store.workers.find((w) => w.name === name);
    const now = new Date().toISOString();
    if (row) row.lastBeat = now;
    else store.workers.push({ id: uid(), name, lastBeat: now });
    await save(store);
    return { ok: true as const };
  });
}

export async function listJobs() {
  return load();
}

export async function waitJob(id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJob(id);
    if (!job) return { ok: false as const, error: "任务丢失" };
    if (job.status === "done" && (job.text || job.url)) {
      return { ok: true as const, text: job.text, url: job.url, job };
    }
    if (job.status === "error") return { ok: false as const, error: job.error || "任务失败" };
    await new Promise((r) => setTimeout(r, 120));
  }
  return { ok: false as const, error: "等待 Worker 超时。后台执行器未在线。" };
}
