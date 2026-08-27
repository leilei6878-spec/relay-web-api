import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASPECT_PRESETS,
  aspectFromSize,
  canParseSize,
  collectSizeInput,
  imageFamily,
  pixelsFor,
  resolutionOptionsFor,
  resolveImageSpec,
  sizeOptionsFor,
} from "./image-size.ts";

test("official GPT sizes map to native aspect + tier", () => {
  const sq = resolveImageSpec({ model: "gpt-image-1", size: "1024x1024" });
  assert.equal(sq.ok, true);
  if (sq.ok) {
    assert.equal(sq.spec.aspect, "1:1");
    assert.equal(sq.spec.size, "1024x1024");
    assert.equal(sq.spec.tier, "Small");
    assert.equal(sq.spec.imageSize, "1K");
  }

  const land = resolveImageSpec({ model: "gpt-image-1", size: "1536x1024" });
  assert.equal(land.ok, true);
  if (land.ok) {
    assert.equal(land.spec.aspect, "3:2");
    assert.equal(land.spec.size, "1264x848");
    assert.equal(land.spec.tier, "Small");
  }

  const port = resolveImageSpec({ model: "gpt-image-2", size: "1024x1536" });
  assert.equal(port.ok, true);
  if (port.ok) {
    assert.equal(port.spec.aspect, "2:3");
    assert.equal(port.spec.size, "848x1264");
  }
});

test("1264x848 is 3:2 not 16:9 or 4:3", () => {
  assert.equal(aspectFromSize("1264x848"), "3:2");
  assert.equal(aspectFromSize("848x1264"), "2:3");
  assert.equal(aspectFromSize("1376x768"), "16:9");
  assert.equal(aspectFromSize("768x1376"), "9:16");
  const spec = resolveImageSpec({ model: "leonardo-gpt-image-2", size: "1264x848" });
  assert.equal(spec.ok, true);
  if (spec.ok) {
    assert.equal(spec.spec.aspect, "3:2");
    assert.equal(spec.spec.size, "1264x848");
  }
});

test("Nano Banana 16:9 2K uses official 2752x1536", () => {
  const spec = resolveImageSpec({
    model: "gemini-2.5-flash-image",
    aspectRatio: "16:9",
    imageSize: "2K",
  });
  assert.equal(spec.ok, true);
  if (spec.ok) {
    assert.equal(spec.spec.aspect, "16:9");
    assert.equal(spec.spec.size, "2752x1536");
    assert.equal(spec.spec.tier, "Medium");
    assert.equal(spec.spec.imageSize, "2K");
  }
});

test("Nano Banana 16:9 Small/Medium/Large match Leonardo Image Dimensions", () => {
  const nano = "nano-banana-2";
  const opts = resolutionOptionsFor(nano, "16:9");
  assert.deepEqual(
    opts.map((o) => [o.tier, o.w, o.h]),
    [
      ["Small", 1376, 768],
      ["Medium", 2752, 1536],
      ["Large", 5504, 3072],
    ],
  );
  const large = resolveImageSpec({ model: nano, aspectRatio: "16:9", imageSize: "Large" });
  assert.equal(large.ok, true);
  if (large.ok) {
    assert.equal(large.spec.size, "5504x3072");
    assert.equal(large.spec.tier, "Large");
  }
  assert.deepEqual(pixelsFor("2:3", "1K", "nano"), { w: 848, h: 1264 });
  assert.deepEqual(pixelsFor("21:9", "1K", "nano"), { w: 1584, h: 672 });
});

test("size token 16:9 does not collapse to square", () => {
  const spec = resolveImageSpec({ model: "nano-banana", size: "16:9" });
  assert.equal(spec.ok, true);
  if (spec.ok) {
    assert.equal(spec.spec.aspect, "16:9");
    assert.equal(spec.spec.size, "1376x768");
  }
  assert.equal(canParseSize("16:9"), true);
  assert.equal(canParseSize("2K"), true);
  assert.equal(canParseSize("nope"), false);
});

test("GPT Large 1:1 is 2880 not 4096", () => {
  const spec = resolveImageSpec({ model: "gpt-image-2", size: "2880x2880" });
  assert.equal(spec.ok, true);
  if (spec.ok) {
    assert.equal(spec.spec.size, "2880x2880");
    assert.equal(spec.spec.tier, "Large");
  }
  const four = resolveImageSpec({ model: "nano-banana-2", size: "4096x4096" });
  assert.equal(four.ok, true);
  if (four.ok) {
    assert.equal(four.spec.size, "4096x4096");
    assert.equal(four.spec.imageSize, "4K");
  }
});

test("collectSizeInput reads Google imageConfig and OpenAI aliases", () => {
  const g = collectSizeInput({
    generationConfig: { imageConfig: { aspectRatio: "9:16", imageSize: "1K" } },
  });
  assert.equal(g.aspectRatio, "9:16");
  assert.equal(g.imageSize, "1K");
  const o = collectSizeInput({ size: "1024x1024", aspect_ratio: "1:1", image_size: "2K" }, "gpt-image-1");
  assert.equal(o.size, "1024x1024");
  assert.equal(o.aspectRatio, "1:1");
  assert.equal(o.imageSize, "2K");
});

test("gemini-image is Gemini web, flash-image is Nano Banana", () => {
  assert.equal(imageFamily("gemini-image"), "gemini");
  assert.equal(imageFamily("gemini-2.5-flash-image"), "nano");
  assert.equal(imageFamily("nano-banana-2"), "nano");
  assert.equal(imageFamily("gpt-image-1.5"), "gpt");
  assert.ok(sizeOptionsFor("gpt-image-2").some((s) => s.id === "1376x768"));
  assert.ok(sizeOptionsFor("nano-banana").some((s) => s.label.includes("16:9")));
  assert.ok(ASPECT_PRESETS.some((p) => p.id === "21:9" && p.hint.includes("Ultrawide")));
  assert.ok(ASPECT_PRESETS.some((p) => p.id === "4:5" && p.hint.includes("Instagram")));
});
