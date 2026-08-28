import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { publicRelayMeta } from "./public-relay-meta.ts";

const PRIVATE_FIELDS = ["accountEmail", "account_email", "workerId", "worker_id", "accountId", "account_id", "proxyId", "proxy_id"];

test("public relay metadata strips account identity and internal topology", () => {
  const publicMeta = publicRelayMeta({
    accountEmail: "operator@example.invalid",
    workerId: "worker-private",
    accountId: "account-private",
    proxyId: "proxy-private",
    jobId: "job-public",
    requestId: "request-public",
    model_verified: false,
  });

  assert.deepEqual(publicMeta, {
    jobId: "job-public",
    requestId: "request-public",
    model_verified: false,
  });
});

test("public route relay object literals cannot bypass the metadata boundary", () => {
  const routeFiles = [
    new URL("../routes/v1/chat/completions.ts", import.meta.url),
    new URL("../routes/v1/responses.ts", import.meta.url),
    new URL("../routes/v1/images/generations.ts", import.meta.url),
  ];

  for (const routeFile of routeFiles) {
    const source = readFileSync(routeFile, "utf8");
    for (const field of PRIVATE_FIELDS) {
      assert.doesNotMatch(
        source,
        new RegExp(`relay\\s*:\\s*\\{[^}]*\\b${field}\\s*:`, "gs"),
        `${routeFile.pathname} serializes private relay field ${field}`,
      );
    }
  }
});
