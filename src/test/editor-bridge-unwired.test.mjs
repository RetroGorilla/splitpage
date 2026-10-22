import test from "node:test";
import assert from "node:assert/strict";

const bridge = await import("../legacy/editor-bridge.ts");

const live = { current: () => null, assign() {} };

test("before the editor's owners are started, every accessor throws instead of running on a default", () => {
  assert.equal(bridge.editorStarted(), false);
  assert.throws(() => bridge.rowDrag(), /The editor's owners are not started yet/);
  assert.throws(() => bridge.undoGuard(), /not started yet/);
  assert.throws(() => bridge.focusMemory(), /not started yet/);
  assert.throws(() => bridge.mergeUndo(), /not started yet/);
  assert.throws(() => bridge.editorSelection(), /not started yet/);
  assert.throws(() => bridge.installPicturePicker(() => {}), /not started yet/);
  assert.throws(() => bridge.pickPictureFor("r1"), /not started yet/);
  assert.throws(() => bridge.installCellEditing({}), /not started yet/);
  assert.throws(() => bridge.cellEditing(), /not started yet/);
});

test("started once with fresh owners; a second start throws until the first is stopped, and a restart forgets the old state", () => {
  const stop = bridge.startEditor(live);
  let drag;
  try {
    assert.equal(bridge.editorStarted(), true);
    assert.throws(() => bridge.startEditor(live), /already started/);
    drag = bridge.rowDrag();
    drag.start("r1");
    bridge.mergeUndo().arm({ id: "s-1", docId: "d1", source: "stash" });
    bridge.focusMemory().focusedRow("r2");
    bridge.editorSelection().holdLink("range", "cell");
  } finally {
    stop();
  }
  assert.equal(bridge.editorStarted(), false);
  assert.throws(() => bridge.rowDrag(), /not started yet/);
  const again = bridge.startEditor(live);
  try {
    assert.notEqual(bridge.rowDrag(), drag);
    assert.equal(bridge.rowDrag().dragging(), null);
    assert.equal(bridge.mergeUndo().last(), null);
    assert.equal(bridge.focusMemory().lastRow(), null);
    assert.equal(bridge.editorSelection().heldLink(), null);
  } finally {
    again();
  }
});

test("an old stop run after a newer start leaves the newer owners in place", () => {
  const first = bridge.startEditor(live);
  first();
  const second = bridge.startEditor(live);
  try {
    first();
    assert.equal(bridge.editorStarted(), true);
  } finally {
    second();
  }
});

test("the gallery's Add goes to the installed picture picker; with none installed it does nothing, and an old uninstall keeps a newer picker", () => {
  const stop = bridge.startEditor(live);
  try {
    const picked = [];
    bridge.pickPictureFor("r0");
    const off = bridge.installPicturePicker((rowId) => { picked.push("a " + rowId); });
    bridge.pickPictureFor("r1");
    const offB = bridge.installPicturePicker((rowId) => { picked.push("b " + rowId); });
    off();
    bridge.pickPictureFor("r2");
    offB();
    bridge.pickPictureFor("r3");
    assert.deepEqual(picked, ["a r1", "b r2"]);
  } finally {
    stop();
  }
});

test("cell editing is reached only while installed: one at a time, an uninstall forgets it, and a stopped editor drops it", () => {
  const stop = bridge.startEditor(live);
  const editing = { sync() {} };
  try {
    assert.throws(() => bridge.cellEditing(), /Cell editing is not installed yet/);
    const off = bridge.installCellEditing(editing);
    assert.equal(bridge.cellEditing(), editing);
    assert.throws(() => bridge.installCellEditing({}), /already installed/);
    off();
    assert.throws(() => bridge.cellEditing(), /not installed yet/);
    bridge.installCellEditing(editing);
  } finally {
    stop();
  }
  const again = bridge.startEditor(live);
  try {
    assert.throws(() => bridge.cellEditing(), /not installed yet/, "a restarted editor starts without the old cell editing");
  } finally {
    again();
  }
});
