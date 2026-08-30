import assert from "node:assert/strict";
import { test } from "node:test";
import { trustedClientIp, trustedProxyNetworkConfigured } from "./client-network.ts";

const request = new Request("https://relay.example.test", {
  headers: {
    "x-real-ip": "203.0.113.10",
    "x-forwarded-for": "198.51.100.20, 10.0.0.2",
    "cf-connecting-ip": "192.0.2.30",
  },
});

test("production ignores every forwarding header until the proxy trust boundary is explicit", () => {
  assert.equal(trustedClientIp(request, { NODE_ENV: "production" } as NodeJS.ProcessEnv), "unknown");
  assert.equal(trustedProxyNetworkConfigured({ NODE_ENV: "production" } as NodeJS.ProcessEnv), false);
});

test("one configured edge header wins and forged competing headers are ignored", () => {
  const real = { NODE_ENV: "production", RELAY_TRUST_PROXY_HEADERS: "1", RELAY_CLIENT_IP_HEADER: "x-real-ip" } as NodeJS.ProcessEnv;
  const cloudflare = { NODE_ENV: "production", RELAY_TRUST_PROXY_HEADERS: "1", RELAY_CLIENT_IP_HEADER: "cf-connecting-ip" } as NodeJS.ProcessEnv;
  assert.equal(trustedClientIp(request, real), "203.0.113.10");
  assert.equal(trustedClientIp(request, cloudflare), "192.0.2.30");
  assert.equal(trustedProxyNetworkConfigured(real), true);
});

test("X-Forwarded-For is accepted only when explicitly selected and edge-overwritten", () => {
  const env = { NODE_ENV: "production", RELAY_TRUST_PROXY_HEADERS: "1", RELAY_CLIENT_IP_HEADER: "x-forwarded-for" } as NodeJS.ProcessEnv;
  assert.equal(trustedClientIp(request, env), "198.51.100.20");
});

test("malformed, multi-valued single-IP headers and invalid configuration fail closed", () => {
  const base = { NODE_ENV: "production", RELAY_TRUST_PROXY_HEADERS: "1", RELAY_CLIENT_IP_HEADER: "x-real-ip" } as NodeJS.ProcessEnv;
  assert.equal(trustedClientIp(new Request("https://relay", { headers: { "x-real-ip": "203.0.113.1, 198.51.100.1" } }), base), "unknown");
  assert.equal(trustedClientIp(new Request("https://relay", { headers: { "x-real-ip": "not-an-ip" } }), base), "unknown");
  assert.equal(trustedClientIp(request, { ...base, RELAY_CLIENT_IP_HEADER: "x-client-ip" }), "unknown");
  assert.equal(trustedProxyNetworkConfigured({ ...base, RELAY_CLIENT_IP_HEADER: "x-client-ip" }), false);
});

test("IPv4-mapped IPv6 is canonicalized and development defaults only to X-Real-IP", () => {
  assert.equal(trustedClientIp(new Request("https://relay", { headers: { "x-real-ip": "::ffff:203.0.113.44" } }), { NODE_ENV: "development" } as NodeJS.ProcessEnv), "203.0.113.44");
  assert.equal(trustedClientIp(new Request("https://relay", { headers: { "x-forwarded-for": "198.51.100.9" } }), { NODE_ENV: "development" } as NodeJS.ProcessEnv), "unknown");
});

