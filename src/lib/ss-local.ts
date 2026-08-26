import { execFile, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { xrayConfig } from "./proxy-link";

const DIR = resolve("storage");
const BIN = resolve("bin/xray");
const CFG = resolve(DIR, "xray.json");
const PID = resolve(DIR, "xray.pid");
const LOG = resolve("/tmp/xray-local.log");
const SERVER_SOCKS = Number(process.env.RELAY_SS_LOCAL_PORT || 18080);

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

function portOpen(port: number, host = "127.0.0.1") {
  return new Promise<boolean>((ok) => {
    const sock = createConnection({ host, port }, () => {
      sock.end();
      ok(true);
    });
    sock.setTimeout(400);
    sock.on("error", () => ok(false));
    sock.on("timeout", () => {
      sock.destroy();
      ok(false);
    });
  });
}

function ipify(port: number) {
  return new Promise<string>((resolveIp, reject) => {
    execFile(
      "curl",
      ["-sS", "--max-time", "8", "--socks5-hostname", `127.0.0.1:${port}`, "https://api.ipify.org"],
      { timeout: 10000 },
      (err, stdout) => {
        const ip = String(stdout || "").trim();
        if (!err && /^[\d.:a-fA-F]+$/.test(ip)) resolveIp(ip);
        else reject(err || new Error(ip || "no ip"));
      },
    );
  });
}

async function ensureBinary() {
  if (existsSync(BIN)) return true;
  const candidates = ["/tmp/xray/xray", "/usr/local/bin/xray"];
  await mkdir(resolve("bin"), { recursive: true });
  for (const c of candidates) {
    if (existsSync(c)) {
      await copyFile(c, BIN);
      return true;
    }
  }
  return existsSync(BIN);
}

async function killPort(port: number) {
  await new Promise<void>((done) => {
    const child = spawn("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
    child.on("close", () => done());
    child.on("error", () => done());
  });
}

async function startXray(cfg: unknown, localPort: number) {
  await mkdir(DIR, { recursive: true });
  await writeFile(CFG, JSON.stringify(cfg, null, 2), "utf8");
  const old = await readPid();
  if (old && alive(old)) {
    try {
      process.kill(old, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  await killPort(localPort);
  await new Promise((r) => setTimeout(r, 200));
  const logFd = openSync(LOG, "a");
  const child = spawn(BIN, ["run", "-c", CFG], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  if (!child.pid) return { ok: false as const, error: "无法启动 xray" };
  child.unref();
  await writeFile(PID, String(child.pid), "utf8");
  for (let i = 0; i < 25; i += 1) {
    if (await portOpen(localPort)) return { ok: true as const, pid: child.pid };
    await new Promise((r) => setTimeout(r, 80));
  }
  return { ok: false as const, error: "xray 未监听 SOCKS" };
}

function methodsToTry(method: string | undefined, password: string) {
  const advertised = method || "2022-blake3-aes-128-gcm";
  const out = [advertised];
  if (advertised.includes("2022")) {
    out.unshift("2022-blake3-aes-128-gcm");
    out.push("2022-blake3-aes-256-gcm");
  }
  return [...new Set(out)];
}

export async function ensureSsLocal(proxy: {
  host: string;
  port: number;
  password?: string;
  method?: string;
  localPort?: number;
  name?: string;
}) {
  const password = (proxy.password || "").trim();
  if (!password || password === "***") return { ok: false as const, error: "SS 密码缺失" };
  if (!(await ensureBinary())) return { ok: false as const, error: "缺少 xray" };
  const localPort = SERVER_SOCKS;
  let last = "SS 隧道失败";
  for (const method of methodsToTry(proxy.method, password)) {
    const cfg = xrayConfig({
      host: proxy.host,
      port: proxy.port,
      password,
      method,
      localPort,
      name: proxy.name || "ss",
    });
    const started = await startXray(cfg, localPort);
    if (!started.ok) {
      last = started.error;
      continue;
    }
    try {
      const ip = await ipify(localPort);
      return { ok: true as const, pid: started.pid, localPort, ip, method };
    } catch (err) {
      last = err instanceof Error ? err.message : "HTTPS 隧道失败";
    }
  }
  return { ok: false as const, error: last };
}

export async function ensureSsLocalFromPlane(opts: {
  host: string;
  port: number;
  method?: string;
  localPort?: number;
  name?: string;
  password?: string;
  id?: string;
}) {
  let password = opts.password || "";
  if (!password || password === "***") {
    if (opts.id) {
      const { getSecret, proxySecretKey } = await import("./secrets");
      password = (await getSecret(proxySecretKey(opts.id))) || "";
    }
  }
  return ensureSsLocal({ ...opts, password });
}
