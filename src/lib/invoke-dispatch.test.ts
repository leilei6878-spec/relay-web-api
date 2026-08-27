import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeInvokePath } from "./invoke-path.ts";

test("invoke path allowlist", () => {
  assert.equal(normalizeInvokePath("/v1/images/generations"), "/v1/images/generations");
  assert.equal(normalizeInvokePath("/v1/images/edits"), "/v1/images/edits");
  assert.equal(
    normalizeInvokePath("/v1beta/models/gemini-2.5-flash-image:generateContent"),
    "/v1beta/models/gemini-2.5-flash-image:generateContent",
  );
  assert.equal(normalizeInvokePath("/etc/passwd"), "/v1/chat/completions");
});

test("admin invoke source never nested-fetches a public origin", () => {
  const src = readFileSync(new URL("./invoke-dispatch.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../routes/api/admin/invoke.ts", import.meta.url), "utf8");
  assert.equal(src.includes("fetch("), false);
  assert.equal(route.includes("fetch("), false);
  assert.equal(route.includes("internalGatewayOrigin"), false);
  assert.match(src, /handleImage/);
  assert.match(src, /dispatchAdminInvoke/);
  assert.match(route, /dispatchAdminInvoke/);
});
