import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectSession } from "./session-file";
import type { Platform } from "./types";

export { inspectSession };

export async function probeSessionFile(accountId: string, platform: Platform) {
  const id = accountId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return { ok: false as const, reason: "账号无效" };
  let json: string;
  try {
    json = await readFile(resolve("storage/sessions", `${id}.json`), "utf8");
  } catch {
    return { ok: false as const, reason: "没有登录文件" };
  }
  return inspectSession(json, platform);
}
