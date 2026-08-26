import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("openapi.yaml declares public paths and excludes admin/worker", () => {
  const text = readFileSync("openapi.yaml", "utf8");
  for (const p of [
    "/v1/models",
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/images/generations",
    "/v1/images/edits",
  ]) {
    assert.match(text, new RegExp(p.replaceAll("/", "\\/")));
  }
  assert.doesNotMatch(text, /\/api\/admin\//);
  assert.doesNotMatch(text, /\/api\/worker\//);
  assert.match(text, /bearerAuth/);
  assert.match(text, /sk-relay/);
});
