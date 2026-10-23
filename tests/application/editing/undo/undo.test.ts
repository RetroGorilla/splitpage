import "../../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUndo } from "../../../../src/application/editing/undo/undo.ts";
import type { UndoPorts } from "../../../../src/application/editing/undo/undo.ts";
import type { ValidatedDocument } from "../../../../src/core/document/validated.ts";
import { migrateRows } from "../../../../src/js/02-state.js";
import { cellRuns } from "../../../../src/test/_cell-runs.mjs";

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
