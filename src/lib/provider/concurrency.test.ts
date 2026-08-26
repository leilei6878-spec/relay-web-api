import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Mirrors worker SEM + per-account lock:
 * worker concurrency = N, same account concurrency = 1.
 */
function simulate(opts: { requests: number; accounts: number; workerN: number }) {
  const accountBusy = new Array(opts.accounts).fill(false);
  let active = 0;
  let maxActive = 0;
  let maxPerAccount = 0;
  const perAccount = new Array(opts.accounts).fill(0);
  let next = 0;
  const inflight: { acc: number }[] = [];
  const done: number[] = [];
  while (done.length < opts.requests) {
    while (active < opts.workerN && next < opts.requests) {
      const acc = next % opts.accounts;
      if (accountBusy[acc]) break;
      accountBusy[acc] = true;
      perAccount[acc] += 1;
      maxPerAccount = Math.max(maxPerAccount, perAccount[acc]);
      inflight.push({ acc });
      active += 1;
      maxActive = Math.max(maxActive, active);
      next += 1;
    }
    const finished = inflight.shift();
    if (!finished) break;
    accountBusy[finished.acc] = false;
    perAccount[finished.acc] -= 1;
    active -= 1;
    done.push(finished.acc);
  }
  return { maxActive, maxPerAccount, completed: done.length };
}

test("20 requests / 5 accounts: worker N=3, account concurrency=1", () => {
  const r = simulate({ requests: 20, accounts: 5, workerN: 3 });
  assert.equal(r.completed, 20);
  assert.ok(r.maxActive <= 3);
  assert.equal(r.maxPerAccount, 1);
});

test("20 requests / 10 accounts: worker N=3, account concurrency=1", () => {
  const r = simulate({ requests: 20, accounts: 10, workerN: 3 });
  assert.equal(r.completed, 20);
  assert.ok(r.maxActive <= 3);
  assert.equal(r.maxPerAccount, 1);
});
