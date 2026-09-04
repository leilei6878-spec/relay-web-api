import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chatGptImagePrompt, isChatGptImageModel } from "./chatgpt-image.ts";
import { isWebModelAlias } from "./chatgpt.ts";
import { imageFamily } from "./image-size.ts";

test("ChatGPT LLM image is an explicit web-account image model", () => {
  assert.equal(isChatGptImageModel("chatgpt-llm-image"), true);
  assert.equal(isChatGptImageModel("gpt-image-2"), false);
  assert.equal(isWebModelAlias("chatgpt-llm-image"), true);
  assert.equal(imageFamily("chatgpt-llm-image"), "gpt");
});

test("ChatGPT image prompt preserves the request and binds aspect, size and reference mode", () => {
  const prompt = chatGptImagePrompt({
    prompt: "把参考图改成夜景",
    aspect: "16:9",
    size: "1376x768",
    hasReferences: true,
  });
  assert.match(prompt, /attached image or images as visual references/);
  assert.match(prompt, /exactly one generated image/);
  assert.match(prompt, /16:9/);
  assert.match(prompt, /1376x768/);
  assert.match(prompt, /把参考图改成夜景/);
});

test("image API routes ChatGPT LLM image through ChatGPT accounts and the image-safe worker path", async () => {
  const route = await readFile(new URL("../../routes/v1/images/generations.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../local-worker-script.ts", import.meta.url), "utf8");
  assert.match(route, /isChatGptImageModel\(model\) \? "chatgpt"/);
  assert.match(route, /platform === "chatgpt"\s*\? await enqueueChat/);
  assert.match(worker, /is_chatgpt_image_model/);
  assert.match(worker, /create_generation_boundary\(page, ctx, "chatgpt", prompt\)/);
  assert.match(worker, /CHATGPT_IMAGE_NOT_FOUND/);
  assert.match(worker, /for fallback_input in \("#prompt-textarea"/);
  assert.match(worker, /"\[role='textbox'\]"/);
});
