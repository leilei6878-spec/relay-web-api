import { createConnection } from "node:net";
import { isProduction } from "./env-mode";
import { uid } from "./utils";

type Entry = { value: string; exp: number };

const mem = new Map<string, Entry>();
let redis: { send: (args: string[]) => Promise<string | null> } | null | undefined;

function sweep() {
  const now = Date.now();
  for (const [k, v] of mem) if (v.exp && v.exp < now) mem.delete(k);
}

function encodeResp(args: string[]) {
  let out = `*${args.length}\r\n`;
  for (const a of args) out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  return out;
}

function parseRedisUrl(raw: string) {
  const u = new URL(raw);
  return { host: u.hostname, port: Number(u.port || 6379), password: decodeURIComponent(u.password || "") };
}

function createRedis(url: string) {
  const cfg = parseRedisUrl(url);
  let buf = Buffer.alloc(0);
  let chain: Promise<string | null> = Promise.resolve(null);
  const conn = createConnection({ host: cfg.host, port: cfg.port });
  const waiters: ((v: string | null) => void)[] = [];
  const fail = (err?: Error) => {
    while (waiters.length) waiters.shift()?.(null);
    redis = undefined;
    if (isProduction() || process.env.RELAY_REQUIRE_REDIS === "1") {
      throw err || new Error("PRODUCTION_FAIL_CLOSED: redis connection lost");
    }
  };
  conn.on("error", () => fail());
  conn.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (waiters.length) {
      if (!buf.length) break;
      const type = String.fromCharCode(buf[0]!);
      const nl = buf.indexOf("\r\n");
      if (nl < 0) break;
      if (type === "+" || type === "-" || type === ":") {
        const line = buf.subarray(1, nl).toString();
        buf = buf.subarray(nl + 2);
        waiters.shift()?.(type === "-" ? null : line);
        continue;
      }
      if (type === "$") {
        const len = Number(buf.subarray(1, nl).toString());
        if (len < 0) {
          buf = buf.subarray(nl + 2);
          waiters.shift()?.(null);
          continue;
        }
        const start = nl + 2;
        if (buf.length < start + len + 2) break;
        const val = buf.subarray(start, start + len).toString();
        buf = buf.subarray(start + len + 2);
        waiters.shift()?.(val);
        continue;
      }
      buf = buf.subarray(nl + 2);
      waiters.shift()?.(null);
    }
  });
  const send = (args: string[]) => {
    const next = chain.then(
      () =>
        new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            redis = undefined;
            resolve(null);
          }, 1500);
          waiters.push((v) => {
            clearTimeout(timer);
            resolve(v);
          });
          try {
            conn.write(encodeResp(args));
          } catch {
            clearTimeout(timer);
            redis = undefined;
            resolve(null);
          }
        }),
      () => null,
    );
    chain = next;
    return next;
  };
  return { send, password: cfg.password, conn };
}

async function getRedis() {
  if (redis !== undefined) return redis;
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    if (isProduction() || process.env.RELAY_REQUIRE_REDIS === "1") {
      throw new Error("PRODUCTION_FAIL_CLOSED: REDIS_URL is required; memory lock fallback is forbidden");
    }
    redis = null;
    return null;
  }
  try {
    const client = createRedis(url);
    if (client.password) await client.send(["AUTH", client.password]);
    const pong = await Promise.race([
      client.send(["PING"]),
      new Promise<null>((r) => setTimeout(() => r(null), 800)),
    ]);
    if (pong !== "PONG" && pong !== "OK") {
      if (isProduction() || process.env.RELAY_REQUIRE_REDIS === "1") {
        throw new Error("PRODUCTION_FAIL_CLOSED: Redis PING failed");
      }
      redis = undefined;
      return null;
    }
    redis = client;
    return redis;
  } catch (err) {
    redis = undefined;
    if (isProduction() || process.env.RELAY_REQUIRE_REDIS === "1") throw err;
    return null;
  }
}

export function coordBackend() {
  return redis ? "redis" : "memory";
}

export async function coordGet(key: string) {
  const r = await getRedis();
  if (r) return r.send(["GET", key]);
  sweep();
  const row = mem.get(key);
  if (!row) return null;
  if (row.exp && row.exp < Date.now()) {
    mem.delete(key);
    return null;
  }
  return row.value;
}

export async function coordSet(key: string, value: string, ttlMs?: number) {
  const r = await getRedis();
  if (r) {
    if (ttlMs && ttlMs > 0) await r.send(["SET", key, value, "PX", String(ttlMs)]);
    else await r.send(["SET", key, value]);
    return;
  }
  mem.set(key, { value, exp: ttlMs ? Date.now() + ttlMs : Date.now() + 86_400_000 });
}

export async function coordSetNx(key: string, value: string, ttlMs: number) {
  const r = await getRedis();
  if (r) {
    const res = await r.send(["SET", key, value, "PX", String(ttlMs), "NX"]);
    return res === "OK";
  }
  sweep();
  const cur = mem.get(key);
  if (cur && cur.exp > Date.now()) return false;
  mem.set(key, { value, exp: Date.now() + ttlMs });
  return true;
}

export async function coordDel(key: string) {
  const r = await getRedis();
  if (r) {
    await r.send(["DEL", key]);
    return;
  }
  mem.delete(key);
}

export async function coordIncr(key: string, ttlMs = 86_400_000) {
  const r = await getRedis();
  if (r) {
    const n = Number((await r.send(["INCR", key])) || "0");
    if (n === 1) await r.send(["PEXPIRE", key, String(ttlMs)]);
    return n;
  }
  sweep();
  const cur = mem.get(key);
  const n = Number(cur?.value || "0") + 1;
  mem.set(key, { value: String(n), exp: cur?.exp || Date.now() + ttlMs });
  return n;
}

const RELEASE_LUA =
  'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end';

const RENEW_LUA =
  'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("PEXPIRE",KEYS[1],ARGV[2]) else return 0 end';

const SEMAPHORE_ACQUIRE_LUA =
  'local n=tonumber(redis.call("GET",KEYS[1]) or "0"); local cap=tonumber(ARGV[1]); if n>=cap then return 0 end; n=redis.call("INCR",KEYS[1]); redis.call("PEXPIRE",KEYS[1],ARGV[2]); return n';
const SEMAPHORE_RELEASE_LUA =
  'local n=tonumber(redis.call("GET",KEYS[1]) or "0"); if n<=1 then redis.call("DEL",KEYS[1]); return 0 end; return redis.call("DECR",KEYS[1])';

/** Atomic compare-and-delete. Redis uses EVAL; memory uses the same predicate. */
export async function coordCompareDel(key: string, expected: string) {
  const r = await getRedis();
  if (r) {
    const res = await r.send(["EVAL", RELEASE_LUA, "1", key, expected]);
    return res === "1";
  }
  sweep();
  const cur = mem.get(key);
  if (cur && cur.value === expected && cur.exp > Date.now()) {
    mem.delete(key);
    return true;
  }
  return false;
}

/**
 * Atomic compare-and-renew (compare-and-PEXPIRE).
 * Must NOT be implemented as GET → compare in JS → SET/PEXPIRE — that leaves a race.
 */
export async function coordCompareExpire(key: string, expected: string, ttlMs: number) {
  const r = await getRedis();
  if (r) {
    const res = await r.send(["EVAL", RENEW_LUA, "1", key, expected, String(ttlMs)]);
    return res === "1";
  }
  sweep();
  const cur = mem.get(key);
  if (cur && cur.value === expected && cur.exp > Date.now()) {
    cur.exp = Date.now() + ttlMs;
    return true;
  }
  return false;
}

export async function coordSemaphoreAcquire(key: string, limit: number, ttlMs: number) {
  const cap = Math.max(1, Math.floor(limit));
  const r = await getRedis();
  if (r) {
    const result = Number((await r.send(["EVAL", SEMAPHORE_ACQUIRE_LUA, "1", key, String(cap), String(ttlMs)])) || "0");
    return result > 0;
  }
  sweep();
  const current = mem.get(key);
  const count = Number(current?.value || "0");
  if (count >= cap) return false;
  mem.set(key, { value: String(count + 1), exp: Date.now() + ttlMs });
  return true;
}

export async function coordSemaphoreRelease(key: string) {
  const r = await getRedis();
  if (r) {
    await r.send(["EVAL", SEMAPHORE_RELEASE_LUA, "1", key]);
    return;
  }
  sweep();
  const current = mem.get(key);
  const count = Number(current?.value || "0");
  if (count <= 1) mem.delete(key);
  else if (current) current.value = String(count - 1);
}

function looksLikeJobId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Heartbeat must extend TTL without changing the owner token.
 *  job-claim is stored as workerName at claim time; account-lease is jobId.
 *  Accept jobId as a fallback claim token for tests and older workers. */
export async function renewJobLeases(jobId: string, accountId?: string, ttlMs = 120_000, workerName?: string) {
  if (!jobId) return;
  const claimTokens = workerName ? [workerName, jobId] : [jobId];
  for (const tok of claimTokens) {
    if (await coordCompareExpire(`job-claim:${jobId}`, tok, ttlMs)) break;
  }
  if (accountId) await coordCompareExpire(`account-lease:${accountId}`, jobId, ttlMs);
}

export function parseActiveJobsHeader(
  raw: string | null | undefined,
  fallbackJobId = "",
  fallbackAccountId = "",
): { jobId: string; accountId: string }[] {
  const out: { jobId: string; accountId: string }[] = [];
  const text = (raw || "").trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as { jobId?: string; accountId?: string }[];
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (row && row.jobId) out.push({ jobId: String(row.jobId), accountId: String(row.accountId || "") });
        }
      }
    } catch {
      /* ignore malformed JSON */
    }
  }
  if (!out.length && fallbackJobId) {
    out.push({ jobId: fallbackJobId, accountId: fallbackAccountId });
  }
  return out;
}

/** Drop this job's account lock. Never steal a newer job's uuid lease. */
export async function releaseJobLeases(jobId: string, accountId?: string, workerName?: string) {
  if (accountId) {
    const key = `account-lease:${accountId}`;
    if (!(await coordCompareDel(key, jobId))) {
      const v = (await coordGet(key)) || "";
      if (!v || v === workerName || v === "pending" || !looksLikeJobId(v)) {
        await coordDel(key);
      }
    }
  }
  await coordDel(`job-claim:${jobId}`);
}

export async function coordEval(script: string, keys: string[], args: string[]) {
  const r = await getRedis();
  if (r) {
    return r.send(["EVAL", script, String(keys.length), ...keys, ...args]);
  }
  if (script.includes("PEXPIRE") && keys[0] && args[0]) {
    return (await coordCompareExpire(keys[0], args[0], Number(args[1] || "0"))) ? "1" : "0";
  }
  if (script.includes("GET") && script.includes("DEL") && keys[0] && args[0]) {
    return (await coordCompareDel(keys[0], args[0])) ? "1" : "0";
  }
  return null;
}

export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const token = uid();
  const start = Date.now();
  while (Date.now() - start < ttlMs) {
    if (await coordSetNx(key, token, ttlMs)) {
      try {
        return await fn();
      } finally {
        await coordCompareDel(key, token);
      }
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("LOCK_TIMEOUT");
}

export function resetCoordForTests() {
  mem.clear();
  const current = redis as { conn?: { destroy: () => void } } | null | undefined;
  if (current && current.conn) {
    try {
      current.conn.destroy();
    } catch {
      /* ignore */
    }
  }
  redis = undefined;
}

export const COORD_RELEASE_LUA = RELEASE_LUA;
export const COORD_RENEW_LUA = RENEW_LUA;
export const COORD_SEMAPHORE_ACQUIRE_LUA = SEMAPHORE_ACQUIRE_LUA;
export const COORD_SEMAPHORE_RELEASE_LUA = SEMAPHORE_RELEASE_LUA;
