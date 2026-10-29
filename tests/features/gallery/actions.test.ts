import test from "node:test";
import assert from "node:assert/strict";
import { editorOpenActions, galleryActions } from "../../../src/features/gallery/actions.ts";
import type { GalleryControls } from "../../../src/features/gallery/ports.ts";

test("annotate-picture validates its input and calls the current gallery", () => {
  const calls: unknown[][] = [];
  let current: GalleryControls | null = null;
  const [action] = galleryActions(() => current);
  assert.ok(action);
  assert.equal(action.id, "annotate-picture");
  const availability = action.availability;
  assert.ok(availability);
  assert.deepEqual(availability("button"), { enabled: false, visible: false });
  current = { openAnnotator: (...args) => { calls.push(args); return true; }, refreshAnnotator: () => {} };
  assert.deepEqual(availability("button"), { enabled: true, visible: false });
  assert.throws(() => action.run("button", undefined), /annotate-picture needs what to open/);
  assert.throws(() => action.run("button", null), /annotate-picture needs what to open/);
  assert.throws(() => action.run("button", { rowId: 1, slot: 0 }), /annotate-picture needs rowId as text/);
  assert.throws(() => action.run("button", { rowId: "r1", slot: "0" }), /annotate-picture needs slot as a number/);
  assert.deepEqual(calls, []);
  action.run("button", { rowId: "r1", slot: 2 });
  assert.deepEqual(calls, [["r1", 2]]);
});

test("open-picture-link validates input and passes the row, slot and optional key unchanged", () => {
  const calls: unknown[][] = [];
  const [action] = editorOpenActions((...args) => { calls.push(args); });
  assert.ok(action);
  assert.equal(action.id, "open-picture-link");
  assert.equal(action.label, "Open picture link");
  assert.equal(action.group, "Open");
  assert.deepEqual(action.availability?.("command-menu"), { enabled: true, visible: false });
  assert.throws(() => action.run("button", undefined), /open-picture-link needs what to open/);
  assert.throws(() => action.run("button", null), /open-picture-link needs what to open/);
  assert.throws(() => action.run("button", "row"), /open-picture-link needs what to open/);
  assert.throws(() => action.run("button", { rowId: 1, slot: 0 }), /open-picture-link needs rowId as text/);
  assert.throws(() => action.run("button", { rowId: "r1", slot: "0" }), /open-picture-link needs slot as a number/);
  assert.deepEqual(calls, []);
  const key = { token: "key" };
  action.run("button", { rowId: "r1", slot: 2, key });
  action.run("button", { rowId: "r2", slot: 0 });
  assert.deepEqual(calls, [["r1", 2, key], ["r2", 0, undefined]]);
});