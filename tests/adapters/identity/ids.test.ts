import { test } from "node:test";
import assert from "node:assert/strict";
import { makeId, mintDocId, nowIso, randomHexBytes, randomIds, systemClock } from "../../../src/adapters/identity/ids.ts";

const MINTED = /^([a-z]*)([0-9a-z]{0,7})([0-9a-z]{8})$/;

type WindowStub = { crypto?: unknown; msCrypto?: unknown };

function withWindow<T>(stub: WindowStub, run: () => T): T {
  const had = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: stub, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (had) Object.defineProperty(globalThis, "window", had);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function withRandom<T>(values: number[], run: () => T): T {
  const real = Math.random;
  let i = 0;
  Math.random = () => values[i++ % values.length] ?? 0;
  try {
    return run();
  } finally {
    Math.random = real;
  }
}

test("an id is its prefix, up to seven random base-36 digits and the time in base 36", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 30, 12) });
  const id = withRandom([0.5], () => makeId("bs"));
  assert.equal(id, "bs" + (0.5).toString(36).slice(2, 9) + Date.UTC(2026, 8, 30, 12).toString(36));
  assert.match(id, MINTED);
  assert.equal(withRandom([0.123456789], () => makeId()).slice(0, 1), "r");
  assert.equal(withRandom([0.123456789], () => makeId("")), withRandom([0.123456789], () => makeId("r")));
  assert.notEqual(makeId("c"), makeId("c"));
});

test("random bytes come from the window's crypto when it has one", () => {
  const hex = withWindow({ crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(0x0a) } }, () => randomHexBytes(3));
  assert.equal(hex, "0a0a0a");
  const legacy = withWindow({ msCrypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff) } }, () => randomHexBytes(2));
  assert.equal(legacy, "ffff");
});

test("without crypto, random bytes fall back to Math.random", () => {
  const hex = withRandom([0, 0.5, 0.999], () => withWindow({}, () => randomHexBytes(3)));
  assert.equal(hex, "0080ff");
  assert.equal(withWindow({ crypto: {} }, () => withRandom([0.25], () => randomHexBytes(1))), "40");
});

test("a minted document id is d and sixteen random bytes in hex", () => {
  const id = withWindow({ crypto: globalThis.crypto }, () => mintDocId());
  assert.match(id, /^d[0-9a-f]{32}$/);
  assert.notEqual(id, withWindow({ crypto: globalThis.crypto }, () => mintDocId()));
});

test("the clock reads the time as an ISO string", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 30, 12, 34, 56, 789) });
  assert.equal(nowIso(), "2026-09-30T12:34:56.789Z");
  assert.equal(systemClock.nowIso(), "2026-09-30T12:34:56.789Z");
});

test("the identity ports mint through these functions", () => {
  assert.match(withRandom([0.5], () => randomIds.id("p")), /^p[0-9a-z]{0,7}[0-9a-z]{8}$/);
  assert.match(withWindow({ crypto: globalThis.crypto }, () => randomIds.docId()), /^d[0-9a-f]{32}$/);
});
