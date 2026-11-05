import "../../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUndo } from "../../../../src/application/editing/undo/undo.ts";
import type { UndoPorts } from "../../../../src/application/editing/undo/undo.ts";
import type { ValidatedDocument } from "../../../../src/core/document/validated.ts";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { cellRuns } from "../../../../src/test/_cell-runs.mjs";
import { beatPos, caretAt } from "../../../../src/core/flow/flow.ts";
import { initializeFlowParagraphs } from "../../../../src/application/commands/flow.ts";

function setup() {
  const doc: ValidatedDocument = migrateRows({ title: "Owner", rows: [{ id: "r1", visualText: "", audioText: "a" }] });
  let held: ValidatedDocument | null = doc;
  const ports: UndoPorts = {
    held: () => held,
    runs: cellRuns,
    now: () => 1000,
    cleared: () => {}
  };
  const owner = createUndo(ports);
  owner.track();
  return {
    owner,
    doc: () => doc,
    drop: () => { held = null; }
  };
}

function typeInto(doc: ValidatedDocument, text: string): void {
  Object.assign((doc.rows as unknown as { audioText: string }[])[0] as object, { audioText: text });
}

function initializeParagraphs(u: ReturnType<typeof setup>): void {
  const initialization = initializeFlowParagraphs({ cells: cellRuns, newId: () => "unused", hasVisual: () => false },
    () => true, starts => { u.owner.settleAfterApply(starts); });
  const plan = initialization.plan(u.doc());
  assert.ok(plan && !("refused" in plan));
  plan.apply(u.doc());
  plan.settle();
}

test("first-open initialization preserves split undo and redo without weakening changed-content refusal", () => {
  for (const changed of [false, true]) {
    const u = setup();
    typeInto(u.doc(), "Alpha.Bravo");
    u.owner.reset();
    typeInto(u.doc(), "Alpha.");
    u.doc().rows.push({ ...u.doc().rows[0], id: "r2", audioText: "Bravo" } as ValidatedDocument["rows"][number]);
    u.owner.noteEdit();
    u.owner.flush();
    initializeParagraphs(u);
    assert.deepEqual(u.owner.sizes(), { undo: 1, redo: 0 });
    if (changed) {
      Object.assign(u.doc().rows[1] as object, { audioText: "Remote bravo" });
      const refused = u.owner.undo();
      assert.equal(refused.ok, false);
      assert.ok("reason" in refused && refused.reason === "that beat has changed since");
      assert.equal(u.doc().rows[1]?.audioText, "Remote bravo");
    } else {
      assert.equal(u.owner.undo().ok, true);
      assert.equal(u.doc().rows.length, 1);
      assert.equal(u.doc().rows[0]?.audioText, "Alpha.Bravo");
      assert.equal(u.doc().paragraphsDecided, true);
      assert.deepEqual(u.owner.sizes(), { undo: 0, redo: 1 });
      assert.equal(u.owner.redo().ok, true);
      assert.equal(u.doc().rows[1]?.audioText, "Bravo");
      assert.equal(u.doc().rows[1]?.paragraphStart, true);
      assert.equal(u.doc().paragraphsDecided, true);
    }
  }
});

test("initialization keeps redo deletion snapshots and the older split in replay order", () => {
  const u = setup();
  typeInto(u.doc(), "Alpha.Bravo");
  u.owner.reset();
  typeInto(u.doc(), "Alpha.");
  u.doc().rows.push({ ...u.doc().rows[0], id: "r2", audioText: "Bravo" } as ValidatedDocument["rows"][number]);
  u.owner.noteEdit();
  u.owner.flush();
  u.doc().rows.pop();
  u.owner.noteEdit();
  u.owner.flush();
  assert.equal(u.owner.undo().ok, true);
  initializeParagraphs(u);
  assert.deepEqual(u.owner.sizes(), { undo: 1, redo: 1 });
  assert.equal(u.owner.redo().ok, true);
  assert.equal(u.doc().rows.length, 1);
  assert.equal(u.owner.undo().ok, true);
  assert.equal(u.doc().rows[1]?.paragraphStart, true);
  assert.equal(u.owner.undo().ok, true);
  assert.equal(u.doc().rows[0]?.audioText, "Alpha.Bravo");
  assert.equal(u.doc().paragraphsDecided, true);
});

test("initialization preserves earlier paragraph edits at their own history boundaries", () => {
  const u = setup();
  typeInto(u.doc(), "Alpha.");
  u.doc().rows.push({ ...u.doc().rows[0], id: "r2", audioText: "Bravo" } as ValidatedDocument["rows"][number]);
  u.owner.reset();
  const row = u.doc().rows[1];
  assert.ok(row);
  row.paragraphStart = true;
  u.owner.noteEdit();
  u.owner.flush();
  delete row.paragraphStart;
  u.owner.noteEdit();
  u.owner.flush();
  initializeParagraphs(u);
  assert.deepEqual(u.owner.sizes(), { undo: 2, redo: 0 });
  assert.equal(u.owner.undo().ok, true);
  assert.equal(row.paragraphStart, true);
  assert.equal(u.owner.undo().ok, true);
  assert.equal(row.paragraphStart, undefined);
  assert.equal(u.owner.redo().ok, true);
  assert.equal(u.owner.redo().ok, true);
  assert.equal(row.paragraphStart, true);
  assert.equal(u.doc().paragraphsDecided, true);
});

test("flow selections belong to their undo entry, survive replay and do not coalesce with native typing", () => {
  const u = setup();
  const selection = { before: { anchor: beatPos("r1", 1), head: beatPos("r1", 0) }, after: caretAt(beatPos("r1", 2)) };
  typeInto(u.doc(), "ab");
  u.owner.noteEdit(selection);
  u.owner.flush();
  assert.deepEqual(u.owner.last()?.selection, selection);
  typeInto(u.doc(), "abc");
  u.owner.noteEdit();
  u.owner.flush();
  assert.deepEqual(u.owner.sizes(), { undo: 2, redo: 0 });
  assert.equal(u.owner.last()?.selection, undefined);
  u.owner.undo();
  u.owner.undo();
  assert.deepEqual(u.owner.nextRedo()?.selection, selection);
  u.owner.redo();
  assert.deepEqual(u.owner.last()?.selection, selection);
  u.owner.reset();
  assert.equal(u.owner.last(), null);
});

test("initialization stops rebasing at the nearest paragraph transition across off-on-off history", () => {
  const u = setup();
  typeInto(u.doc(), "Alpha.");
  u.doc().rows.push({ ...u.doc().rows[0], id: "r2", audioText: "Bravo", paragraphStart: true } as ValidatedDocument["rows"][number]);
  u.owner.reset();
  const row = u.doc().rows[1];
  assert.ok(row);
  for (const start of [false, true, false]) {
    if (start) row.paragraphStart = true; else delete row.paragraphStart;
    u.owner.noteEdit();
    u.owner.flush();
  }
  initializeParagraphs(u);
  assert.deepEqual(u.owner.sizes(), { undo: 3, redo: 0 });
  for (const [index, expected] of [true, undefined, true].entries()) {
    assert.equal(u.owner.undo().ok, true, "paragraph undo " + (index + 1));
    assert.equal(row.paragraphStart, expected);
    assert.equal(u.doc().paragraphsDecided, true);
    assert.deepEqual(u.owner.sizes(), { undo: 2 - index, redo: index + 1 });
  }
  for (const expected of [undefined, true, true]) {
    assert.equal(u.owner.redo().ok, true);
    assert.equal(row.paragraphStart, expected);
  }
  assert.deepEqual(u.owner.sizes(), { undo: 3, redo: 0 });
});

test("undo owner: a reported edit is recorded on flush, and undo replays it through the unrouted runner", () => {
  const u = setup();
  typeInto(u.doc(), "ab");
  u.owner.noteEdit();
  u.owner.flush();
  assert.deepEqual(u.owner.sizes(), { undo: 1, redo: 0 });
  const result = u.owner.undo();
  assert.equal(result.ok, true);
  assert.equal((u.doc().rows[0] as { audioText: string }).audioText, "a");
  assert.deepEqual(u.owner.sizes(), { undo: 0, redo: 1 });
});

test("undo owner: an edit that was not reported moves the base without recording a step", () => {
  const u = setup();
  typeInto(u.doc(), "ab");
  u.owner.flush();
  assert.deepEqual(u.owner.sizes(), { undo: 0, redo: 0 });
});

test("undo owner: without a held document undo is empty and nothing is replayed", () => {
  const u = setup();
  u.drop();
  assert.deepEqual(u.owner.undo(), { ok: false, empty: true });
});

test("undo owner: routed replays run through the route and the route's uninstall restores the unrouted runner", () => {
  const u = setup();
  const ran: string[] = [];
  const unroute = u.owner.routeReplays(() => { ran.push("routed"); return { kind: "noop" }; }, null);
  typeInto(u.doc(), "ab");
  u.owner.noteEdit();
  u.owner.flush();
  assert.deepEqual(u.owner.undo(), { ok: false, empty: true });
  assert.deepEqual(ran, ["routed"]);
  unroute();
  assert.equal(u.owner.undo().ok, true);
  assert.deepEqual(ran, ["routed"]);
});

test("undo owner: configure installs hooks and its release puts the previous ones back", () => {
  const u = setup();
  const heard: string[] = [];
  const release = u.owner.configure({ afterApply: (_steps, dir) => { heard.push(dir); } });
  typeInto(u.doc(), "ab");
  u.owner.noteEdit();
  u.owner.flush();
  u.owner.undo();
  release();
  u.owner.redo();
  assert.deepEqual(heard, ["undo"]);
});
