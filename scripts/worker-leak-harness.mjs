import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = process.env.RELAY_PROJECT_ROOT || process.cwd();
const TOTAL = Number(process.env.RELAY_LEAK_JOBS || 500);
const WARMUP = Number(process.env.RELAY_LEAK_WARMUP || 20);
const CONCURRENCY = Number(process.env.RELAY_LEAK_CONCURRENCY || 8);
const MAX_RSS_GROWTH = Number(process.env.RELAY_LEAK_MAX_RSS_MB || 128) * 1024 * 1024;
const PORT = Number(process.env.RELAY_WORKER_PORT || 20_000 + (process.pid % 20_000));
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const BASE = `http://127.0.0.1:${PORT}`;

let worker;
let monitor;
let monitoring = false;
const samples = [];

function rowsToTree(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    const parent = Number(row.ppid);
    const list = byParent.get(parent) || [];
    list.push(row);
    byParent.set(parent, list);
  }
  const found = [];
  const pending = [Number(rootPid)];
  const seen = new Set();
  while (pending.length) {
    const pid = pending.pop();
    if (!Number.isFinite(pid) || seen.has(pid)) continue;
    seen.add(pid);
    const own = rows.find((row) => Number(row.pid) === pid);
    if (own) found.push(own);
    for (const child of byParent.get(pid) || []) pending.push(Number(child.pid));
  }
  return found;
}

async function processTreeStats(rootPid) {
  let rows = [];
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress",
    ], { maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout || "[]");
    rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      name: String(row.Name || ""),
      rss: Number(row.WorkingSetSize || 0),
    }));
  } else {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss=,comm="], { maxBuffer: 4 * 1024 * 1024 });
    rows = stdout.trim().split(/\r?\n/).map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]) * 1024, name: match[4] } : null;
    }).filter(Boolean);
  }
  const tree = rowsToTree(rows, rootPid);
  return {
    rss: tree.reduce((sum, row) => sum + row.rss, 0),
    processes: tree.length,
    browserProcesses: tree.filter((row) => /chrom(e|ium)|msedge/i.test(row.name)).length,
  };
}

async function health() {
  const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`worker health HTTP ${response.status}`);
  return response.json();
}

async function waitHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await health();
      if (result.ok) return result;
    } catch {
      /* retry while Python and Playwright import */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`worker health timeout on ${PORT}`);
}

async function postJob(index, phase) {
  const prompt = `${phase}-${index}`;
  const response = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: `${phase}-${index}`,
      requestId: `${phase}-request-${index}`,
      accountId: `leak-account-${index % (CONCURRENCY * 2)}`,
      prompt,
      model: "chatgpt-web-auto",
      timeoutMs: 45_000,
      storageState: {
        cookies: [],
        origins: [],
      },
      proxyId: "leak-direct",
      proxy: { id: "leak-direct", server: "http://127.0.0.1:9", bypass: "127.0.0.1,localhost" },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json();
  return { ok: response.ok && body.ok === true && body.text === `MOCK:${prompt}`, status: response.status, body };
}

async function runJobs(count, phase) {
  let passed = 0;
  const failures = [];
  for (let offset = 0; offset < count; offset += CONCURRENCY) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, count - offset) }, (_, index) => postJob(offset + index, phase)),
    );
    for (const result of batch) {
      if (result.ok) passed += 1;
      else failures.push({ status: result.status, body: result.body });
    }
    if (phase === "leak" && (offset + batch.length) % 50 === 0) {
      process.stdout.write(`completed ${offset + batch.length}/${count}\n`);
    }
  }
  return { passed, failures: failures.slice(0, 5) };
}

async function takeSample() {
  if (!worker?.pid || monitoring) return;
  monitoring = true;
  try {
    const [tree, workerHealth] = await Promise.all([processTreeStats(worker.pid), health()]);
    samples.push({ at: Date.now(), ...tree, health: workerHealth });
  } catch {
    /* a sample can race worker shutdown; the job assertions remain authoritative */
  } finally {
    monitoring = false;
  }
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  const exited = new Promise((resolveExit) => worker.once("exit", resolveExit));
  try {
    worker.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([exited, new Promise((resolveExit) => setTimeout(resolveExit, 3_000))]);
}

async function main() {
  if (!Number.isInteger(TOTAL) || TOTAL < 1) throw new Error("RELAY_LEAK_JOBS must be a positive integer");
  if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) throw new Error("RELAY_LEAK_CONCURRENCY must be a positive integer");
  worker = spawn(PYTHON, [resolve(ROOT, "workers", "relay-worker.py")], {
    cwd: ROOT,
    env: {
      ...process.env,
      RELAY_HEADLESS: "1",
      RELAY_TEST_URL: "self",
      RELAY_TEST_BROWSER: "1",
      RELAY_SKIP_WARM: "1",
      RELAY_WORKER_PORT: String(PORT),
      RELAY_CAPACITY: String(CONCURRENCY),
      RELAY_PLAYWRIGHT_SHARDS: String(CONCURRENCY),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerLog = "";
  for (const stream of [worker.stdout, worker.stderr]) {
    stream.on("data", (chunk) => {
      workerLog = `${workerLog}${chunk}`.slice(-8_000);
    });
  }

  await waitHealth();
  const warmup = await runJobs(WARMUP, "warmup");
  if (warmup.passed !== WARMUP) throw new Error(`warmup failed ${JSON.stringify(warmup.failures)}`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  const baseline = await processTreeStats(worker.pid);
  monitor = setInterval(() => void takeSample(), 500);
  const run = await runJobs(TOTAL, "leak");
  clearInterval(monitor);
  monitor = undefined;
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  await takeSample();
  const final = await processTreeStats(worker.pid);
  const finalHealth = await health();
  const maxBrowserProcesses = Math.max(0, ...samples.map((sample) => sample.browserProcesses));
  const maxProcesses = Math.max(baseline.processes, ...samples.map((sample) => sample.processes));
  const maxRss = Math.max(baseline.rss, ...samples.map((sample) => sample.rss));
  const rssGrowth = final.rss - baseline.rss;
  const queuesEmpty = (finalHealth.shardQueues || []).every((depth) => depth === 0);
  const pass =
    run.passed === TOTAL &&
    finalHealth.active === 0 &&
    finalHealth.browsers === 0 &&
    finalHealth.contexts === 0 &&
    queuesEmpty &&
    maxBrowserProcesses > 0 &&
    final.processes <= baseline.processes + 2 &&
    rssGrowth <= MAX_RSS_GROWTH;
  const report = {
    result: pass ? "PASS" : "FAIL",
    jobs: TOTAL,
    warmupJobs: WARMUP,
    concurrency: CONCURRENCY,
    succeeded: run.passed,
    failures: run.failures,
    baseline,
    final,
    rssGrowthBytes: rssGrowth,
    maxRssBytes: maxRss,
    maxProcesses,
    maxBrowserProcesses,
    finalHealth,
    sampleCount: samples.length,
    limits: { maxRssGrowthBytes: MAX_RSS_GROWTH, finalProcessSlack: 2 },
    scope: "Real local Chromium lifecycle against the worker self-test page; no live provider account was used.",
    at: new Date().toISOString(),
  };
  await mkdir(resolve(ROOT, "storage"), { recursive: true });
  await writeFile(resolve(ROOT, "storage", "worker-leak-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!pass) {
    process.stderr.write(workerLog.slice(-2_000));
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  if (monitor) clearInterval(monitor);
  await stopWorker();
}
