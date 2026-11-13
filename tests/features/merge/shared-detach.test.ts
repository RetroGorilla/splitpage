import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import { startLocalMerge } from "../../../src/features/merge/local-merge.ts";
import type { MergeReviewPorts } from "../../../src/features/merge/ports.ts";
import { ARM_MS, mountMergeBanner } from "../../../src/features/merge/banner.ts";
import type { MergeReport } from "../../../src/features/merge/banner.ts";
import { fakeNotices } from "../fakes.ts";
import { heldTimers, viewHarness } from "../view-harness.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { textMergeContext } from "../../../src/core/merge/text-field.ts";
import type { TagSide } from "../../../src/core/merge/text-field.ts";

const SHARED = createSessionCapabilities("shared", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
const REASON = "Local merge is not available in a shared session.";
const REFUSED = { allowed: false, reason: REASON } as const;

function recorder(calls: unknown[][]) {
  return (name: string) => (...args: unknown[]): never => { calls.push([name, ...args]); throw new Error("unexpected merge port"); };
}

function page(t: TestContext) {
  const h = viewHarness();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: h.document });
  const disposers: (() => void)[] = [];
  t.after(() => {
    for (const dispose of disposers) dispose();
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
    h.window.close();
  });
  return { h, disposers };
}

test("a merge offer whose session becomes shared while the file is parsed reads no ancestor, offers nothing and says nothing", async t => {
  const { h, disposers } = page(t);
  const doc = migrateRows({ title: "Shared", rows: [] }, fakeMigration().ports);
  const calls: unknown[][] = [];
  const unused = recorder(calls);
  const notices = fakeNotices();
  let allowed = true;
  let finish: (value: Awaited<ReturnType<MergeReviewPorts["files"]["parse"]>>) => void = () => {};
  const parsed: ReturnType<MergeReviewPorts["files"]["parse"]> = new Promise(resolve => { finish = resolve; });
  const ports: MergeReviewPorts = {
    capability: { merge: () => allowed ? { allowed: true } : REFUSED },
    notices: notices.notices, document: { current: () => { calls.push(["current"]); return doc; } }, session: { mergeBase: unused("base") },
    place: { fileHome: unused("home") }, homes: { amendHome: unused("amend home") }, conflicts: { close: unused("close") },
    pictures: { imgHtml: unused("image") }, text: { htmlToPlainText: unused("text") }, entry: { migrate: unused("migrate") },
    files: { parse: (file, options) => { calls.push(["parse", file, options]); return parsed; } },
    recovery: { applyStashedWork: unused("apply") }, textMergeContext: unused("context")
  };
  const owner = startLocalMerge(ports);
  disposers.push(owner.dispose);
  h.el("file-conflict-merge").hidden = false;
  const pending = owner.offer({ name: "local.splitpage", lastModified: 3 }, undefined);
  allowed = false;
  finish({ state: doc });
  await pending;
  assert.deepEqual(calls, [["current"], ["parse", { name: "local.splitpage", lastModified: 3 }, { noAsk: true }]]);
  assert.deepEqual(notices.shown, []);
  assert.equal(h.el("file-conflict-merge").hidden, true);
  owner.open();
  assert.deepEqual(notices.shown.map(({ message, kind }) => [message, kind]), [[REASON, "warn"]]);
  assert.equal(h.el("merge-review-modal").hidden, true);
});

for (const action of ["offer", "open", "confirm", "cancel"] as const) {
  test("shared merge " + action + " refuses before current state, ancestor, parsing, migration, recovery or opening a modal", async t => {
    const { h, disposers } = page(t);
    const calls: unknown[][] = [];
    const unused = recorder(calls);
    const notices = fakeNotices();
    const ports: MergeReviewPorts = {
      capability: SHARED, notices: notices.notices, document: { current: unused("current") }, session: { mergeBase: unused("base") },
      place: { fileHome: unused("home") }, homes: { amendHome: unused("amend home") }, conflicts: { close: unused("close") },
      pictures: { imgHtml: unused("image") }, text: { htmlToPlainText: unused("text") }, entry: { migrate: unused("migrate") },
      files: { parse: unused("parse") }, recovery: { applyStashedWork: unused("apply") }, textMergeContext: unused("context")
    };
    const owner = startLocalMerge(ports);
    disposers.push(owner.dispose);
    h.el("file-conflict-merge").hidden = false;
    if (action === "offer") await owner.offer({ name: "local.splitpage", lastModified: 3 }, undefined);
    else owner[action]();
    assert.deepEqual(calls, []);
    assert.deepEqual(notices.shown.map(({ message, kind }) => [message, kind]), action === "open" || action === "confirm" ? [[REASON, "warn"]] : []);
    assert.equal(h.el("file-conflict-merge").hidden, action === "offer");
    assert.equal(h.el("merge-review-modal").hidden, true);
    assert.equal(h.el("file-conflict-modal").hidden, true);
    assert.equal(h.el("merge-review-list").innerHTML, "");
  });
}

for (const [mode, action] of [["shared", "confirm"], ["shared", "cancel"], ["standalone", "confirm"], ["standalone", "cancel"]] as const) {
  test("a review opened before the session became " + mode + ": " + action + (mode === "shared" ? " closes it without merging or returning to the conflict" : " behaves as before"), async t => {
    const { h, disposers } = page(t);
    const doc = migrateRows({ docId: "d11111111111111111111111111111111", title: "Mine", rows: [] }, fakeMigration().ports);
    const calls: unknown[][] = [];
    const notices = fakeNotices();
    let allowed = true;
    const ports: MergeReviewPorts = {
      capability: { merge: () => allowed ? { allowed: true } : REFUSED },
      notices: notices.notices, document: { current: () => doc }, session: { mergeBase: () => null },
      place: { fileHome: () => null }, homes: { amendHome: (record) => { calls.push(["amend home"]); return record; } },
      conflicts: { close: () => { calls.push(["close"]); } },
      pictures: { imgHtml: () => "" }, text: { htmlToPlainText: html => String(html ?? "") },
      entry: { migrate: raw => { calls.push(["migrate"]); return migrateRows(raw, fakeMigration().ports); } },
      files: { parse: async () => ({ state: migrateRows({ docId: "d11111111111111111111111111111111", title: "Mine", rows: [] }, fakeMigration().ports) }) },
      recovery: { applyStashedWork: (disk) => { calls.push(["apply"]); return { state: disk, report: null, snapshot: null }; } },
      textMergeContext: (base, mine, theirs) => textMergeContext(html => (html ? [{ text: html, marks: {} }] : []), base as TagSide | null, mine as TagSide, theirs as TagSide)
    };
    const owner = startLocalMerge(ports);
    disposers.push(owner.dispose);
    await owner.offer({ name: "local.splitpage", lastModified: 3 }, undefined);
    owner.open();
    assert.equal(h.el("merge-review-modal").hidden, false);
    assert.equal(h.el("file-conflict-modal").hidden, true);
    allowed = mode === "standalone";
    owner[action]();
    assert.equal(h.el("merge-review-modal").hidden, true);
    assert.equal(h.el("merge-review-list").innerHTML, "");
    if (mode === "shared") {
      assert.deepEqual(calls, []);
      assert.equal(h.el("file-conflict-modal").hidden, true);
      assert.deepEqual(notices.shown.map(({ message, kind }) => [message, kind]), action === "confirm" ? [[REASON, "warn"]] : []);
    } else {
      assert.deepEqual(calls, action === "confirm" ? [["close"], ["migrate"], ["apply"]] : []);
      assert.equal(h.el("file-conflict-modal").hidden, action === "confirm");
      assert.deepEqual(notices.shown, []);
    }
  });
}

test("the shared merge banner shows no report silently, and its undo says why without reading undo state, arming or restoring", t => {
  const h = viewHarness();
  const timers = heldTimers(h.window, ARM_MS);
  const calls: unknown[][] = [];
  const unused = recorder(calls);
  const said: string[] = [];
  const owner = mountMergeBanner({ window: h.window, ports: {
    capability: SHARED, lastUndo: unused("undo state"), sameDocument: unused("identity"), restore: unused("restore"), warn: message => { said.push(message); },
    openComments: unused("comments"), rowElement: unused("row"), logError: unused("error"), install: () => () => {}
  } });
  t.after(() => { owner.dispose(); timers.dispose(); h.window.close(); });
  const report = new Proxy({ stats: { rowsFromMe: 1 }, conflicts: [] }, {
    get: (_target, key): never => { calls.push(["report", key]); throw new Error("unexpected report planning"); }
  });
  assert.equal(owner.show(report), false);
  assert.deepEqual(said, []);
  owner.undoMerge();
  assert.deepEqual(calls, []);
  assert.deepEqual(said, [REASON]);
  assert.equal(h.el("merge-banner").hidden, true);
  assert.equal(h.el("merge-undo").classList.contains("armed"), false);
  assert.equal(timers.pending.size, 0);
});

test("an undo armed before the session became shared is disarmed and restores nothing", t => {
  const h = viewHarness();
  const timers = heldTimers(h.window, ARM_MS);
  const calls: unknown[][] = [];
  const said: string[] = [];
  let allowed = true;
  const owner = mountMergeBanner({ window: h.window, ports: {
    capability: { merge: () => allowed ? { allowed: true } : REFUSED, history: () => ({ allowed: true }) },
    lastUndo: () => ({ id: "s1", docId: "d1", source: "stash" }), sameDocument: () => true,
    restore: (...args) => { calls.push(["restore", ...args]); return Promise.resolve("restored"); }, warn: message => { said.push(message); },
    openComments: () => {}, rowElement: () => null, logError: () => {}, install: () => () => {}
  } });
  t.after(() => { owner.dispose(); timers.dispose(); h.window.close(); });
  owner.undoMerge();
  assert.equal(h.el("merge-undo").classList.contains("armed"), true);
  allowed = false;
  owner.undoMerge();
  assert.deepEqual(calls, []);
  assert.deepEqual(said, [REASON]);
  assert.equal(h.el("merge-undo").classList.contains("armed"), false);
  assert.equal(timers.pending.size, 0);
});

test("an undo merge whose restore the session refuses for history says that reason and nothing else", async t => {
  const h = viewHarness();
  const timers = heldTimers(h.window, ARM_MS);
  const said: string[] = [];
  const restores: unknown[][] = [];
  const owner = mountMergeBanner({ window: h.window, ports: {
    capability: { merge: () => ({ allowed: true }), history: () => SHARED.history() },
    lastUndo: () => ({ id: "s1", docId: "d1", source: "stash" }), sameDocument: () => true,
    restore: (...args) => { restores.push(args); return Promise.resolve("refused"); }, warn: message => { said.push(message); },
    openComments: () => {}, rowElement: () => null, logError: () => {}, install: () => () => {}
  } });
  t.after(() => { owner.dispose(); timers.dispose(); h.window.close(); });
  const shown: MergeReport = { stats: { rowsFromMe: 1 }, conflicts: [] };
  assert.equal(owner.show(shown, { undo: true }), true);
  owner.undoMerge();
  owner.undoMerge();
  await Promise.resolve();
  assert.equal(restores.length, 1);
  assert.deepEqual(said, ["Earlier versions cannot replace a shared session."]);
});
