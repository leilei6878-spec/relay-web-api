import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "./reference-verify.ts";
import { resolveImageSpec } from "./image-size.ts";
import { detectMagicMime, readImageMeta, validateImageResults, validateOneImage } from "./image-result-validator.ts";

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function syntheticPng(w: number, h: number, minBytes = 4096): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = pngChunk("IDAT", Buffer.from([0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  let out = Buffer.concat([sig, pngChunk("IHDR", ihdr), idat, pngChunk("IEND", Buffer.alloc(0))]);
  if (out.length < minBytes) out = Buffer.concat([out, Buffer.alloc(minBytes - out.length, 0x00)]);
  return out;
}

function syntheticWebp(w: number, h: number, minBytes = 4096): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = 0x10;
  const wm1 = w - 1;
  const hm1 = h - 1;
  payload[4] = wm1 & 0xff;
  payload[5] = (wm1 >> 8) & 0xff;
  payload[6] = (wm1 >> 16) & 0xff;
  payload[7] = hm1 & 0xff;
  payload[8] = (hm1 >> 8) & 0xff;
  payload[9] = (hm1 >> 16) & 0xff;
  const out = Buffer.alloc(30);
  out.write("RIFF", 0);
  out.writeUInt32LE(22, 4);
  out.write("WEBP", 8);
  out.write("VP8X", 12);
  out.writeUInt32LE(10, 16);
  payload.copy(out, 20);
  if (out.length < minBytes) return Buffer.concat([out, Buffer.alloc(minBytes - out.length, 0)]);
  return out;
}

test("webp jpeg png magic and dimensions", () => {
  const png = syntheticPng(1376, 768);
  assert.equal(detectMagicMime(png), "image/png");
  assert.deepEqual(readImageMeta(png), { width: 1376, height: 768, type: "png" });
  const webp = syntheticWebp(1024, 1024);
  assert.equal(detectMagicMime(webp), "image/webp");
  const meta = readImageMeta(webp);
  assert.equal(meta?.width, 1024);
  assert.equal(meta?.height, 1024);
});

test("16:9 requested vs 1:1 actual is OUTPUT_SIZE_MISMATCH", () => {
  const square = syntheticPng(1024, 1024);
  const spec = resolveImageSpec({ model: "gemini-image", size: "16:9" });
  assert.equal(spec.ok, true);
  const bad = validateOneImage({ buf: square }, { spec: spec.ok ? spec.spec : undefined, n: 1 });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /OUTPUT_SIZE_MISMATCH/);
});

test("1536x1024 client alias matches native 1264x848", () => {
  const native = syntheticPng(1264, 848);
  const spec = resolveImageSpec({ model: "gpt-image-1", size: "1536x1024" });
  assert.equal(spec.ok, true);
  if (spec.ok) {
    assert.equal(spec.spec.size, "1264x848");
    const ok = validateOneImage({ buf: native }, { spec: spec.spec, n: 1 });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.result.width, 1264);
      assert.equal(ok.result.height, 848);
      assert.equal(ok.result.requestedSize, "1264x848");
      assert.equal(ok.result.actualAspect, "3:2");
    }
  }
});

test("n=4 requires four validated results", () => {
  const img = syntheticPng(1024, 1024);
  const spec = resolveImageSpec({ model: "gemini-image", size: "1:1" });
  assert.equal(spec.ok, true);
  const one = validateImageResults([{ buf: img }], { spec: spec.ok ? spec.spec : undefined, n: 4 });
  assert.equal(one.ok, false);
  if (!one.ok) assert.match(one.error, /RESULT_COUNT_MISMATCH/);
  const four = validateImageResults([{ buf: img }, { buf: img }, { buf: img }, { buf: img }], {
    spec: spec.ok ? spec.spec : undefined,
    n: 4,
  });
  assert.equal(four.ok, true);
});

test("result sha256 matching a reference is rejected", () => {
  const img = syntheticPng(1024, 1024);
  const spec = resolveImageSpec({ model: "gemini-image", size: "1:1" });
  const sha = sha256Hex(img);
  const hit = validateOneImage({ buf: img }, { spec: spec.ok ? spec.spec : undefined, referenceHashes: [sha] });
  assert.equal(hit.ok, false);
  if (!hit.ok) assert.match(hit.error, /RESULT_IS_REFERENCE_IMAGE/);
});

test("1MB png still validates dimensions", () => {
  const img = syntheticPng(1376, 768, 1024 * 1024);
  assert.ok(img.length >= 1024 * 1024);
  const spec = resolveImageSpec({ model: "nano-banana-2", size: "16:9" });
  const ok = validateOneImage({ buf: img }, { spec: spec.ok ? spec.spec : undefined });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.result.width, 1376);
    assert.equal(ok.result.height, 768);
    assert.equal(ok.result.bytes, img.length);
  }
});

test("low confidence is not a 200", () => {
  const img = syntheticPng(1024, 1024);
  const spec = resolveImageSpec({ model: "gemini-image", size: "1:1" });
  const low = validateOneImage({ buf: img, confidence: "MEDIUM" }, { spec: spec.ok ? spec.spec : undefined });
  assert.equal(low.ok, false);
  if (!low.ok) assert.match(low.error, /IMAGE_CONFIDENCE_TOO_LOW/);
});
