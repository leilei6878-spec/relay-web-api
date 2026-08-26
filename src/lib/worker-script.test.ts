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
  const body = JSON.parse(live.stdout.trim().split("\n").pop() || "{}");
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
      "import importlib.util, os\nos.environ.pop('RELAY_ALLOW_MOCK', None)\nspec=importlib.util.spec_from_file_location('w','/tmp/relay-qa/worker.py')\nm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nerr, fault = m.page_state_error('AUTHENTICATED', True)\nassert 'PROVIDER_DOM_CHANGED' in err, err\nassert fault == 'provider'\nerr2, fault2 = m.page_state_error('LOGIN_REQUIRED', True)\nassert 'LOGIN_REQUIRED' in err2\nassert fault2 == 'account'\nassert m.accept_result_image('https://x/favicon.ico', []) is False\nassert m.accept_result_image('https://lh3.googleusercontent.com/old', ['https://lh3.googleusercontent.com/old']) is False\nassert m.accept_result_image('https://lh3.googleusercontent.com/new', ['https://lh3.googleusercontent.com/old']) is True\nassert m.accept_result_image('data:image/svg+xml;base64,AAA', []) is False\nprint('ok')\n",
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /ok/);
});
