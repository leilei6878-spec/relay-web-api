import assert from "node:assert/strict";
import { test } from "node:test";
import { secureInspectionRequest } from "./account-inspections.ts";
import { localWorkerScript } from "./local-worker-script.ts";

test("production account inspection is HTTPS-only and trusts the edge protocol", () => {
  assert.equal(
    secureInspectionRequest(new Request("http://38.175.201.137/api/admin/account-inspections"), { NODE_ENV: "production" }),
    false,
  );
  assert.equal(
    secureInspectionRequest(
      new Request("http://gateway/api/admin/account-inspections", { headers: { "x-forwarded-proto": "https" } }),
      { NODE_ENV: "production" },
    ),
    true,
  );
  assert.equal(
    secureInspectionRequest(new Request("http://127.0.0.1:8080/api/admin/account-inspections"), { NODE_ENV: "development" }),
    true,
  );
});

test("worker inspection uses account-bound browser state without exposing raw cookies or CDP", () => {
  const script = localWorkerScript();
  assert.match(script, /def run_account_inspection/);
  assert.match(script, /get_pooled_context\(proxy, state, body\.get\("accountId"\)\)/);
  assert.match(script, /\/api\/worker\/account-inspections/);
  assert.match(script, /page\.screenshot\(type="jpeg"/);
  assert.match(script, /sessionState/);
  assert.doesNotMatch(script, /remote-debugging-port.*inspection/i);
  const inspectionBlock = script.slice(script.indexOf("def run_account_inspection"), script.indexOf("def exec_job(body)"));
  assert.doesNotMatch(inspectionBlock, /selected_model_label/);
  assert.match(script, /body\.get\("kind"\) == "inspection"[\s\S]{0,400}"status": "failed"/);
});

test("inspection jobs bypass paid image validation and provider counters", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./job-queue.ts", import.meta.url), "utf8"));
  const pgSource = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./pg-jobs.ts", import.meta.url), "utf8"));
  assert.match(source, /job\.kind !== "inspection"/);
  assert.match(pgSource, /current\.kind !== "inspection"/);
  assert.match(source, /job\.kind === "inspection"/);
  assert.match(pgSource, /current\.kind === "inspection"/);
  assert.match(source, /opts\.targetAccountId/);
  assert.match(pgSource, /opts\.targetAccountId/);
  const inspectionSource = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./account-inspections.ts", import.meta.url), "utf8"));
  assert.match(inspectionSource, /targetAccountId: account\.id/);
  assert.match(inspectionSource, /allowUnhealthyTarget: true/);
});
