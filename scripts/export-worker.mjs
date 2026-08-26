import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { localWorkerScript } from "../src/lib/local-worker-script.ts";

const dest = resolve(process.argv[2] || "workers/relay-worker.py");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, localWorkerScript(), { mode: 0o755 });
console.log(`wrote ${dest}`);
