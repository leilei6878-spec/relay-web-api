import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_VERSION, releaseIdentity } from "./release.ts";

test("release identity exposes version, exact commit, schema, and normalized build time", () => {
  const release = releaseIdentity({
    RELAY_RELEASE_SHA: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
    RELAY_BUILD_TIME: "2026-08-28T00:00:00+08:00",
  } as NodeJS.ProcessEnv);
  assert.equal(APP_VERSION, "0.9.0-rc2");
  assert.equal(release.commit, "abcdef1234567890abcdef1234567890abcdef12");
  assert.equal(release.buildTime, "2026-08-27T16:00:00.000Z");
  assert.equal(release.schema, 6);
  assert.equal(release.api, "v1");
});

test("release identity uses platform commit variables and rejects arbitrary values", () => {
  assert.equal(releaseIdentity({ VERCEL_GIT_COMMIT_SHA: "1234567" } as NodeJS.ProcessEnv).commit, "1234567");
  assert.equal(releaseIdentity({ GITHUB_SHA: "f".repeat(40) } as NodeJS.ProcessEnv).commit, "f".repeat(40));
  assert.equal(releaseIdentity({ RELAY_RELEASE_SHA: "main; cat /etc/passwd" } as NodeJS.ProcessEnv).commit, "unknown");
  assert.equal(releaseIdentity({ RELAY_BUILD_TIME: "not-a-date" } as NodeJS.ProcessEnv).buildTime, "unknown");
});
