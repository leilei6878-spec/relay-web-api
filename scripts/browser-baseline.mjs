#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const N = Number(process.env.RELAY_BROWSER_BASELINE_N || 8);
const started = Date.now();
const py = `
import time, json, os
samples = []
try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e), "samples": []}))
    raise SystemExit(0)
n = int(os.environ.get("N") or "8")
with sync_playwright() as p:
    for i in range(n):
        t0 = time.time()
        crash = False
        try:
            b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
            t1 = time.time()
            ctx = b.new_context()
            t2 = time.time()
            page = ctx.new_page()
            page.set_content("<textarea id='prompt-textarea'></textarea><button data-testid='send-button'>S</button>")
            t3 = time.time()
            page.locator("#prompt-textarea").fill("hi")
            t4 = time.time()
            b.close()
            samples.append({
                "browser_start_ms": (t1-t0)*1000,
                "context_start_ms": (t2-t1)*1000,
                "page_load_ms": (t3-t2)*1000,
                "time_to_composer_ms": (t4-t0)*1000,
                "total_ms": (time.time()-t0)*1000,
                "crash": False,
            })
        except Exception as e:
            samples.append({"crash": True, "error": str(e), "total_ms": (time.time()-t0)*1000})
def pct(xs, p):
    if not xs: return 0
    xs = sorted(xs)
    i = min(len(xs)-1, max(0, int(round((p/100)*len(xs))-1)))
    return xs[i]
starts = [s.get("browser_start_ms") for s in samples if s.get("browser_start_ms") is not None]
print(json.dumps({
    "ok": True,
    "n": len(samples),
    "browser_start_p50": pct(starts, 50),
    "browser_start_p95": pct(starts, 95),
    "crash_rate": sum(1 for s in samples if s.get("crash")) / max(1, len(samples)),
    "samples": samples,
}))
`;
const run = spawnSync("python3", ["-c", py], { encoding: "utf8", env: { ...process.env, N: String(N) }, timeout: 120_000 });
let body;
try {
  body = JSON.parse((run.stdout || "").trim().split("\n").pop() || "{}");
} catch {
  body = { ok: false, error: run.stderr || run.stdout, samples: [] };
}
body.wallMs = Date.now() - started;
writeFileSync("/workspace/storage/browser-baseline.json", JSON.stringify(body, null, 2));
process.stdout.write(JSON.stringify(body, null, 2) + "\n");
