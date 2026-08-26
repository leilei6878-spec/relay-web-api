import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { observeCall } from "./metrics";
import { uid } from "./utils";

export type UsageRow = {
  id: string;
  createdAt: string;
  keyId: string;
  keyName: string;
  platform: "chatgpt" | "gemini" | "leonardo";
  model: string;
  accountEmail: string;
  ok: boolean;
  latencyMs: number;
  images: number;
  promptPreview: string;
  error?: string;
  mode?: string;
  jobId?: string;
  requestId?: string;
  traceId?: string;
  attemptId?: string;
  workerId?: string;
  accountId?: string;
  proxyId?: string;
  promptTokens?: number;
  completionTokens?: number;
};

const FILE = resolve("storage", "usage.json");

async function load(): Promise<{ rows: UsageRow[] }> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as { rows: UsageRow[] };
  } catch {
    return { rows: [] };
  }
}

async function save(store: { rows: UsageRow[] }) {
  await mkdir(resolve("storage"), { recursive: true });
  await writeFile(FILE, JSON.stringify(store), "utf8");
}

export async function appendUsage(row: Omit<UsageRow, "id" | "createdAt">) {
  const store = await load();
  const full: UsageRow = { ...row, id: uid(), createdAt: new Date().toISOString() };
  store.rows.unshift(full);
  store.rows = store.rows.slice(0, 2000);
  await save(store);
  observeCall({ latencyMs: full.latencyMs, ok: full.ok, platform: full.platform });
  if (process.env.RELAY_SKIP_DB !== "1") {
    const { dbInsertUsage, safeDb } = await import("./relay-db");
    await safeDb(() => dbInsertUsage(full as unknown as Record<string, unknown>));
  }
  return full;
}

export async function listUsage(limit = 100) {
  const store = await load();
  return store.rows.slice(0, limit);
}

export async function usageToday(keyId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const from = start.toISOString();
  const store = await load();
  return store.rows.filter((r) => r.keyId === keyId && r.createdAt >= from).length;
}
