import assert from "node:assert/strict";
import { test } from "node:test";
import { resetCoordForTests } from "./coord.ts";
import { canDispatch, getCircuit, recordCanaryResult, recordProviderFault, resetCircuit } from "./circuit.ts";

test("unique-account DOM faults trip the provider circuit, not a single account", async () => {
  resetCoordForTests();
  process.env.RELAY_CIRCUIT_TRIP = "3";
  await resetCircuit("chatgpt");
  await recordProviderFault("chatgpt", "PROVIDER_DOM_CHANGED", "a1");
  await recordProviderFault("chatgpt", "PROVIDER_DOM_CHANGED", "a1");
  let snap = await getCircuit("chatgpt");
  assert.notEqual(snap.state, "OPEN");
  await recordProviderFault("chatgpt", "PROVIDER_DOM_CHANGED", "a2");
  snap = await getCircuit("chatgpt");
  assert.equal(snap.state, "DEGRADED");
  await recordProviderFault("chatgpt", "PROVIDER_DOM_CHANGED", "a3");
  snap = await getCircuit("chatgpt");
  assert.equal(snap.state, "OPEN");
  assert.equal(await canDispatch("chatgpt", false), false);
  assert.equal(await canDispatch("chatgpt", true), true);
});

test("canary success closes the circuit; canary failure re-opens", async () => {
  resetCoordForTests();
  await recordCanaryResult("gemini", false);
  assert.equal((await getCircuit("gemini")).state, "OPEN");
  await recordCanaryResult("gemini", true);
  assert.equal((await getCircuit("gemini")).state, "HEALTHY");
});
