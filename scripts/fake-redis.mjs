// @ts-nocheck
import net from "node:net";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Minimal RESP server implementing the Redis commands Relay actually uses:
 * PING AUTH GET SET NX PX DEL INCR PEXPIRE EVAL (compare-del / compare-renew)
 *
 * This is a real TCP server. Two OS processes issue the same wire commands
 * a hosted Redis would. Persistence is optional JSON dump for restart tests.
 */
export function startFakeRedis(opts = {}) {
  const persistPath = opts.persistPath || process.env.REDIS_PERSIST_PATH || "";
  const store = new Map();
  const now = () => Date.now();
  const live = (row) => row && (!row.exp || row.exp > now());

  function loadPersist() {
    if (!persistPath) return;
    try {
      const raw = JSON.parse(readFileSync(persistPath, "utf8"));
      for (const [k, v] of Object.entries(raw)) store.set(k, v);
    } catch {
      /* empty */
    }
  }

  function savePersist() {
    if (!persistPath) return;
    try {
      mkdirSync(dirname(persistPath), { recursive: true });
      const obj = {};
      for (const [k, v] of store) if (live(v)) obj[k] = v;
      writeFileSync(persistPath, JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  loadPersist();

  function handle(args) {
    const cmd = (args[0] || "").toUpperCase();
    if (cmd === "PING") return "+PONG\r\n";
    if (cmd === "AUTH") return "+OK\r\n";
    if (cmd === "GET") {
      const row = store.get(args[1]);
      if (!live(row)) return "$-1\r\n";
      return bulk(row.value);
    }
    if (cmd === "SET") {
      const key = args[1];
      const value = args[2];
      let px = 0;
      let nx = false;
      for (let i = 3; i < args.length; i++) {
        const a = args[i].toUpperCase();
        if (a === "PX") px = Number(args[++i]);
        else if (a === "NX") nx = true;
        else if (a === "XX") {
          /* ignore */
        }
      }
      const cur = store.get(key);
      if (nx && live(cur)) return "$-1\r\n";
      store.set(key, { value, exp: px ? now() + px : now() + 86_400_000 });
      savePersist();
      return "+OK\r\n";
    }
    if (cmd === "DEL") {
      const cur = store.get(args[1]);
      store.delete(args[1]);
      savePersist();
      return `:${live(cur) ? 1 : 0}\r\n`;
    }
    if (cmd === "INCR") {
      const key = args[1];
      const cur = store.get(key);
      const n = Number((live(cur) ? cur.value : "0") || "0") + 1;
      const exp = live(cur) ? cur.exp : now() + 86_400_000;
      store.set(key, { value: String(n), exp });
      savePersist();
      return `:${n}\r\n`;
    }
    if (cmd === "PEXPIRE") {
      const cur = store.get(args[1]);
      if (!live(cur)) return ":0\r\n";
      store.set(args[1], { value: cur.value, exp: now() + Number(args[2]) });
      savePersist();
      return ":1\r\n";
    }
    if (cmd === "EVAL") {
      const script = args[1] || "";
      const keysCount = Number(args[2] || "0");
      const key = args[3];
      const expected = args[3 + keysCount];
      const ttl = args[4 + keysCount];
      const cur = store.get(key);
      if (script.includes("PEXPIRE")) {
        if (live(cur) && cur.value === expected) {
          store.set(key, { value: cur.value, exp: now() + Number(ttl || "0") });
          savePersist();
          return ":1\r\n";
        }
        return ":0\r\n";
      }
      if (live(cur) && cur.value === expected) {
        store.delete(key);
        savePersist();
        return ":1\r\n";
      }
      return ":0\r\n";
    }
    if (cmd === "FLUSHALL" || cmd === "FLUSHDB") {
      store.clear();
      savePersist();
      return "+OK\r\n";
    }
    return "-ERR unknown\r\n";
  }

  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const parsed = readArray(buf);
        if (!parsed) break;
        buf = parsed.rest;
        sock.write(handle(parsed.args));
      }
    });
  });

  return new Promise((resolve) => {
    const port = Number(opts.port || process.env.REDIS_PORT || 0);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        url: `redis://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) {
              try {
                s.destroy();
              } catch {
                /* */
              }
            }
            server.close(() => r());
            setTimeout(r, 500);
          }),
        store,
        persistPath,
      });
    });
  });
}

function bulk(value) {
  const b = Buffer.from(String(value));
  return `$${b.length}\r\n${value}\r\n`;
}

function readArray(buf) {
  if (!buf.length || buf[0] !== 42) return null;
  const nl = buf.indexOf("\r\n");
  if (nl < 0) return null;
  const n = Number(buf.subarray(1, nl).toString());
  let offset = nl + 2;
  const args = [];
  for (let i = 0; i < n; i++) {
    if (offset >= buf.length || buf[offset] !== 36) return null;
    const nl2 = buf.indexOf("\r\n", offset);
    if (nl2 < 0) return null;
    const len = Number(buf.subarray(offset + 1, nl2).toString());
    const start = nl2 + 2;
    const end = start + len;
    if (buf.length < end + 2) return null;
    args.push(buf.subarray(start, end).toString());
    offset = end + 2;
  }
  return { args, rest: buf.subarray(offset) };
}

if (process.argv[1] && /fake-redis\.mjs$/.test(process.argv[1])) {
  const redis = await startFakeRedis({
    port: Number(process.env.REDIS_PORT || 19011),
    persistPath: process.env.REDIS_PERSIST_PATH || "",
  });
  process.stdout.write(JSON.stringify({ ok: true, url: redis.url, port: redis.port }) + "\n");
}
