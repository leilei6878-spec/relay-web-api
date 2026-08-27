import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentIncomplete, describeReference, resultIsReference, sha256Hex } from "./reference-verify.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("reference descriptors hash bytes not length", () => {
  const a = describeReference(PNG);
  assert.equal(a.byteSize, PNG.length);
  assert.equal(a.sha256, sha256Hex(PNG));
  const other = Buffer.concat([PNG, Buffer.from([1])]);
  assert.notEqual(describeReference(other).sha256, a.sha256);
});

test("exact count 1/2/4/6 and incomplete", () => {
  for (const n of [1, 2, 4, 6]) {
    assert.equal(attachmentIncomplete(n, n), null);
    assert.match(attachmentIncomplete(n, n - 1) || "", /REFERENCE_ATTACH_INCOMPLETE/);
  }
  assert.equal(attachmentIncomplete(0, 0), null);
});

test("result sha256 matching any reference is RESULT_IS_REFERENCE_IMAGE", () => {
  const a = sha256Hex(PNG);
  assert.equal(resultIsReference(a, [a, "bbbb"]), true);
  assert.equal(resultIsReference("cccc", [a]), false);
});
