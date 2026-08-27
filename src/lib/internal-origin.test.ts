import assert from "node:assert/strict";
import { test } from "node:test";
import { internalGatewayOrigin } from "./internal-origin.ts";

test("loopback helper still ignores the public preview origin", () => {
  assert.equal(internalGatewayOrigin("https://preview.example.com/api/admin/invoke"), "http://127.0.0.1:8080");
  assert.equal(internalGatewayOrigin("http://127.0.0.1:8080/api/admin/invoke"), "http://127.0.0.1:8080");
  assert.equal(internalGatewayOrigin("http://localhost:8080/api/admin/invoke"), "http://localhost:8080");
});
