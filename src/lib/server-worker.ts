import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { localWorkerScript } from "./local-worker-script";
import { ensureWorkerToken } from "./worker-auth";

const DIR = resolve("storage");
const SCRIPT = resolve(DIR, "server-worker.py");
const PID = resolve(DIR, "server-worker.pid");
const LOG = resolve(DIR, "server-worker.log");
const FLAG = resolve(DIR, "server-worker.enabled");
const NAME = "server-1";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid() {
  try {
    const n = Number((await readFile(PID, "utf8")).trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function serverWorkerStatus() {
  const pid = await readPid();
  const running = pid > 0 && alive(pid);
  let enabled = false;
  try {
    enabled = (await readFile(FLAG, "utf8")).trim() === "1";
  } catch {
    enabled = false;
  }
  return { running, pid: running ? pid : 0, name: NAME, enabled };
}

export async function startServerWorker(gateway = "http://127.0.0.1:8080") {
  const cur = await serverWorkerStatus();
  if (cur.running) return { ok: true as const, ...cur };
  const token = await ensureWorkerToken();
  await writeFile(SCRIPT, localWorkerScript(), "utf8");
  const useXvfb = existsSync("/usr/bin/xvfb-run");
  const child = spawn(
    useXvfb ? "xvfb-run" : "python3",
    useXvfb ? ["-a", "python3", SCRIPT] : [SCRIPT],
    {
    cwd: DIR,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      RELAY_GATEWAY: gateway.replace(/\/$/, ""),
      RELAY_TOKEN: token,
      RELAY_WORKER_NAME: NAME,
      RELAY_HEADLESS: useXvfb ? "0" : "1",
      RELAY_WORKER_PORT: "18766",
    },
  },
  );
  if (!child.pid) return { ok: false as const, error: "无法启动 python 执行器" };
  const log = (buf: Buffer) => {
    void writeFile(LOG, buf, { flag: "a" }).catch(() => undefined);
  };
  child.stdout?.on("data", log);
  child.stderr?.on("data", log);
  child.unref();
  await writeFile(PID, String(child.pid), "utf8");
  await writeFile(FLAG, "1", "utf8");
  return { ok: true as const, running: true, pid: child.pid, name: NAME, enabled: true };
}

export async function stopServerWorker() {
  const pid = await readPid();
  if (pid && alive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (existsSync(PID)) await unlink(PID).catch(() => undefined);
  await writeFile(FLAG, "0", "utf8");
  return { ok: true as const, running: false, pid: 0, name: NAME, enabled: false };
}

export async function ensureServerWorker(gateway = "http://127.0.0.1:8080") {
  const st = await serverWorkerStatus();
  if (st.running) return st;
  let flag: string | null = null;
  try {
    flag = (await readFile(FLAG, "utf8")).trim();
  } catch {
    flag = null;
  }
  if (flag === "0") return st;
  const started = await startServerWorker(gateway);
  return started.ok ? started : { ...st, error: started.error };
}
