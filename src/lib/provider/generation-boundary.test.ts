import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pickAcceptedCandidates,
  scoreCandidate,
  SYNTHETIC_NEW_SRC,
  syntheticPermutation,
  type ResultCandidate,
} from "./generation-boundary.ts";

test("rejects history, reference, avatar, and logo", () => {
  const bad: ResultCandidate[] = [
    {
      src: "https://lh3.googleusercontent.com/history-0",
      containerId: "hist-0",
      createdAfterSubmit: false,
      isNewContainer: false,
      isNewSrc: false,
      domainMatch: true,
      width: 1024,
      height: 1024,
      bytes: 10_000,
      mime: "image/png",
      sha256: "h",
      referenceDuplicate: false,
      historicalDuplicate: true,
    },
    {
      src: "https://lh3.googleusercontent.com/ref-a",
      containerId: "composer-ref",
      createdAfterSubmit: true,
      isNewContainer: false,
      isNewSrc: true,
      domainMatch: true,
      width: 256,
      height: 256,
      bytes: 4000,
      mime: "image/png",
      sha256: "r",
      referenceDuplicate: true,
      historicalDuplicate: false,
    },
    {
      src: "https://lh3.googleusercontent.com/avatar.png",
      containerId: "nav",
      createdAfterSubmit: false,
      isNewContainer: false,
      isNewSrc: true,
      domainMatch: true,
      width: 32,
      height: 32,
      bytes: 200,
      mime: "image/png",
      sha256: "a",
      referenceDuplicate: false,
      historicalDuplicate: false,
    },
  ];
  for (const c of bad) assert.equal(scoreCandidate(c), "REJECT", c.src);
  assert.equal(pickAcceptedCandidates(bad, 1).picked.length, 0);
});

test("100 synthetic DOM permutations return only the new generation", () => {
  let historical = 0;
  let reference = 0;
  let ui = 0;
  let hits = 0;
  for (let seed = 0; seed < 100; seed++) {
    const cands = syntheticPermutation(seed);
    const { picked } = pickAcceptedCandidates(cands, 1);
    assert.equal(picked.length, 1, `seed ${seed} picked ${picked.length}`);
    const src = picked[0]!.src;
    if (src.includes("history-")) historical += 1;
    if (src.includes("ref-")) reference += 1;
    if (src.includes("avatar") || src.includes("logo")) ui += 1;
    if (src === SYNTHETIC_NEW_SRC) hits += 1;
  }
  assert.equal(historical, 0);
  assert.equal(reference, 0);
  assert.equal(ui, 0);
  assert.equal(hits, 100);
});
