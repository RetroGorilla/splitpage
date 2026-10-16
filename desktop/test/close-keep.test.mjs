import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { checkFileGone, copyKept, holdKeep, releaseKeep, runCloseCheck, lastWindowClose, FILE_CHECK_TIMEOUT_MS } = require(path.join(here, "..", "close-keep.js"));

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

function closeCheck(spec) {
  const tabs = new Map();
  for (const t of spec.tabs) tabs.set(t.id, t);
  const order = spec.order || spec.tabs.map((t) => t.id);
  const answers = (spec.answers || []).slice();
  const questions = [];
  const reports = [];
  const holders = [];
  const io = {
    tabs,
    goneFileTabsOf: (ids) => Promise.resolve(ids.map((id) => tabs.get(id)).filter((t) => t && t.gone)),
    unsavedTabsOf: (ids, gone) => {
      if (spec.unsavedThrowsAfter !== undefined && spec.unsavedThrowsAfter-- <= 0) throw new Error("test: unsavedTabsOf failed");
      return ids.map((id) => tabs.get(id)).filter((t) => t && (t.dirty || gone.includes(t)));
    },
    askAboutUnsaved: (list) => {
      if (!list.length) return "discard";
      questions.push(list.map((t) => t.id));
      const answer = answers.length ? answers.shift() : "cancel";
      return typeof answer === "function" ? answer({ tabs, order, list }) : answer;
    },
    keepDraftsOfGoneFiles: (gone, holder) => {
      holders.push(holder);
      for (const t of gone) holdKeep(t, holder);
      const during = spec.duringKeep ? spec.duringKeep({ tabs, order, round: holders.length }) : null;
      return Promise.resolve(during).then(() => gone.filter((t) => t.keepFails));
    },
    report: (verb, err) => reports.push(verb + ": " + err.message)
  };
  const wanted = spec.stillWanted || (() => true);
  return runCloseCheck(io, () => order.filter((id) => tabs.has(id)), spec.verb || "Close window", () => undefined, wanted)
    .then((result) => ({ ...result, questions, reports, tabs, holders }));
}

const tab = (id, extra) => ({ id, ...extra });

test("close check: nothing unsaved and no file gone closes with no question", async () => {
  const r = await closeCheck({ tabs: [tab("a"), tab("b")] });
  assert.deepEqual([r.answer, r.questions, r.tabIds], ["discard", [], ["a", "b"]]);
});

test("close check: an unsaved tab is asked about, and Stay keeps everything open", async () => {
  const r = await closeCheck({ tabs: [tab("a", { dirty: true }), tab("b")], answers: ["cancel"] });
  assert.deepEqual([r.answer, r.questions], ["cancel", [["a"]]]);
});

test("close check: a tab whose file is gone is asked about, and its kept copy stays held after 'close'", async () => {
  const r = await closeCheck({ tabs: [tab("a", { gone: true }), tab("b")], answers: ["discard"] });
  assert.deepEqual([r.answer, r.questions, r.tabIds], ["discard", [["a"]], ["a", "b"]]);
  assert.equal(r.tabs.get("a").keepDraftOnClose, true);
});

test("close check: a copy that was not kept is asked about again, and Stay lets go of the hold", async () => {
  const r = await closeCheck({ tabs: [tab("a", { gone: true, keepFails: true }), tab("b", { dirty: true })], answers: ["discard", "cancel"] });
  assert.deepEqual([r.answer, r.questions], ["cancel", [["a", "b"], ["a"]]]);
  assert.equal(r.tabs.get("a").keepDraftOnClose, false);
});

test("close check: a tab opened during the copy's wait is asked about in a second round (#509)", async () => {
  const r = await closeCheck({
    tabs: [tab("a", { gone: true })], answers: ["discard", "discard"],
    duringKeep: ({ tabs, order, round }) => { if (round === 1) { tabs.set("c", tab("c", { dirty: true })); order.push("c"); } }
  });
  assert.deepEqual([r.answer, r.questions, r.tabIds], ["discard", [["a"], ["c"]], ["a", "c"]]);
});

test("close check: a failed question is reported, answers Stay and lets go of every hold (#508)", async () => {
  const r = await closeCheck({
    tabs: [tab("a", { gone: true, keepFails: true })],
    answers: ["discard", () => { throw new Error("test: the question failed"); }]
  });
  assert.deepEqual([r.answer, r.reports], ["cancel", ["Close window: test: the question failed"]]);
  assert.equal(r.tabs.get("a").keepDraftOnClose, false);
});

test("close check: a close that is no longer wanted after the copy's wait answers Stay and lets go", async () => {
  let wanted = true;
  const r = await closeCheck({
    tabs: [tab("a", { gone: true })], answers: ["discard"], stillWanted: () => wanted,
    duringKeep: () => { wanted = false; }
  });
  assert.deepEqual([r.answer, r.questions], ["cancel", [["a"]]]);
  assert.equal(r.tabs.get("a").keepDraftOnClose, false);
});

test("close check: a tab moved out during the copy's wait is let go and not closed (#509)", async () => {
  const r = await closeCheck({
    tabs: [tab("a", { gone: true }), tab("b", { gone: true })], answers: ["discard"],
    duringKeep: ({ order }) => { order.splice(order.indexOf("a"), 1); }
  });
  assert.deepEqual([r.answer, r.tabIds], ["discard", ["b"]]);
  assert.equal(r.tabs.get("a").keepDraftOnClose, false);
  assert.equal(r.tabs.get("b").keepDraftOnClose, true);
});

const editDuringFirstKeep = (id) => ({ tabs, round }) => { if (round === 1) tabs.get(id).dirty = true; };

test("close check: a tab that was clean at its question and is edited during the copy's wait is asked again, and Stay keeps it (#532)", async () => {
  const r = await closeCheck({ tabs: [tab("a", { gone: true }), tab("b")], answers: ["discard", "cancel"], duringKeep: editDuringFirstKeep("b") });
  assert.deepEqual([r.answer, r.questions], ["cancel", [["a"], ["b"]]]);
  assert.equal(r.tabs.get("a").keepDraftOnClose, false);
});

test("close check: 'close' to the second question about the edited tab closes both (#532)", async () => {
  const r = await closeCheck({ tabs: [tab("a", { gone: true }), tab("b")], answers: ["discard", "discard"], duringKeep: editDuringFirstKeep("b") });
  assert.deepEqual([r.answer, r.questions, r.tabIds], ["discard", [["a"], ["b"]], ["a", "b"]]);
  assert.equal(r.tabs.get("a").keepDraftOnClose, true);
});

test("close check: a tab already answered 'close' while unsaved is not asked again (#532)", async () => {
  const r = await closeCheck({ tabs: [tab("a", { gone: true }), tab("b", { dirty: true })], answers: ["discard", "cancel"], duringKeep: editDuringFirstKeep("b") });
  assert.deepEqual([r.answer, r.questions], ["discard", [["a", "b"]]]);
});

test("close check: a gone file's tab edited during its own copy's wait stays held, not asked again (#532)", async () => {
  const r = await closeCheck({ tabs: [tab("a", { gone: true })], answers: ["discard", "cancel"], duringKeep: editDuringFirstKeep("a") });
  assert.deepEqual([r.answer, r.questions], ["discard", [["a"]]]);
  assert.equal(r.tabs.get("a").keepDraftOnClose, true);
});

test("close check: a tab whose copy was asked about again is not asked a third time (#532)", async () => {
  const r = await closeCheck({ tabs: [tab("a", { gone: true, keepFails: true })], answers: ["discard", "discard", "cancel"], duringKeep: editDuringFirstKeep("a") });
  assert.deepEqual([r.answer, r.questions], ["discard", [["a"], ["a"]]]);
});

test("close check: a tab edited during a later round's wait is asked again too (#532)", async () => {
  const r = await closeCheck({
    tabs: [tab("a", { gone: true }), tab("b")], answers: ["discard", "discard", "cancel"],
    duringKeep: ({ tabs, order, round }) => {
      if (round === 1) { tabs.set("c", tab("c", { gone: true })); order.push("c"); }
      if (round === 2) tabs.get("b").dirty = true;
    }
  });
  assert.deepEqual([r.answer, r.questions], ["cancel", [["a"], ["c"], ["b"]]]);
  assert.equal(r.tabs.get("a").keepDraftOnClose, false);
  assert.equal(r.tabs.get("c").keepDraftOnClose, false);
});

test("close check: a tab edited while the second question is open is asked about as well (#532)", async () => {
  const r = await closeCheck({
    tabs: [tab("a", { gone: true }), tab("b"), tab("d")], duringKeep: editDuringFirstKeep("b"),
    answers: ["discard", ({ tabs }) => { tabs.get("d").dirty = true; return "discard"; }, "discard"]
  });
  assert.deepEqual([r.answer, r.questions, r.tabIds], ["discard", [["a"], ["b"], ["d"]], ["a", "b", "d"]]);
});

test("close check: a tab opened during the second question is asked about in its own round (#509, #532)", async () => {
  const r = await closeCheck({
    tabs: [tab("a", { gone: true }), tab("b")], duringKeep: editDuringFirstKeep("b"),
    answers: ["discard", ({ tabs, order }) => { tabs.set("e", tab("e", { dirty: true })); order.push("e"); return "discard"; }, "cancel"]
  });
  assert.deepEqual([r.answer, r.questions], ["cancel", [["a"], ["b"], ["e"]]]);
});

test("close check: a tab moved out and edited during the wait is not asked about (#532)", async () => {
  const r = await closeCheck({
    tabs: [tab("a", { gone: true }), tab("b")], answers: ["discard", "cancel"],
    duringKeep: ({ tabs, order }) => { tabs.get("b").dirty = true; order.splice(order.indexOf("b"), 1); }
  });
  assert.deepEqual([r.answer, r.questions, r.tabIds], ["discard", [["a"]], ["a"]]);
});

test("close check: a tab closed during the wait is not asked about (#532)", async () => {
  const r = await closeCheck({
    tabs: [tab("a", { gone: true }), tab("b")], answers: ["discard", "cancel"],
    duringKeep: ({ tabs }) => { tabs.get("b").dirty = true; tabs.delete("b"); }
  });
  assert.deepEqual([r.answer, r.questions, r.tabIds], ["discard", [["a"]], ["a"]]);
});

test("close check: a failure in the last re-check is reported and answers Stay (#508, #532)", async () => {
  const r = await closeCheck({ tabs: [tab("a", { gone: true }), tab("b")], answers: ["discard"], unsavedThrowsAfter: 1 });
  assert.deepEqual([r.answer, r.questions, r.reports], ["cancel", [["a"]], ["Close window: test: unsavedTabsOf failed"]]);
  assert.equal(r.tabs.get("a").keepDraftOnClose, false);
});

test("close check: with no file gone, nothing is waited on and a clean tab is not asked about", async () => {
  const r = await closeCheck({ tabs: [tab("a"), tab("b", { dirty: true })], answers: ["discard", "cancel"] });
  assert.deepEqual([r.answer, r.questions], ["discard", [["b"]]]);
});

test("closing window: only a window still the last one at 'close' freezes the session, and hosting is confirmed only when it was asked as the last (#531)", () => {
  const cases = [
    [true, false, true, { freezeSession: true, confirmHosting: true }],
    [true, true, true, { freezeSession: false, confirmHosting: false }],
    [false, false, true, { freezeSession: true, confirmHosting: false }],
    [false, true, true, { freezeSession: false, confirmHosting: false }],
    [true, false, false, { freezeSession: true, confirmHosting: false }],
    [true, true, false, { freezeSession: false, confirmHosting: false }],
    [false, false, false, { freezeSession: true, confirmHosting: false }],
    [false, true, false, { freezeSession: false, confirmHosting: false }]
  ];
  for (const [askedAsLast, othersOpen, hosting, expected] of cases) {
    assert.deepEqual(lastWindowClose(askedAsLast, othersOpen, hosting), expected, JSON.stringify([askedAsLast, othersOpen, hosting]));
  }
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
