import test from "node:test";
import assert from "node:assert/strict";
import { galleryActions } from "../../../src/features/gallery/actions.ts";
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
