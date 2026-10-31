import assert from "node:assert/strict";
import { checkCounts, evalPage, fireEval, setHookFreeRun } from "./smoke.mjs";

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function fakeCdp() {
  const sent = [];
  return {
    sent,
    send: async (method, params) => { sent.push(params.expression); return { result: { value: "ran" } }; }
  };
}

function newFailures(before) {
  return checkCounts().failureLines.slice(before.failureLines.length);
}

test("a hook-free run refuses a direct evaluation that names a hook and records a failed check", async () => {
  setHookFreeRun(true);
  const cdp = fakeCdp();
  const before = checkCounts();
  await assert.rejects(evalPage(cdp, "window.__desktopTest.markDirtyForTest()"), /hook-free group drove a test hook \(__desktopTest\)/);
  const after = checkCounts();
  assert.deepEqual(cdp.sent, []);
  assert.equal(after.totalChecks, before.totalChecks + 1);
  assert.equal(after.passedChecks, before.passedChecks);
  assert.equal(newFailures(before).length, 1);
  assert.match(newFailures(before)[0], /__desktopTest/);
});

test("a helper that swallows the error (fireEval) still leaves the failed check", async () => {
  setHookFreeRun(true);
  const cdp = fakeCdp();
  const before = checkCounts();
  await fireEval(cdp, "window.__splitpageFormats.state()", { awaitPromise: false });
  const after = checkCounts();
  assert.deepEqual(cdp.sent, []);
  assert.equal(after.totalChecks - after.passedChecks, before.totalChecks - before.passedChecks + 1);
  assert.equal(newFailures(before).length, 1);
  assert.match(newFailures(before)[0], /__splitpageFormats/);
});

test("a hook-free run still evaluates an expression that names no hook", async () => {
  setHookFreeRun(true);
  const cdp = fakeCdp();
  const before = checkCounts();
  assert.equal(await evalPage(cdp, "document.title"), "ran");
  assert.deepEqual(cdp.sent, ["document.title"]);
  assert.deepEqual(checkCounts(), before);
});

test("outside a hook-free run a hook is evaluated as before", async () => {
  setHookFreeRun(false);
  const cdp = fakeCdp();
  const before = checkCounts();
  assert.equal(await evalPage(cdp, "window.__desktopTest.tabId"), "ran");
  assert.deepEqual(cdp.sent, ["window.__desktopTest.tabId"]);
  assert.deepEqual(checkCounts(), before);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.message || e)); }
}
setHookFreeRun(false);
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
