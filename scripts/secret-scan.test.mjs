import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const FORBIDDEN = [
  /ss:\/\/[A-Za-z0-9+/=_-]{20,}@\d+\.\d+\.\d+\.\d+/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-live-[A-Za-z0-9]{10,}/,
  /BEGIN (RSA |OPENSSH )?PRIVATE KEY/,
];

test("HEAD source does not contain live proxy share-links or PATs", () => {
  const r = spawnSync(
    "git",
    [
      "grep",
      "-n",
      "-E",
      "ss://[A-Za-z0-9+/=_-]{16,}@|ghp_[A-Za-z0-9]{20}|github_pat_[A-Za-z0-9_]{20}|BEGIN (RSA |OPENSSH )?PRIVATE KEY",
      "--",
      ".",
      ":(exclude)scripts/secret-scan.test.mjs",
    ],
    { encoding: "utf8" },
  );
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  for (const re of FORBIDDEN) {
    assert.equal(re.test(out), false, `forbidden pattern ${re} in git grep:\n${out}`);
  }
});

test(".env.example has no real secret values", () => {
  const text = readFileSync(".env.example", "utf8");
  assert.doesNotMatch(text, /ss:\/\//);
  assert.doesNotMatch(text, /ghp_/);
  assert.match(text, /DATABASE_URL=/);
  assert.match(text, /REDIS_URL=/);
});
