import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { localWorkerScript } from "./local-worker-script.ts";

test("worker python compiles and gemini has no fake success", () => {
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", localWorkerScript());
  const compiled = spawnSync("python3", ["-m", "py_compile", "/tmp/relay-qa/worker.py"], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);

  const live = spawnSync(
    "python3",
    [
      "-c",
      "import importlib.util, os, json; os.environ.pop('RELAY_ALLOW_MOCK', None); os.environ.pop('RELAY_TEST_URL', None); spec=importlib.util.spec_from_file_location('w','/tmp/relay-qa/worker.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print(json.dumps(m.run_image({'prompt':'cat'})))",
    ],
    { encoding: "utf8" },
  );
  assert.equal(live.status, 0, live.stderr);
  const body = JSON.parse(live.stdout.trim().split("\\n").pop() || "{}");
  assert.equal(body.ok, false);
  assert.match(body.error || "", /SESSION_INVALID/);

  const mock = spawnSync(
    "python3",
    [
      "-c",
      "import importlib.util, os, json; os.environ['RELAY_ALLOW_MOCK']='1'; spec=importlib.util.spec_from_file_location('w','/tmp/relay-qa/worker.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print(json.dumps(m.run_image({'prompt':'cat'})))",
    ],
    { encoding: "utf8" },
  );
  assert.equal(mock.status, 0, mock.stderr);
  const mocked = JSON.parse(mock.stdout.trim().split("\n").pop() || "{}");
  assert.equal(mocked.ok, true);
  assert.equal(mocked.mode, "mock");
});

test("page state error mapping and image false-positive rejection", () => {
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", localWorkerScript());
  const out = spawnSync(
    "python3",
    [
      "-c",
      "import importlib.util, os\nos.environ.pop('RELAY_ALLOW_MOCK', None)\nspec=importlib.util.spec_from_file_location('w','/tmp/relay-qa/worker.py')\nm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nerr, fault = m.page_state_error('AUTHENTICATED', True)\nassert 'PROVIDER_DOM_CHANGED' in err, err\nassert fault == 'provider'\nerr2, fault2 = m.page_state_error('LOGIN_REQUIRED', True)\nassert 'LOGIN_REQUIRED' in err2\nassert fault2 == 'account'\nassert m.accept_result_image('https://x/favicon.ico', []) is False\nassert m.accept_result_image('https://lh3.googleusercontent.com/old', ['https://lh3.googleusercontent.com/old']) is False\nassert m.accept_result_image('https://lh3.googleusercontent.com/new', ['https://lh3.googleusercontent.com/old']) is True\nassert m.accept_result_image('data:image/svg+xml;base64,AAA', []) is False\nassert m.usable_assistant_text('Analyzing image') is False\nassert m.usable_assistant_text('这张海报构图清楚，主体突出。') is True\nprint('ok')\n",
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});

test("run_leonardo without session is LOGIN_REQUIRED and never fake-success", () => {
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", localWorkerScript());
  const live = spawnSync(
    "python3",
    [
      "-c",
      "import importlib.util, os, json; os.environ.pop('RELAY_ALLOW_MOCK', None); os.environ.pop('RELAY_TEST_URL', None); spec=importlib.util.spec_from_file_location('w','/tmp/relay-qa/worker.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print(json.dumps(m.run_leonardo({'prompt':'cat','model':'leonardo-gemini'})))",
    ],
    { encoding: "utf8" },
  );
  assert.equal(live.status, 0, live.stderr);
  const body = JSON.parse(live.stdout.trim().split("\\n").pop() || "{}");
  assert.equal(body.ok, false);
  assert.match(body.error || "", /LEONARDO_LOGIN_REQUIRED|LEONARDO_PROXY/);
  assert.notEqual(body.mode, "mock");
});

test("leonardo accept_result_image rejects history and icons", () => {
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", localWorkerScript());
  const out = spawnSync(
    "python3",
    [
      "-c",
      "import importlib.util, os\nspec=importlib.util.spec_from_file_location('w','/tmp/relay-qa/worker.py')\nm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nassert m.accept_result_image('https://cdn.leonardo.ai/favicon.ico', []) is False\nassert m.accept_result_image('https://cdn.leonardo.ai/old.png', ['https://cdn.leonardo.ai/old.png']) is False\nassert m.accept_result_image('https://cdn.leonardo.ai/users/new.png', ['https://cdn.leonardo.ai/old.png']) is True\nassert m.accept_result_image('data:image/svg+xml;base64,AAA', []) is False\nprint('ok')\n",
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});

test("apply_image_size clicks Image Dimensions chips then Small/Medium/Large", () => {
  const s = localWorkerScript();
  assert.match(s, /def click_leonardo_aspect/);
  assert.match(s, /Facebook \(16:9\)/);
  assert.match(s, /Ultrawide \(21:9\)/);
  assert.match(s, /TikTok \(9:16\)/);
  assert.match(s, /skip-square/);
  assert.match(s, /def aspect_match/);
  assert.match(s, /LEONARDO_RESULT_ASPECT_MISMATCH/);
  assert.match(s, /Image Dimensions stayed/);
  const fn = s.slice(s.indexOf("def click_leonardo_resolution"), s.indexOf("def read_displayed_size"));
  assert.match(fn, /squarePreset/);
  assert.equal(fn.includes("aspect !== '1:1'"), true);
});

test("worker maps 1264x848 to 3:2 and 16:9 size token to 1376x768", () => {
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", localWorkerScript());
  const out = spawnSync(
    "python3",
    [
      "-c",
      "import importlib.util\nspec=importlib.util.spec_from_file_location('w','/tmp/relay-qa/worker.py')\nm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nassert m.size_to_aspect('1264x848')=='3:2', m.size_to_aspect('1264x848')\nassert m.size_to_aspect('1376x768')=='16:9'\nassert m.size_to_aspect('16:9')=='16:9'\nassert m.size_to_aspect('5504x3072')=='16:9'\nassert m.parse_size_wh('16:9')==(1376,768)\nassert m.parse_size_wh('1536x1024')==(1536,1024)\nassert m.parse_size_wh('5504x3072')==(5504,3072)\nprint('ok')\n",
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});

test("leonardo img2img attaches refs before generate and fail-fasts", () => {
  const s = localWorkerScript();
  assert.match(s, /def wait_leonardo_generate_ready/);
  assert.match(s, /def ref_body_sizes/);
  assert.match(s, /generate did not start \(img2img\)/);
  assert.match(s, /generate did not become ready after refs/);
  assert.match(s, /reference image did not attach/);
  const attachIdx = s.indexOf("up_err = attach_leonardo_refs");
  const readyIdx = s.indexOf("wait_leonardo_generate_ready(page, 20000)");
  const baselineIdx = s.lastIndexOf("create_generation_boundary(page, ctx, \"leonardo\")");
  const clickIdx = s.indexOf('print("leonardo clicking generate"');
  const sizeAfter = s.indexOf("apply_image_size(page, want_size, aspect, tier, gpt)", attachIdx);
  assert.ok(attachIdx > 0 && readyIdx > attachIdx, "wait generate ready after attach");
  assert.ok(sizeAfter > attachIdx && sizeAfter < readyIdx, "re-apply size after refs");
  assert.ok(baselineIdx > readyIdx, "boundary after refs, not before");
  assert.ok(clickIdx > baselineIdx, "click generate after boundary");
});

test("ref_body_sizes and extract_prompt_images keep leonardo refs", () => {
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", localWorkerScript());
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const out = spawnSync(
    "python3",
    [
      "-c",
      `import importlib.util
spec=importlib.util.spec_from_file_location('w','/tmp/relay-qa/worker.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
url=${JSON.stringify(dataUrl)}
prompt, imgs = m.extract_prompt_images({"model":"nano-banana-2","prompt":"edit me","images":[url]})
assert prompt=="edit me"
assert len(imgs)==1
sizes=m.ref_body_sizes(imgs)
assert ${png.length} in sizes, sizes
print("ok")
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});

test("production job_proxy never falls back to a different local SOCKS", () => {
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", localWorkerScript());
  const out = spawnSync(
    "python3",
    [
      "-c",
      `
import importlib.util, os
os.environ["NODE_ENV"] = "production"
os.environ.pop("RELAY_ALLOW_PROXY_FALLBACK", None)
spec = importlib.util.spec_from_file_location("w", "/tmp/relay-qa/worker.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.pick_proxy = lambda: {"server": "socks5://127.0.0.1:10808", "id": "B"}
m.port_open = lambda port: int(port) == 10808
m.socks_https_ok = lambda c: str((c or {}).get("server") or "").endswith(":10808")
body = {"proxy": {"server": "socks5://127.0.0.1:18080", "id": "A"}, "proxyId": "A"}
assert m.job_proxy(body) is None, m.job_proxy(body)
assert "assigned proxy unreachable" in m.proxy_fail_error(body)
m.port_open = lambda port: True
m.socks_https_ok = lambda c: True
got = m.job_proxy(body)
assert got["server"] == "socks5://127.0.0.1:18080", got
assert got["id"] == "A"
assert m.job_proxy({}) is None
err = m.proxy_identity_error(body, {"server": "socks5://127.0.0.1:10808", "id": "B"})
assert err and "PROXY_IDENTITY_MISMATCH" in err, err
os.environ["NODE_ENV"] = "development"
os.environ["RELAY_ALLOW_PROXY_FALLBACK"] = "1"
m.socks_https_ok = lambda c: True
m.port_open = lambda port: True
fb = m.job_proxy({})
assert fb and "10808" in fb["server"], fb
print("ok")
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});

test("worker script has no current-job os.environ and JobRuntimeContext isolates chunks", () => {
  const s = localWorkerScript();
  assert.match(s, /class JobRuntimeContext/);
  assert.match(s, /def post_chunk\(text, phase="", ctx=None\)/);
  assert.match(s, /def post_result\(ctx, result\)/);
  assert.match(s, /register_job\(ctx\)/);
  assert.equal(s.includes('os.environ["RELAY_JOB_ID"]'), false);
  assert.equal(s.includes('os.environ["RELAY_LEASE_ID"]'), false);
  assert.equal(s.includes('os.environ["RELAY_ATTEMPT_ID"]'), false);
  assert.equal(s.includes('os.environ["RELAY_FENCE"]'), false);
  assert.equal(s.includes('os.environ["RELAY_ACCOUNT_ID"]'), false);
  assert.equal(s.includes('os.environ.get("RELAY_JOB_ID")'), false);
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", s);
  const out = spawnSync(
    "python3",
    [
      "-c",
      `
import importlib.util, os, json, threading
os.environ["RELAY_GATEWAY"] = "http://gw.test"
os.environ["RELAY_TOKEN"] = "tok"
os.environ["RELAY_JOB_ID"] = "ENV-SHOULD-NOT-BE-USED"
os.environ["RELAY_LEASE_ID"] = "ENV-LEASE"
os.environ["RELAY_ATTEMPT_ID"] = "ENV-ATT"
os.environ["RELAY_FENCE"] = "99"
os.environ["RELAY_ACCOUNT_ID"] = "ENV-ACC"
os.environ["RELAY_ALLOW_MOCK"] = "1"
spec = importlib.util.spec_from_file_location("w", "/tmp/relay-qa/worker.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
captured = []
class FakeResp:
    def read(self):
        return b"{}"
def fake_urlopen(req, timeout=8):
    captured.append(json.loads(req.data.decode()))
    return FakeResp()
import urllib.request
urllib.request.urlopen = fake_urlopen
a = m.JobRuntimeContext({"id":"job-a","leaseId":"la","attemptId":"aa","fencingToken":1,"accountId":"acc-a","requestId":"req-a"})
b = m.JobRuntimeContext({"id":"job-b","leaseId":"lb","attemptId":"ab","fencingToken":2,"accountId":"acc-b","requestId":"req-b"})
m.post_chunk("hello-a", "", a)
m.post_chunk("hello-b", "", b)
m.post_chunk("from-env")
m.post_phase("generating")
assert [p["id"] for p in captured] == ["job-a", "job-b"], captured
assert captured[0]["text"] == "hello-a" and captured[0]["leaseId"] == "la"
assert captured[1]["text"] == "hello-b" and captured[1]["attemptId"] == "ab"
before = os.environ.get("RELAY_JOB_ID")
r = m.exec_job_run({"id":"job-x","leaseId":"lease-x","attemptId":"att-x","fencingToken":7,"accountId":"acc-x","platform":"gemini","kind":"image","prompt":"cat"})
assert os.environ.get("RELAY_JOB_ID") == before, os.environ.get("RELAY_JOB_ID")
assert r.get("leaseId") == "lease-x"
assert r.get("attemptId") == "att-x"
assert r.get("accountId") == "acc-x"
assert m.snapshot_active_jobs() == []
results = [None, None, None]
def run_one(i):
    results[i] = m.exec_job_run({"id":"job%d"%i,"leaseId":"lease-%d"%i,"attemptId":"att-%d"%i,"fencingToken":i+1,"accountId":"acc-%d"%i,"platform":"gemini","kind":"image","prompt":"cat"})
threads = [threading.Thread(target=run_one, args=(i,)) for i in range(3)]
for t in threads: t.start()
for t in threads: t.join()
for i, row in enumerate(results):
    assert row["ok"] is True, row
    assert row["leaseId"] == "lease-%d" % i, row
    assert row["attemptId"] == "att-%d" % i, row
    assert row["accountId"] == "acc-%d" % i, row
    assert row.get("traceId") == "job%d" % i
print("ok")
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});

test("playwright shards run distinct accounts in parallel and serialize the same account", () => {
  const s = localWorkerScript();
  assert.match(s, /class PlaywrightShard/);
  assert.match(s, /RELAY_PLAYWRIGHT_SHARDS/);
  assert.match(s, /def shard_for_account/);
  assert.match(s, /start_shards\(\)/);
  assert.match(s, /def _run\(payload=payload\)/);
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", s);
  const out = spawnSync(
    "python3",
    [
      "-c",
      `
import importlib.util, os, threading, time
os.environ["RELAY_ALLOW_MOCK"] = "1"
os.environ["RELAY_SKIP_WARM"] = "1"
os.environ["RELAY_PLAYWRIGHT_SHARDS"] = "3"
os.environ["RELAY_CAPACITY"] = "3"
spec = importlib.util.spec_from_file_location("w", "/tmp/relay-qa/worker.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.SHARD_COUNT == 3
assert m.shard_for_account("acc-1") == m.shard_for_account("acc-1")
assert m.shard_for_account("") == 0
by_shard = {}
i = 0
while len(by_shard) < 3 and i < 5000:
    aid = "acc-%d" % i
    sid = m.shard_for_account(aid)
    by_shard.setdefault(sid, aid)
    i += 1
assert len(by_shard) == 3, by_shard
orig = m.run_image
overlap = {"n": 0, "max": 0, "lock": threading.Lock(), "accounts": []}
def slow_image(body, ctx=None):
    aid = str((body or {}).get("accountId") or "")
    with overlap["lock"]:
        overlap["n"] += 1
        overlap["max"] = max(overlap["max"], overlap["n"])
        overlap["accounts"].append((aid, overlap["n"]))
    time.sleep(0.25)
    try:
        return orig(body, ctx)
    finally:
        with overlap["lock"]:
            overlap["n"] -= 1
m.run_image = slow_image
m.start_shards()
time.sleep(0.05)
ids = [by_shard[k] for k in sorted(by_shard)]
results = [None, None, None]
def run_one(i):
    results[i] = m.exec_job({"id":"par-%d"%i,"accountId":ids[i],"platform":"gemini","kind":"image","prompt":"cat","leaseId":"L%d"%i,"attemptId":"A%d"%i})
threads = [threading.Thread(target=run_one, args=(i,)) for i in range(3)]
t0 = time.time()
for t in threads: t.start()
for t in threads: t.join()
elapsed = time.time() - t0
assert overlap["max"] >= 2, overlap
assert elapsed < 0.7, elapsed
for row in results:
    assert row and row.get("ok") is True, row
same = {"n": 0, "max": 0, "lock": threading.Lock()}
def slow_same(body, ctx=None):
    with same["lock"]:
        same["n"] += 1
        same["max"] = max(same["max"], same["n"])
    time.sleep(0.12)
    try:
        return orig(body, ctx)
    finally:
        with same["lock"]:
            same["n"] -= 1
m.run_image = slow_same
same_results = [None, None, None]
def run_same(i):
    same_results[i] = m.exec_job({"id":"ser-%d"%i,"accountId":ids[0],"platform":"gemini","kind":"image","prompt":"cat"})
threads = [threading.Thread(target=run_same, args=(i,)) for i in range(3)]
for t in threads: t.start()
for t in threads: t.join()
assert same["max"] == 1, same
for s in m.SHARDS:
    s.q.put(None)
print("ok")
`,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});

test("submission state machine marks post-submit retry unsafe", () => {
  const s = localWorkerScript();
  assert.match(s, /def set_submission_state/);
  assert.match(s, /def fail_job/);
  assert.match(s, /SUBMISSION_UNCERTAIN/);
  assert.match(s, /RESULT_UNCERTAIN/);
  assert.match(s, /retrySafety/);
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", s);
  const out = spawnSync(
    "python3",
    [
      "-c",
      `
import importlib.util
spec = importlib.util.spec_from_file_location("w", "/tmp/relay-qa/worker.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ctx = m.JobRuntimeContext({"id":"j1","accountId":"a1"})
assert ctx.retry_safety == "SAFE"
m.set_submission_state(ctx, "COMPOSER_READY")
assert ctx.retry_safety == "SAFE"
m.set_submission_state(ctx, "SUBMITTING")
assert ctx.retry_safety == "UNKNOWN"
m.set_submission_state(ctx, "SUBMITTED")
assert ctx.retry_safety == "UNSAFE"
fail = m.fail_job(ctx, "RESULT_UNCERTAIN: timeout")
assert fail["retrySafety"] == "UNSAFE"
assert fail["ok"] is False
unk = m.JobRuntimeContext({"id":"j2"})
m.set_submission_state(unk, "SUBMISSION_UNCERTAIN")
assert unk.retry_safety == "UNKNOWN"
print("ok")
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});

test("warmup_respects_account_proxy and shard owner", () => {
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", localWorkerScript());
  const out = spawnSync(
    "python3",
    [
      "-c",
      `
import importlib.util
spec = importlib.util.spec_from_file_location("w", "/tmp/relay-qa/worker.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
found = [("acc-A", "/s/acc-A.json"), ("acc-B", "/s/acc-B.json"), ("acc-C", "/s/acc-C.json")]
proxies = {
  "acc-A": {"id": "pA", "server": "socks5://10.0.0.1:1080"},
  "acc-B": {"id": "pB", "server": "socks5://10.0.0.2:1080"},
}
plan0 = m.warmup_plan(found, 0, proxies, 3)
plan1 = m.warmup_plan(found, 1, proxies, 3)
plan2 = m.warmup_plan(found, 2, proxies, 3)
all_rows = plan0 + plan1 + plan2
ids = [r["accountId"] for r in all_rows]
assert "acc-C" not in ids, ids
assert "acc-A" in ids and "acc-B" in ids
for r in all_rows:
    assert r["proxy"]["id"] in ("pA", "pB")
    if r["accountId"] == "acc-A":
        assert r["proxy"]["server"].endswith("10.0.0.1:1080")
    if r["accountId"] == "acc-B":
        assert r["proxy"]["server"].endswith("10.0.0.2:1080")
    assert r["shard"] == m.shard_for_account(r["accountId"]) if m.SHARD_COUNT == 3 else True
from collections import Counter
c = Counter(ids)
assert all(v == 1 for v in c.values()), c
none = m.warmup_plan(found, 0, {}, 3)
assert none == []
print("ok")
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});

test("generation boundary locators prefer new containers over page-wide img", () => {
  const s = localWorkerScript();
  assert.match(s, /def create_generation_boundary/);
  assert.match(s, /def gemini_result_locator/);
  assert.match(s, /def leonardo_result_locator/);
  assert.match(s, /def score_result_candidate/);
  const start = s.indexOf("def run_image_on");
  const geminiFn = s.slice(start, s.indexOf("if pool_enabled():", start));
  assert.equal(geminiFn.includes('page.locator("img")'), false, "gemini wait must not scan all img first");
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", s);
  const out = spawnSync(
    "python3",
    [
      "-c",
      `
import importlib.util
spec = importlib.util.spec_from_file_location("w", "/tmp/relay-qa/worker.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
new = {"src":"https://lh3.googleusercontent.com/gen-NEW","containerId":"resp-new","createdAfterSubmit":True,"isNewContainer":True,"isNewSrc":True,"domainMatch":True,"width":1376,"height":768,"bytes":180000,"mime":"image/png","sha256":"n","referenceDuplicate":False,"historicalDuplicate":False}
hist = dict(new, src="https://lh3.googleusercontent.com/history-0", containerId="hist", createdAfterSubmit=False, isNewContainer=False, isNewSrc=False, historicalDuplicate=True)
ref = dict(new, src="https://lh3.googleusercontent.com/ref-a", containerId="composer-ref", isNewContainer=False, referenceDuplicate=True)
avatar = dict(new, src="https://lh3.googleusercontent.com/avatar.png", width=32, height=32, isNewContainer=False)
picked = m.pick_accepted_candidates([hist, ref, avatar, new], 1)
assert len(picked)==1 and picked[0]["src"].endswith("gen-NEW"), picked
assert m.score_result_candidate(hist)=="REJECT"
assert m.score_result_candidate(ref)=="REJECT"
print("ok")
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});

test("exact reference count 1/2/4/6 and sha256 isolation", () => {
  const s = localWorkerScript();
  assert.match(s, /def describe_references/);
  assert.match(s, /def count_leonardo_refs/);
  assert.match(s, /def count_gemini_refs/);
  assert.match(s, /def attachment_incomplete/);
  assert.match(s, /def result_is_reference/);
  assert.match(s, /REFERENCE_ATTACH_INCOMPLETE/);
  assert.match(s, /RESULT_IS_REFERENCE_IMAGE/);
  const leoClick = s.indexOf('print("leonardo clicking generate"');
  const lastIncomplete = s.lastIndexOf("attachment_incomplete(requested");
  assert.ok(lastIncomplete > 0 && lastIncomplete < leoClick, "leonardo exact-count gate before Generate");
  const start = s.indexOf("def run_image_on");
  const geminiFn = s.slice(start, s.indexOf("if pool_enabled():", start));
  assert.ok(geminiFn.includes("attachment_incomplete"), "gemini exact-count gate");
  assert.ok(geminiFn.indexOf("attachment_incomplete") < geminiFn.indexOf("click_send"), "gemini count before send");
  mkdirSync("/tmp/relay-qa", { recursive: true });
  writeFileSync("/tmp/relay-qa/worker.py", s);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const out = spawnSync(
    "python3",
    [
      "-c",
      `
import importlib.util, hashlib, base64
spec = importlib.util.spec_from_file_location("w", "/tmp/relay-qa/worker.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
url = ${JSON.stringify(dataUrl)}
raw = base64.b64decode(url.split(",",1)[1])
digest = hashlib.sha256(raw).hexdigest()
for n in (1, 2, 4, 6):
    imgs = [url] * n
    requested, hashes, descs = m.bind_reference_hashes(m.JobRuntimeContext({}), imgs)
    assert requested == n, (requested, n)
    assert digest in hashes
    assert m.attachment_incomplete(n, n) is None
    assert "REFERENCE_ATTACH_INCOMPLETE" in (m.attachment_incomplete(n, n - 1) or "")
assert m.result_is_reference(raw, [digest]) is True
assert m.result_is_reference(raw + b"x", [digest]) is False
assert m.result_is_reference(raw, []) is False
print("reference-verify-ok")
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /reference-verify-ok/);
});
