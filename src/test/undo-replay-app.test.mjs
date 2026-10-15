import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { getEditorName } = await import("../js/03-sync.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { undo, redo, undoSizes, lastUndoEntry, flushEdits } = await import("../js/12a-undo.js");
const { liveSession, provideSessionEffects } = await import("../legacy/session-bridge.ts");
const writer = await import("../js/19-writer.js");

after(closeApp);

const realNow = Date.now;
let clock = 9_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

function fixture() {
  return {
    schema: 2,
    title: "Replay",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo", updatedAt: "2020-01-01T00:00:00.000Z", updatedBy: "Old" },
      { id: "r2", visualText: "Close", audioText: "Second line", status: "ready" }
    ],
    comments: [],
    people: [{ id: "pM", name: "Ada" }],
    productionTags: [{ id: "t_kettle", cat: "prop", name: "Kettle", owner: "pM", notes: "", status: "needed" }],
    brollShots: [{ id: "bs_pier", name: "Pier", owner: "pM", notes: "" }]
  };
}

let opened = 0;
async function open() {
  if (writer.writerOpen) writer.closeWriter();
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "replay-" + (++opened) + ".splitpage", { lastModified: opened });
  await openProjectFile(file, null, { skipSnapshot: true });
  flushEdits();
}

const settle = () => new Promise((r) => setImmediate(r));
const row = (id) => S.state.rows.find((r) => r.id === id);
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');
const docText = () => JSON.stringify(S.state);

function lastText(el) {
  const walker = document.createTreeWalker(el, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

function edit(id, text) {
  clock += 5_000;
  const el = cellOf(id, "audioText");
  el.focus();
  const node = lastText(el);
  node.data = text;
  const r = document.createRange();
  r.setStart(node, node.data.length);
  r.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  const entry = lastUndoEntry();
  el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
  flushEdits();
  assert.equal(row(id).audioText, text);
  assert.notEqual(lastUndoEntry(), entry, "the edit made an undo entry");
  el.blur();
}

function watch() {
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push({ kind: c.kind, generation: c.generation, changes: c.changes, stamp: row("r1") && row("r1").updatedAt }));
  return { seen, stop };
}

function key(target, init) {
  const e = new window.KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, init));
  target.dispatchEvent(e);
  return e;
}

function beforeInput(target, inputType) {
  const e = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType });
  target.dispatchEvent(e);
  return e;
}

async function replayedOnce(gesture, dir) {
  await open();
  edit("r1", "Hello again");
  const sizes = undoSizes();
  if (dir === "redo") {
    undo();
    await settle();
  }
  const before = undoSizes();
  const generation = liveSession().generation();
  const w = watch();
  try {
    gesture();
    await settle();
  } finally {
    w.stop();
  }
  assert.equal(liveSession().generation(), generation + 1, "one generation per gesture");
  assert.deepEqual(w.seen.map((c) => c.kind), ["replay"], "one publication per gesture, as a replay");
  const moved = dir === "undo" ? { undo: before.undo - 1, redo: before.redo + 1 } : { undo: before.undo + 1, redo: before.redo - 1 };
  assert.deepEqual(undoSizes(), moved, "the move only: no new undo or redo entry");
  assert.equal(row("r1").audioText, dir === "undo" ? "Hello there" : "Hello again");
  if (dir === "redo") assert.deepEqual(undoSizes(), sizes);
}

beforeEach(() => { clock += 10_000; });

test("6.2 keyboard: Ctrl+Z outside the script reaches the replay transaction once", async () => {
  await replayedOnce(() => { document.body.focus(); key(document.body, { key: "z", ctrlKey: true }); }, "undo");
});

test("6.2 keyboard: Ctrl+Shift+Z and Ctrl+Y redo through the replay transaction once each", async () => {
  await replayedOnce(() => { document.body.focus(); key(document.body, { key: "Z", ctrlKey: true, shiftKey: true }); }, "redo");
  await replayedOnce(() => { document.body.focus(); key(document.body, { key: "y", ctrlKey: true }); }, "redo");
});

test("6.2 keyboard: Ctrl+Z in a script cell is one gesture and one replay, not one per listener", async () => {
  await replayedOnce(() => { const el = cellOf("r2", "audioText"); el.focus(); key(el, { key: "z", ctrlKey: true }); }, "undo");
});

test("6.2 keyboard: a native control keeps its own undo, and the document is untouched", async () => {
  await open();
  edit("r1", "Hello again");
  const input = document.createElement("input");
  document.body.appendChild(input);
  try {
    input.focus();
    const generation = liveSession().generation();
    const e = key(input, { key: "z", ctrlKey: true });
    await settle();
    assert.equal(e.defaultPrevented, false);
    assert.equal(liveSession().generation(), generation);
    assert.equal(row("r1").audioText, "Hello again");
  } finally {
    input.remove();
  }
});

test("6.2 beforeinput: historyUndo and historyRedo on a script cell each make one replay", async () => {
  await replayedOnce(() => { const el = cellOf("r1", "audioText"); el.focus(); beforeInput(el, "historyUndo"); }, "undo");
  await replayedOnce(() => { const el = cellOf("r1", "audioText"); el.focus(); beforeInput(el, "historyRedo"); }, "redo");
});

test("6.2 action route: undo() and redo() are the replay transaction", async () => {
  await replayedOnce(() => { undo(); }, "undo");
  await replayedOnce(() => { redo(); }, "redo");
});

test("6.2: the row stamp is written inside the transaction, before the replay is published, and is in its change set", async () => {
  await open();
  edit("r1", "Hello again");
  clock += 60_000;
  const before = row("r1").updatedAt;
  const w = watch();
  try {
    undo();
  } finally {
    w.stop();
  }
  assert.equal(w.seen.length, 1);
  assert.notEqual(w.seen[0].stamp, before, "stamped when the change was published");
  assert.equal(w.seen[0].stamp, row("r1").updatedAt);
  assert.equal(row("r1").updatedBy, getEditorName());
  assert.deepEqual(w.seen[0].changes.cells.map((c) => c.rowId + "." + c.field), ["r1.audioText", "r1.updatedAt", "r1.updatedBy"]);
  assert.equal(S.dirty, true, "the effect pass marked the document dirty");
});

test("6.2: an empty replay changes nothing observable", async () => {
  await open();
  const text = docText();
  const generation = liveSession().generation();
  const w = watch();
  try {
    assert.deepEqual(redo(), { ok: false, empty: true });
  } finally {
    w.stop();
  }
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(w.seen, []);
  assert.equal(docText(), text);
});

test("6.2: a refused replay changes nothing in the document, keeps the refusal's history behaviour and warns", async () => {
  await open();
  edit("r1", "Hello again");
  const next = JSON.parse(JSON.stringify(S.state));
  next.rows = next.rows.filter((r) => r.id !== "r1");
  S.state = liveSession().absorbServer(next);
  const text = docText();
  const generation = liveSession().generation();
  const sizes = undoSizes();
  const w = watch();
  let r;
  try {
    r = undo();
  } finally {
    w.stop();
  }
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, "string");
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(w.seen, []);
  assert.equal(docText(), text);
  assert.deepEqual(undoSizes(), { undo: sizes.undo - 1, redo: sizes.redo }, "a refused entry is dropped, as before");
  assert.match(document.querySelector(".toast:last-of-type").textContent, /^Could not undo — /);
});

test("6.2: a throw before the commit leaves the document and the history as they were", async () => {
  await open();
  edit("r1", "Hello again");
  const text = docText();
  const sizes = undoSizes();
  const top = lastUndoEntry();
  const generation = liveSession().generation();
  provideSessionEffects({ editorName: () => { throw new Error("no editor name"); } });
  try {
    assert.throws(() => undo(), /no editor name/);
  } finally {
    provideSessionEffects({ editorName: getEditorName });
  }
  assert.equal(docText(), text, "the replayed text and the stamp are rolled back");
  assert.deepEqual(undoSizes(), sizes);
  assert.equal(lastUndoEntry(), top);
  assert.equal(liveSession().generation(), generation);
  assert.equal(undo().ok, true, "the same entry still undoes afterwards");
  assert.equal(row("r1").audioText, "Hello there");
});

test("6.2: a throw after the commit is reported and the document stays committed", async () => {
  await open();
  edit("r1", "Hello again");
  const sizes = undoSizes();
  const generation = liveSession().generation();
  const stop = liveSession().subscribe(() => { throw new Error("listener broke"); });
  const realError = console.error;
  const logged = [];
  console.error = (e) => { logged.push(e); };
  let r;
  try {
    r = undo();
  } finally {
    console.error = realError;
    stop();
  }
  assert.equal(r.ok, true);
  assert.equal(row("r1").audioText, "Hello there");
  assert.equal(liveSession().generation(), generation + 1);
  assert.deepEqual(undoSizes(), { undo: sizes.undo - 1, redo: sizes.redo + 1 });
  assert.equal(logged.some((e) => e instanceof Error && e.message === "listener broke"), true);
});

test("6.2: owner cleanup by a replay is in its change set, including lists the entry did not carry (#476, #494)", async () => {
  await open();
  clock += 5_000;
  flushEdits();
  const entry = lastUndoEntry();
  S.state.people = S.state.people.concat([{ id: "pC", name: "Cy" }]);
  liveSession().noteEdit();
  flushEdits();
  assert.notEqual(lastUndoEntry(), entry, "adding the person made an undo entry");
  assert.deepEqual(lastUndoEntry().steps.map((s) => s.key), ["people"], "the entry carries the crew only");
  const next = JSON.parse(JSON.stringify(S.state));
  next.brollShots.find((b) => b.id === "bs_pier").owner = "pC";
  S.state = liveSession().absorbServer(next);
  const w = watch();
  let r;
  try {
    r = undo();
  } finally {
    w.stop();
  }
  assert.equal(r.ok, true);
  assert.equal(r.cleared, 1);
  assert.equal(S.state.brollShots.find((b) => b.id === "bs_pier").owner, "", "the collaborator's assignment to the removed person is cleared");
  assert.deepEqual(w.seen.map((c) => c.kind), ["replay"]);
  assert.deepEqual(w.seen[0].changes.docFields.slice().sort(), ["brollShots", "people"]);
});
