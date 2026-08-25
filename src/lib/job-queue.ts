import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSessionJson } from "./chatgpt-runner";
import { pickAccount } from "./control-plane";
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
    if (
      (job.status === "queued" || job.status === "running") &&
      now - Date.parse(job.createdAt) > (job.timeoutMs || 90_000) + 8_000
    ) {
      job.status = "error";
      job.error = "任务过期";
    }
  }
  return store;
}

async function save(store: Store) {
  await mkdir(resolve("storage"), { recursive: true });
  await writeFile(FILE, JSON.stringify(store), "utf8");
}

async function enqueue(platform: Job["platform"], prompt: string, model: string, timeoutMs: number) {
  return locked(async () => {
    const account = await pickAccount(platform);
    if (!account) {
      return {
        ok: false as const,
        error:
          platform === "gemini"
            ? "没有可调度的健康 Gemini 账号（需 Session + sticky）"
            : "没有可调度的健康 ChatGPT 账号（需 Session + sticky）",
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
    };
    const store = await load();
    store.jobs.unshift(job);
    store.jobs = store.jobs.slice(0, 200);
    await save(store);
    return { ok: true as const, job };
  });
}

export function enqueueChat(prompt: string, model = "gpt-4o", timeoutMs = 90_000) {
  return enqueue("chatgpt", prompt, model, timeoutMs);
}

export function enqueueImage(prompt: string, model = "gemini-image", timeoutMs = 90_000) {
  return enqueue("gemini", prompt, model, timeoutMs);
}

export function claimNext() {
  return locked(async () => {
    const store = await load();
    const job = store.jobs.find((j) => j.status === "queued");
    if (!job) return { job: null as Job | null, storageState: null as unknown };
    job.status = "running";
    await save(store);
    const session = job.accountId ? await readSessionJson(job.accountId) : { ok: false as const, error: "无账号" };
    return {
      job,
      storageState: session.ok ? JSON.parse(session.json) : { cookies: [], origins: [] },
    };
  });
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
    await new Promise((r) => setTimeout(r, 350));
  }
  return { ok: false as const, error: "等待 Worker 超时。后台执行器未在线。" };
}
