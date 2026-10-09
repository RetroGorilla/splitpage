import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { checkFileGone, copyKept, holdKeep, releaseKeep, FILE_CHECK_TIMEOUT_MS } = require(path.join(here, "..", "close-keep.js"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-close-keep-"));
const file = path.join(dir, "script.splitpage");
fs.writeFileSync(file, "{}", "utf8");
const stat = (p) => fs.promises.stat(p);

test("a file still in place is not gone", async () => {
  assert.equal(await checkFileGone(stat, file, 2000), false);
});

test("a missing path is gone", async () => {
  assert.equal(await checkFileGone(stat, path.join(dir, "moved.splitpage"), 2000), true);
});

test("a folder at the path is gone", async () => {
  assert.equal(await checkFileGone(stat, dir, 2000), true);
});

test("a stat that throws at once is gone", async () => {
  assert.equal(await checkFileGone(() => { throw new Error("EACCES"); }, file, 2000), true);
});

test("a stat that answers something without isFile is gone", async () => {
  assert.equal(await checkFileGone(async () => null, file, 2000), true);
  assert.equal(await checkFileGone(async () => ({ isFile: () => false }), file, 2000), true);
});

test("a stat that never answers counts as gone once the time runs out, not before", async () => {
  const started = Date.now();
  let early = null;
  const probe = setTimeout(() => { early = "pending"; }, 40);
  const gone = await checkFileGone(() => new Promise(() => {}), file, 150);
  clearTimeout(probe);
  const took = Date.now() - started;
  assert.equal(gone, true);
  assert.equal(early, "pending");
  assert.ok(took >= 140, "answered after " + took + " ms");
  assert.ok(took < 1500, "answered after " + took + " ms");
});

test("a late answer does not change a timed-out check", async () => {
  let answer;
  const pending = new Promise((resolve) => { answer = resolve; });
  const gone = await checkFileGone(() => pending, file, 30);
  answer({ isFile: () => true });
  await pending;
  assert.equal(gone, true);
});

test("a quick answer settles before the time limit", async () => {
  const started = Date.now();
  assert.equal(await checkFileGone(async () => ({ isFile: () => true }), file, 5000), false);
  assert.ok(Date.now() - started < 1000);
});

test("the close check gives a stat a second", () => {
  assert.equal(FILE_CHECK_TIMEOUT_MS, 1000);
});

test("a copy counts as kept only when the flush answered ok and a draft is on disk", () => {
  assert.equal(copyKept({ ok: true }, true), true);
  assert.equal(copyKept({ ok: true }, false), false);
  assert.equal(copyKept({ ok: false, code: "EBUSY" }, true), false);
  assert.equal(copyKept({ ok: false, code: "EIO" }, false), false);
  assert.equal(copyKept({ ok: false, code: "NO_TAB" }, true), false);
  assert.equal(copyKept({ ok: "yes" }, true), false);
  assert.equal(copyKept(null, true), false);
  assert.equal(copyKept(undefined, true), false);
  assert.equal(copyKept({ ok: true }, "yes"), false);
});

test("a held tab keeps its copy until its one holder lets go", () => {
  const tab = { id: "t1" };
  const flow = {};
  holdKeep(tab, flow);
  assert.equal(tab.keepDraftOnClose, true);
  releaseKeep(tab, flow);
  assert.equal(tab.keepDraftOnClose, false);
});

test("a tab held by two flows stays held until both let go, in either order", () => {
  for (const order of [[0, 1], [1, 0]]) {
    const tab = { id: "t2" };
    const flows = [{}, {}];
    holdKeep(tab, flows[0]);
    holdKeep(tab, flows[1]);
    releaseKeep(tab, flows[order[0]]);
    assert.equal(tab.keepDraftOnClose, true);
    releaseKeep(tab, flows[order[1]]);
    assert.equal(tab.keepDraftOnClose, false);
  }
});

test("letting go of a hold that was never taken leaves the other holder's hold", () => {
  const tab = { id: "t3" };
  const holder = {};
  holdKeep(tab, holder);
  releaseKeep(tab, {});
  assert.equal(tab.keepDraftOnClose, true);
  releaseKeep(tab, holder);
  releaseKeep(tab, holder);
  assert.equal(tab.keepDraftOnClose, false);
});

test("a flow holding a tab twice lets go with one release", () => {
  const tab = { id: "t4" };
  const flow = {};
  holdKeep(tab, flow);
  holdKeep(tab, flow);
  releaseKeep(tab, flow);
  assert.equal(tab.keepDraftOnClose, false);
});

test("a hold nobody releases stays, whatever the other flows do", () => {
  const tab = { id: "t5" };
  const forever = {};
  const flow = {};
  holdKeep(tab, flow);
  holdKeep(tab, forever);
  releaseKeep(tab, flow);
  releaseKeep(tab, flow);
  assert.equal(tab.keepDraftOnClose, true);
});

test("a release on a tab nobody held leaves it unheld", () => {
  const tab = { id: "t6" };
  releaseKeep(tab, {});
  assert.notEqual(tab.keepDraftOnClose, true);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
