import assert from "node:assert/strict";
import { test } from "node:test";
import { uid } from "./utils.ts";

test("uid prefers native randomUUID when the context exposes it", () => {
  assert.equal(uid({ randomUUID: () => "native-id" }), "native-id");
});

test("uid works in an insecure HTTP context without randomUUID", () => {
  const id = uid({
    getRandomValues(array) {
      for (let index = 0; index < array.length; index += 1) array[index] = index;
      return array;
    },
  });
  assert.equal(id, "00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
