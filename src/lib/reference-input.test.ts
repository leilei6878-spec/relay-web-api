import assert from "node:assert/strict";
import { test } from "node:test";
import { resetMediaStoreForTests } from "./media-store.ts";
import { ingestReferenceImages } from "./reference-input.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("data references become stable assets with exact descriptors", async () => {
  resetMediaStoreForTests();
  const data = `data:image/png;base64,${PNG.toString("base64")}`;
  const out = await ingestReferenceImages([data], "http://relay.test");
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.assets.length, 1);
  assert.match(out.assets[0]!.url, /^http:\/\/relay\.test\/api\/media\//);
  assert.doesNotMatch(out.assets[0]!.url, /^data:/);
  assert.equal(out.assets[0]!.bytes, PNG.length);
  assert.equal(out.assets[0]!.width, 1);
  assert.equal(out.assets[0]!.height, 1);
  assert.equal(out.assets[0]!.sha256.length, 64);
});

test("remote references are fetched exactly once before being frozen", async () => {
  resetMediaStoreForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(new Uint8Array(PNG), { headers: { "Content-Type": "image/png" } });
  }) as typeof fetch;
  try {
    const out = await ingestReferenceImages(["https://mutable.test/ref.png"], "http://relay.test");
    assert.equal(out.ok, true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
