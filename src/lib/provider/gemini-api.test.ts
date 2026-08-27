import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGeminiGenerateContent, parseModelAction, geminiGenerateContentResponse } from "./gemini-api.ts";

test("parse generateContent path and imageConfig", () => {
  const path = parseModelAction("gemini-2.5-flash-image:generateContent");
  assert.equal(path.model, "gemini-2.5-flash-image");
  assert.equal(path.action, "generateContent");
  const parsed = parseGeminiGenerateContent(
    {
      contents: [
        {
          role: "user",
          parts: [
            { text: "a red bicycle" },
            { inlineData: { mimeType: "image/png", data: "AAAA" } },
          ],
        },
      ],
      generationConfig: { imageConfig: { aspectRatio: "16:9", imageSize: "2K" }, candidateCount: 1 },
    },
    "gemini-2.5-flash-image",
  );
  assert.equal(parsed.prompt, "a red bicycle");
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.sizeInput.aspectRatio, "16:9");
  assert.equal(parsed.sizeInput.imageSize, "2K");
});

test("official generateContent response shape", () => {
  const body = geminiGenerateContentResponse({ b64: "abc", mime: "image/png", model: "nano-banana-2" });
  const part = body.candidates[0].content.parts[0] as { inlineData: { data: string } };
  assert.equal(part.inlineData.data, "abc");
  assert.equal(body.candidates[0].finishReason, "STOP");
});
