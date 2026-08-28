import assert from "node:assert/strict";
import { test } from "node:test";
import { parseImageRequest, parseMessageContent } from "./media.ts";

const image = (n: number) => `https://example.test/${n}.png`;

test("chat images report overflow instead of silently truncating", () => {
  const parsed = parseMessageContent(
    Array.from({ length: 5 }, (_, i) => ({ type: "image_url", image_url: { url: image(i) } })),
  );
  assert.equal(parsed.images.length, 4);
  assert.equal(parsed.imageOverflow, true);
});

test("image requests report provider-specific overflow", () => {
  const gemini = parseImageRequest({ prompt: "x", images: Array.from({ length: 5 }, (_, i) => image(i)) });
  assert.equal(gemini.images.length, 4);
  assert.equal(gemini.imageOverflow, true);
  const leonardo = parseImageRequest(
    { prompt: "x", images: Array.from({ length: 7 }, (_, i) => image(i)) },
    { maxImages: 6 },
  );
  assert.equal(leonardo.images.length, 6);
  assert.equal(leonardo.imageOverflow, true);
});

test("invalid image references are reported instead of ignored", () => {
  assert.equal(parseMessageContent([{ type: "image_url", image_url: { url: "file:///secret.png" } }]).imageInvalid, true);
  assert.equal(parseImageRequest({ prompt: "x", image: "not-a-url" }).imageInvalid, true);
});

test("the image alias and images array do not duplicate one reference", () => {
  const url = image(1);
  const parsed = parseImageRequest({ prompt: "x", image: url, images: [url] }, { maxImages: 6 });
  assert.deepEqual(parsed.images, [url]);
  assert.equal(parsed.imageOverflow, false);
  assert.equal(parsed.imageInvalid, false);
});
