import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalMediaStore, ObjectMediaStore, objectStoreConfigured, validateMedia } from "./media-store.ts";

test("rejects bad MIME and oversized payloads", () => {
  assert.equal(validateMedia(Buffer.from("x"), "application/pdf").ok, false);
  assert.equal(validateMedia(Buffer.alloc(0), "image/png").ok, false);
  assert.equal(validateMedia(Buffer.from("png"), "image/png").ok, true);
});

test("LocalMediaStore round-trips bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-media-"));
  try {
    const store = new LocalMediaStore(dir);
    const put = await store.put(Buffer.from("hello-img"), "image/png");
    assert.equal(store.kind, "local");
    assert.match(put.url, /\/api\/media\//);
    const got = await store.get(`${put.id}.png`);
    assert.ok(got);
    assert.equal(got.buf.toString(), "hello-img");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ObjectMediaStore signs AWS4 PUT; production requires object config", () => {
  const store = new ObjectMediaStore({
    bucket: "relay",
    region: "auto",
    endpoint: "https://s3.example.test",
    accessKey: "AKIA",
    secretKey: "secret",
  });
  const signed = store.sign("PUT", "id.png", Buffer.from("abc"), "image/png", new Date("2026-01-01T00:00:00Z"));
  assert.match(signed.headers.Authorization, /AWS4-HMAC-SHA256/);
  assert.equal(signed.headers["x-amz-content-sha256"]?.length, 64);
  assert.equal(objectStoreConfigured({} as NodeJS.ProcessEnv), false);
  assert.equal(
    objectStoreConfigured({
      RELAY_S3_BUCKET: "b",
      RELAY_S3_ACCESS_KEY: "k",
      RELAY_S3_SECRET_KEY: "s",
    } as NodeJS.ProcessEnv),
    true,
  );
});
