import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { parseStorageState, proxyServer } from "./session-file";
import type { ChatgptWebInput, ProbeProxyInput } from "./gateway-types";

export async function writeSessionFile(accountId: string, json: string) {
  const parsed = parseStorageState(json);
  if (!parsed.ok) return parsed;
  const id = accountId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return { ok: false as const, error: "账号无效" };
  const dir = resolve("storage/sessions");
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${id}.json`);
  await writeFile(path, json, { encoding: "utf8", mode: 0o600 });
  return { ok: true as const, cookieCount: parsed.data.cookieCount, path };
}

export async function readSessionJson(accountId: string) {
  const id = accountId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return { ok: false as const, error: "账号无效" };
  const path = resolve("storage/sessions", `${id}.json`);
  try {
    const json = await readFile(path, "utf8");
    JSON.parse(json);
    return { ok: true as const, json };
  } catch {
    return { ok: false as const, error: "没有这份 Session 文件，请重新拖入 state.json" };
  }
}

export async function runChatgptJob(data: ChatgptWebInput) {
  const sessionPath = resolve(
    "storage/sessions",
    `${data.accountId.replace(/[^a-zA-Z0-9_-]/g, "")}.json`,
  );
  const payload = {
    prompt: data.prompt,
    timeoutMs: data.timeoutMs,
    accountId: data.accountId,
    sessionPath,
    selectors: data.selectors,
    proxy: data.proxy
      ? {
          host: data.proxy.host,
          server: proxyServer(data.proxy),
          username: data.proxy.type === "ss" ? "" : data.proxy.username,
          password: data.proxy.type === "ss" ? "" : data.proxy.password,
        }
      : null,
  };

  const script = resolve("scripts/chatgpt-web-worker.mjs");
  return spawnJson(script, payload, data.timeoutMs + 20_000);
}

function spawnJson(
  script: string,
  payload: unknown,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({ ok: false, error: "网页 Worker 超时" });
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: err.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      const line = raw.split("\n").filter(Boolean).at(-1) ?? "";
      try {
        const parsed = JSON.parse(line) as { ok?: boolean; text?: string; error?: string };
        if (parsed.ok && parsed.text) {
          resolvePromise({ ok: true, text: parsed.text });
          return;
        }
        resolvePromise({ ok: false, error: parsed.error || "网页 Worker 失败" });
      } catch {
        const err = Buffer.concat(errChunks).toString("utf8").slice(0, 240);
        resolvePromise({ ok: false, error: err || "网页 Worker 无输出" });
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function probeProxyJob(data: ProbeProxyInput) {
  if (/\.example\.net$/i.test(data.host)) {
    return {
      ok: false as const,
      portOk: false,
      tunnelOk: false,
      error: "演示代理不能出网",
    };
  }

  const port = await tcpProbe(data.host, data.port);
  if (!port.ok) {
    return {
      ok: false as const,
      portOk: false,
      portMs: port.ms,
      tunnelOk: false,
      error: `节点 ${data.host}:${data.port} 不通 · ${port.error}`,
      ms: port.ms,
    };
  }

  if (data.type === "ss") {
    if (!data.password || data.password === "***") {
      const { readControlPlane } = await import("./control-plane");
      const { getSecret, proxySecretKey } = await import("./secrets");
      const plane = await readControlPlane();
      const hit = plane.proxies.find((p) => p.host === data.host && p.port === data.port);
      if (hit) {
        data.password = (await getSecret(proxySecretKey(hit.id))) || data.password;
        data.method = data.method || hit.method;
      }
    }
    const { ensureSsLocalFromPlane } = await import("./ss-local");
    const startedLocal = await ensureSsLocalFromPlane({
      host: data.host,
      port: data.port,
      password: data.password,
      method: data.method,
    });
    if (!startedLocal.ok) {
      return {
        ok: false as const,
        portOk: true,
        portMs: port.ms,
        tunnelOk: false,
        error: startedLocal.error,
        ms: port.ms,
      };
    }
    const local = startedLocal.localPort;
    const started = Date.now();
    const tunnel = await runCurl(["-sS", "--max-time", "12", "--socks5-hostname", `127.0.0.1:${local}`, "https://api.ipify.org"]);
    const tunnelMs = Date.now() - started;
    if (tunnel.ok) {
      const ip = tunnel.text.trim();
      if (/^[\d.:a-fA-F]+$/.test(ip)) {
        return {
          ok: true as const,
          portOk: true,
          portMs: port.ms,
          tunnelOk: true,
          ip,
          ms: tunnelMs,
        };
      }
    }
    return {
      ok: true as const,
      portOk: true,
      portMs: port.ms,
      tunnelOk: false,
      error: `SS 节点 TCP 通，但 SOCKS ${local} 仍出不了网（${tunnel.text || "无响应"}）`,
      ms: tunnelMs,
    };
  }

  const args = ["-sS", "--max-time", "12"];
  if (data.type === "socks5") {
    const auth =
      data.username && data.password
        ? `${encodeURIComponent(data.username)}:${encodeURIComponent(data.password)}@`
        : "";
    args.push("--socks5-hostname", `${auth}${data.host}:${data.port}`);
  } else {
    const auth =
      data.username || data.password
        ? `${encodeURIComponent(data.username || "")}:${encodeURIComponent(data.password || "")}@`
        : "";
    args.push("--proxy", `http://${auth}${data.host}:${data.port}`);
  }
  args.push("https://api.ipify.org");
  const started = Date.now();
  const tunnel = await runCurl(args);
  const tunnelMs = Date.now() - started;

  if (tunnel.ok) {
    const ip = tunnel.text.trim();
    if (/^[\d.:a-fA-F]+$/.test(ip)) {
      return {
        ok: true as const,
        portOk: true,
        portMs: port.ms,
        tunnelOk: true,
        ip,
        ms: tunnelMs,
      };
    }
  }

  return {
    ok: true as const,
    portOk: true,
    portMs: port.ms,
    tunnelOk: false,
    ip: null,
    ms: port.ms,
    error: `节点 ${data.host}:${data.port} 在线（TCP ${port.ms}ms）。经本平台出网未完成，不影响本机客户端。`,
  };
}

function tcpProbe(host: string, port: number, timeoutMs = 8000) {
  return new Promise<{ ok: true; ms: number } | { ok: false; error: string; ms: number }>((resolvePromise) => {
    const started = Date.now();
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise({ ok: false, error: "连接超时", ms: Date.now() - started });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      socket.end();
      resolvePromise({ ok: true, ms });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: err.message, ms: Date.now() - started });
    });
  });
}

function runCurl(args: string[]): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({ ok: false, error: "探测超时" });
    }, 15_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString("utf8");
      if (code === 0 && text.trim()) {
        resolvePromise({ ok: true, text });
        return;
      }
      const detail = (Buffer.concat(err).toString("utf8") || text || `curl 退出 ${code}`).slice(0, 180);
      resolvePromise({ ok: false, error: detail });
    });
  });
}
