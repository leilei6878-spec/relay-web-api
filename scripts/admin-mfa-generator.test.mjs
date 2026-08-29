import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function run(args) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./scripts/register-ts-ext.mjs", "scripts/generate-admin-mfa.mjs", ...args], {
    cwd: process.cwd(), encoding: "utf8",
  });
}

test("administrator MFA generator refuses accidental secret output", () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /SECRET=[A-Z2-7]+/);
});

test("administrator MFA generator emits one valid secret and matching otpauth URI only after acknowledgement", () => {
  const result = run(["--acknowledge-secret-output", "--issuer=Relay QA", "--account=security@example.test"]);
  assert.equal(result.status, 0, result.stderr);
  const secret = result.stdout.match(/^SECRET=([A-Z2-7]+)$/m)?.[1];
  assert.ok(secret);
  assert.equal(secret.length, 32);
  assert.match(result.stdout, new RegExp(`^OTPAUTH_URI=otpauth://totp/Relay%20QA:security%40example\\.test\\?secret=${secret}&issuer=Relay%20QA&algorithm=SHA1&digits=6&period=30$`, "m"));
});
