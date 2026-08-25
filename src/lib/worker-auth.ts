import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findApiKey } from "./api-keys";
import { bearerToken } from "./control-plane";

const FILE = resolve("storage", "worker-token.txt");

function mint() {
  return `wk-relay-${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function ensureWorkerToken() {
  await mkdir(resolve("storage"), { recursive: true });
  try {
    const token = (await readFile(FILE, "utf8")).trim();
    if (token.startsWith("wk-relay-") && token.length >= 24) return token;
  } catch {
    /* create */
  }
  const token = mint();
  await writeFile(FILE, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

export async function assertWorkerAccess(request: Request) {
  const got = bearerToken(request);
  const worker = await ensureWorkerToken();
  if (got && got === worker) return { ok: true as const, via: "worker" as const };
  const rec = await findApiKey(got);
  if (rec?.enabled) return { ok: true as const, via: "key" as const };
  return { ok: false as const, status: 401, error: "无效的执行器凭证" };
}
