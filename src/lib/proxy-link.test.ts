import assert from "node:assert/strict";
import { test } from "node:test";
import { parseShareLink } from "./proxy-link.ts";

test("SIP002 method:password@host:port#name", () => {
  // aes-256-gcm:test
  const parsed = parseShareLink("ss://YWVzLTI1Ni1nY206dGVzdA@example.com:8388#demo");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.host, "example.com");
  assert.equal(parsed.data.port, 8388);
  assert.equal(parsed.data.password, "test");
  assert.equal(parsed.data.method, "aes-256-gcm");
  assert.equal(parsed.data.name, "demo");
});

test("query string after port is ignored (Outline / ?plugin=)", () => {
  const parsed = parseShareLink("ss://YWVzLTI1Ni1nY206dGVzdA@example.com:8388/?outline=1#box");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.host, "example.com");
  assert.equal(parsed.data.port, 8388);
  assert.equal(parsed.data.name, "box");
});

test("legacy whole-URI base64 method:password@host:port", () => {
  const parsed = parseShareLink("ss://YWVzLTI1Ni1nY206dGVzdEBleGFtcGxlLmNvbTo4Mzg4#legacy");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.host, "example.com");
  assert.equal(parsed.data.port, 8388);
  assert.equal(parsed.data.password, "test");
});

test("whitespace / wrapped paste still parses", () => {
  const parsed = parseShareLink("ss://YWVzLTI1Ni1nY206dGVzdA@\nexample.com:8388#wrap");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.host, "example.com");
  assert.equal(parsed.data.port, 8388);
});

test("userinfo-only paste explains missing host", () => {
  const parsed = parseShareLink("ss://YWVzLTI1Ni1nY206dGVzdA");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /主机或端口/);
});

test("percent-encoded method:password@host", () => {
  const parsed = parseShareLink("ss://aes-256-gcm:test@10.0.0.1:9443#plain");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.host, "10.0.0.1");
  assert.equal(parsed.data.port, 9443);
  assert.equal(parsed.data.password, "test");
});
