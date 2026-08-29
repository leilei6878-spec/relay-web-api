import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("commercial gateway routes only to official providers and wraps every call in billing", async () => {
  const source = await readFile("src/lib/commercial-gateway.ts", "utf8");
  assert.match(source, /resolveOfficialModel/);
  assert.match(source, /reserveUsage/);
  assert.match(source, /settleUsage/);
  assert.match(source, /releaseUsageReservation/);
  assert.match(source, /checkpointUsageProviderResult/);
  assert.match(source, /decodeUsageProviderResult/);
  assert.match(source, /IDEMPOTENT_REQUEST_IN_PROGRESS/);
  assert.match(source, /officialChat/);
  assert.match(source, /officialImage/);
  assert.doesNotMatch(source, /enqueueChat|enqueueImage|pickAccount|web_account/);
});

test("public commercial API branches before web-account selection", async () => {
  const chat = await readFile("src/routes/v1/chat/completions.ts", "utf8");
  const images = await readFile("src/routes/v1/images/generations.ts", "utf8");
  const responses = await readFile("src/routes/v1/responses.ts", "utf8");
  const jobs = await readFile("src/routes/api/jobs.ts", "utf8");
  assert.ok(chat.indexOf("if (auth.commercial)") < chat.indexOf("const prepared ="));
  assert.ok(images.indexOf("if (auth.commercial)") < images.indexOf("const platform = isLeonardoModel"));
  assert.match(chat, /commercialChatCompletion/);
  assert.match(images, /commercialImageGeneration/);
  assert.match(chat, /Commercial streaming is temporarily disabled/);
  assert.match(images, /Commercial image editing is disabled/);
  assert.match(chat, /headers\.get\("idempotency-key"\)/);
  assert.match(images, /headers\.get\("idempotency-key"\)/);
  assert.match(responses, /if \(auth\.commercial\)/);
  assert.match(responses, /commercialChatCompletion/);
  assert.match(jobs, /where tenant_id=\$1/);
  assert.match(jobs, /workers: \[\]/);
});
