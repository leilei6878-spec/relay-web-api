#!/usr/bin/env python3
"""ChatGPT web latency bench. Writes storage/chatgpt-latency-bench.json."""
import json, os, statistics, sys, time, urllib.request

PROMPT = "你好，你是什么模型？用三句话说明。"
KEY = os.environ.get("RELAY_BENCH_KEY") or "sk-relay-3f5bb7144d3348c8add2b88d"
URL = os.environ.get("RELAY_BENCH_URL") or "http://127.0.0.1:8080/v1/chat/completions"
N = int(os.environ.get("RELAY_BENCH_N") or "20")
OUT = os.environ.get("RELAY_BENCH_OUT") or "storage/chatgpt-latency-bench.json"

def percentile(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    k = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
    return s[k]

def one(stream=True, timeout=180):
    body = json.dumps({
        "model": "gpt-5.6",
        "stream": stream,
        "messages": [{"role": "user", "content": PROMPT}],
    }).encode()
    req = urllib.request.Request(
        URL,
        data=body,
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    ttft = None
    text = ""
    err = None
    timing = None
    actual_model = None
    actual_profile = None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if stream:
                buf = b""
                while True:
                    chunk = r.read(256)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n\n" in buf:
                        part, buf = buf.split(b"\n\n", 1)
                        line = part.decode("utf-8", "replace")
                        if "data:" not in line:
                            continue
                        data = line.split("data:", 1)[-1].strip()
                        if data == "[DONE]":
                            continue
                        try:
                            obj = json.loads(data)
                        except Exception:
                            continue
                        if obj.get("error"):
                            err = str(obj["error"])
                        content = (((obj.get("choices") or [{}])[0].get("delta") or {}).get("content")) or ""
                        if content:
                            if ttft is None:
                                ttft = int((time.time() - t0) * 1000)
                            text += content
                        relay = obj.get("relay") or {}
                        if relay.get("timing"):
                            timing = relay["timing"]
                        if relay.get("actualModel"):
                            actual_model = relay["actualModel"]
                        if relay.get("actualProfile"):
                            actual_profile = relay["actualProfile"]
            else:
                raw = json.loads(r.read().decode())
                text = (((raw.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
                err = str(raw.get("error") or "") or None
                relay = raw.get("relay") or {}
                timing = relay.get("timing")
    except Exception as e:
        err = str(e)[:240]
    ttlb = int((time.time() - t0) * 1000)
    return {
        "ok": bool(text) and not err,
        "ttft_ms": ttft,
        "ttlb_ms": ttlb,
        "chars": len(text),
        "error": err,
        "timing": timing,
        "actual_model": actual_model,
        "actual_profile": actual_profile,
        "preview": (text or "")[:80],
    }

def summarize(rows):
    ok = [r for r in rows if r.get("ok")]
    ttft = [r["ttft_ms"] for r in ok if r.get("ttft_ms") is not None]
    ttlb = [r["ttlb_ms"] for r in ok]
    def pack(xs):
        if not xs:
            return {"n": 0}
        return {
            "n": len(xs),
            "p50": percentile(xs, 50),
            "p90": percentile(xs, 90),
            "p95": percentile(xs, 95),
            "max": max(xs),
            "min": min(xs),
            "mean": int(statistics.mean(xs)),
        }
    return {
        "runs": len(rows),
        "success": len(ok),
        "success_rate": round(len(ok) / max(1, len(rows)), 3),
        "ttft": pack(ttft),
        "ttlb": pack(ttlb),
        "errors": [r.get("error") for r in rows if r.get("error")][:8],
        "actual_profiles": sorted({r.get("actual_profile") or "unknown" for r in ok}),
        "actual_models": sorted({r.get("actual_model") or "unknown" for r in ok}),
    }

def main():
    rows = []
    for i in range(N):
        print("run", i + 1, "/", N, flush=True)
        row = one(stream=True)
        print(" ", "ok" if row["ok"] else "FAIL", "ttft", row.get("ttft_ms"), "ttlb", row.get("ttlb_ms"), (row.get("error") or "")[:80], flush=True)
        rows.append(row)
        time.sleep(1.2)
    report = {
        "prompt": PROMPT,
        "n": N,
        "summary": summarize(rows),
        "rows": rows,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
