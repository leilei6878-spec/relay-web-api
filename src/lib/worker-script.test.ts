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
  const baselineIdx = s.lastIndexOf("baseline = snapshot_image_srcs(page)");
  const clickIdx = s.indexOf('print("leonardo clicking generate"');
  const sizeAfter = s.indexOf("apply_image_size(page, want_size, aspect, tier, gpt)", attachIdx);
  assert.ok(attachIdx > 0 && readyIdx > attachIdx, "wait generate ready after attach");
  assert.ok(sizeAfter > attachIdx && sizeAfter < readyIdx, "re-apply size after refs");
  assert.ok(baselineIdx > readyIdx, "snapshot after refs, not before");
  assert.ok(clickIdx > baselineIdx, "click generate after snapshot");
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
