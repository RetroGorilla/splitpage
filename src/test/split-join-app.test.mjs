import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { saveChanges, unsavedChanges } from "../legacy/save-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { undo, redo, undoSizes, lastUndoEntry, flushEdits } = await import("../js/12a-undo.js");
const { currentDocument, liveSession } = await import("../legacy/session-bridge.ts");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");
const { openProductionPanel } = await import("../js/08-production-panels.js");
const { openBrollPanel } = await import("../js/08d-broll-panel.js");

after(closeApp);

const realNow = Date.now;
let clock = 1_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const comment = (id, rowId, field) => ({ id, rowId, field, anchorId: id, quotedText: "", kind: "anchor", text: "note", replies: [] });
const CARD = '<a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>';
const LINKS = [{ href: "https://youtu.be/abc" }];

function fixture() {
  return {
    schema: 2,
    title: "Split and join characterisation",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Alpha " + cmt("c1", "bravo charlie") + " delta", status: "ready" },
      { id: "r3", visualText: "", audioText: "Three.", status: "todo" },
      { id: "r4", visualText: "", audioText: "Four " + cmt("c2", "words") + ".", status: "shot" }
    ],
    comments: [comment("c1", "r2", "audioText"), comment("c2", "r4", "audioText")]
  };
}

let opened = 0;
async function open(doc) {
  if (viewFlags().writerOpen()) writer.closeWriter();
  window.__hostedTest.setSession({ role: "edit", docId: null });
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(doc || fixture())))], "split-" + (++opened) + ".splitpage", { lastModified: opened });
  await openProjectFile(file, null, { skipSnapshot: true });
  flushEdits();
}

const row = (id) => currentDocument().rows.find((r) => r.id === id);
const ids = () => currentDocument().rows.map((r) => r.id);
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');
const para = (id) => document.querySelector('#writer-doc .wr-para[data-id="' + id + '"]');
const anchors = () => currentDocument().comments.map((c) => [c.id, c.rowId, c.field]);
const toasts = () => Array.from(document.querySelectorAll("#toast-host .toast")).map((t) => t.textContent);
const settle = () => new Promise((r) => setImmediate(r));

function lastText(el) {
  const walker = document.createTreeWalker(el, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

function textNodeAt(el, offset) {
  const walker = document.createTreeWalker(el, 4);
  let at = 0;
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (offset <= at + n.data.length) return [n, offset - at];
    at += n.data.length;
  }
  return null;
}

function selectText(el, from, to) {
  const start = textNodeAt(el, from), end = textNodeAt(el, to);
  const r = document.createRange();
  if (start && end) {
    r.setStart(start[0], start[1]);
    r.setEnd(end[0], end[1]);
  } else {
    r.selectNodeContents(el);
    r.collapse(true);
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function typeChar(el, ch) {
  el.focus();
  const node = lastText(el);
  node.data += ch;
  const r = document.createRange();
  r.setStart(node, node.data.length);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
}

function key(el, name, mods) {
  const ev = new window.KeyboardEvent("keydown", Object.assign({ key: name, bubbles: true, cancelable: true }, mods || {}));
  el.dispatchEvent(ev);
  return ev;
}

function stepNames(entry) {
  return entry.steps.map((s) => s.op + ":" + (s.op === "rowField" ? s.rowId + "." + s.key : s.op === "docField" ? s.key : s.row ? s.row.id : s.rowId || ""));
}

function observe(run) {
  flushEdits();
  const session = liveSession();
  const seq0 = saveChanges(), generation0 = session.generation(), undo0 = undoSizes().undo, top0 = lastUndoEntry();
  const published = [], refreshed = [];
  const stop = session.subscribe((c) => published.push({ kind: c.kind, whole: c.changes.whole, rows: c.changes.rowsInserted.length + c.changes.rowsRemoved.length, saveNow: c.changes.saveNow, derive: c.changes.derive.slice() }));
  const refresh = session.refresh;
  session.refresh = (job) => { refreshed.push(job); refresh(job); };
  window.__renderTest.reset();
  try {
    run();
  } finally {
    session.refresh = refresh;
    stop();
  }
  const render = window.__renderTest.counts().render;
  flushEdits();
  const top = lastUndoEntry();
  return {
    seq: saveChanges() - seq0,
    generation: session.generation() - generation0,
    published,
    refreshed,
    render,
    undo: undoSizes().undo - undo0,
    steps: top && top !== top0 ? stepNames(top) : []
  };
}

const DECLARED = { kind: "edit", whole: false, rows: 1, saveNow: false, derive: ["production", "broll"] };
const GRID_REFRESH = ["broll", "untagged"];

function storeMedia(el, html) {
  el.focus();
  el.innerHTML = html;
  el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "" }));
}

beforeEach(() => { clock += 10_000; });

test("a grid split (Alt+Enter) publishes one declared edit: one generation, one dirty, one render, production and b-roll derived", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.focus();
  selectText(el, 5, 5);
  const stamp = row("r1").updatedAt;
  const got = observe(() => key(el, "Enter", { altKey: true }));
  const created = currentDocument().rows[1].id;
  assert.deepEqual(got, { seq: 1, generation: 1, published: [DECLARED], refreshed: GRID_REFRESH, render: 1, undo: 1, steps: ["rowField:r1.audioText", "insertRow:" + created] });
  assert.equal(row("r1").audioText, "Hello");
  assert.equal(row(created).audioText, " there");
  assert.notEqual(row("r1").updatedAt, stamp);
  assert.equal(unsavedChanges(), true);
});

test("a split makes a todo scene after it with the cut-off half in the same field and an empty other field, keys in this order", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 3, 3);
  key(el, "Enter", { altKey: true });
  const made = currentDocument().rows[2];
  assert.deepEqual(Object.keys(made), ["id", "visualText", "imageRef", "audioText", "status", "updatedAt", "updatedBy"]);
  assert.equal(made.visualText, "");
  assert.equal(made.imageRef, null);
  assert.equal(made.status, "todo", "the new scene is todo whatever the split scene's status was");
  assert.equal(row("r2").status, "ready");
  assert.equal(made.updatedBy, row("r2").updatedBy);
  assert.equal(made.updatedBy, "Anonymous");
  assert.equal(made.audioText, "ha " + cmt("c1", "bravo charlie") + " delta");
  assert.equal(row("r2").audioText, "Alp");
});

test("a split in the visual field puts the second half in the new scene's visual field", async () => {
  await open();
  const el = cellOf("r1", "visualText");
  el.focus();
  selectText(el, 2, 2);
  const got = observe(() => key(el, "Enter", { altKey: true }));
  const created = currentDocument().rows[1].id;
  assert.deepEqual(got.steps, ["rowField:r1.visualText", "insertRow:" + created]);
  assert.equal(row("r1").visualText, "Wi");
  assert.equal(row(created).visualText, "de");
  assert.equal(row(created).audioText, "");
  assert.equal(row("r1").audioText, "Hello there", "the other field is left whole");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a split at the very start leaves an empty first half; at the very end an empty second half", async () => {
  await open();
  const start = cellOf("r1", "audioText");
  start.focus();
  selectText(start, 0, 0);
  key(start, "Enter", { altKey: true });
  assert.equal(row("r1").audioText, "");
  assert.equal(currentDocument().rows[1].audioText, "Hello there");
  await open();
  const end = cellOf("r1", "audioText");
  end.focus();
  selectText(end, 11, 11);
  key(end, "Enter", { altKey: true });
  assert.equal(row("r1").audioText, "Hello there");
  assert.equal(currentDocument().rows[1].audioText, "");
});

test("a split with a selection deletes it first; a selection over a whole commented phrase leaves its comment where it was", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const got = observe(() => key(el, "Enter", { altKey: true }));
  const created = currentDocument().rows[2].id;
  assert.deepEqual(got, { seq: 1, generation: 1, published: [DECLARED], refreshed: GRID_REFRESH, render: 1, undo: 1, steps: ["rowField:r2.audioText", "insertRow:" + created] });
  assert.equal(row("r2").audioText, "Alpha ");
  assert.equal(row(created).audioText, " delta");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
  assert.equal(undo().ok, true);
  assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bravo charlie") + " delta");
});

test("a split before a commented phrase moves its comment: one entry holding the cell, the scene and the comment, and redo moves it again", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 6);
  const got = observe(() => key(el, "Enter", { altKey: true }));
  const created = currentDocument().rows[2].id;
  assert.deepEqual(got.steps, ["rowField:r2.audioText", "insertRow:" + created, "docField:comments"]);
  assert.equal(got.undo, 1);
  assert.deepEqual(anchors(), [["c1", created, "audioText"], ["c2", "r4", "audioText"]]);
  assert.equal(undo().ok, true);
  assert.deepEqual(ids(), ["r1", "r2", "r3", "r4"]);
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
  assert.equal(redo().ok, true);
  assert.deepEqual(ids(), ["r1", "r2", created, "r3", "r4"]);
  assert.deepEqual(anchors(), [["c1", created, "audioText"], ["c2", "r4", "audioText"]]);
});

test("a comment anchored in the scene's other field stays with the split scene", async () => {
  const doc = fixture();
  doc.rows[1].visualText = "Close " + cmt("c3", "shot") + " up";
  doc.comments.push(comment("c3", "r2", "visualText"));
  await open(doc);
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 3, 3);
  key(el, "Enter", { altKey: true });
  assert.deepEqual(anchors(), [["c1", currentDocument().rows[2].id, "audioText"], ["c2", "r4", "audioText"], ["c3", "r2", "visualText"]]);
});

test("a split of a cell holding a video card cuts the live DOM and stores both sanitised halves", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  storeMedia(el, "Before " + CARD + " after");
  assert.match(row("r1").audioText, /^Before <a class="video-embed-card"/);
  flushEdits();
  const at = textNodeAt(el, 3);
  const r = document.createRange();
  r.setStart(at[0], at[1]);
  r.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  const got = observe(() => key(el, "Enter", { altKey: true }));
  const created = currentDocument().rows[1].id;
  assert.deepEqual(got, { seq: 1, generation: 1, published: [DECLARED], refreshed: GRID_REFRESH, render: 1, undo: 1, steps: ["rowField:r1.audioText", "insertRow:" + created] });
  assert.equal(row("r1").audioText, "Bef");
  assert.match(row(created).audioText, /^ore <a class="video-embed-card"[^>]*>.*<\/a> after$/);
});

test("a split of a visual cell holding a video card cuts the live DOM and stores both sanitised halves in the visual field", async () => {
  await open();
  const el = cellOf("r1", "visualText");
  storeMedia(el, "Before " + CARD + " after");
  assert.match(row("r1").visualText, /^Before <a class="video-embed-card"/);
  flushEdits();
  const at = textNodeAt(el, 3);
  const r = document.createRange();
  r.setStart(at[0], at[1]);
  r.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  const got = observe(() => key(el, "Enter", { altKey: true }));
  const created = currentDocument().rows[1].id;
  assert.deepEqual(got, { seq: 1, generation: 1, published: [DECLARED], refreshed: GRID_REFRESH, render: 1, undo: 1, steps: ["rowField:r1.visualText", "insertRow:" + created] });
  assert.equal(row("r1").visualText, "Bef");
  assert.match(row(created).visualText, /^ore <a class="video-embed-card"[^>]*>.*<\/a> after$/);
  assert.equal(row(created).audioText, "");
  assert.equal(row("r1").audioText, "Hello there");
});

test("an Alt+Enter with no caret in the cell does nothing at all", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  const other = cellOf("r3", "audioText");
  other.focus();
  selectText(other, 1, 1);
  const before = JSON.stringify(currentDocument());
  const got = observe(() => key(el, "Enter", { altKey: true }));
  assert.deepEqual(got, { seq: 0, generation: 0, published: [], refreshed: [], render: 0, undo: 0, steps: [] });
  assert.equal(JSON.stringify(currentDocument()), before);
});

test("typing and then splitting inside the 1,000 ms window are two entries; the split's undo leaves the typing", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  clock += 5;
  typeChar(el, "!");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  selectText(el, 3, 3);
  clock += 5;
  const got = observe(() => key(el, "Enter", { altKey: true }));
  assert.equal(got.undo, 1);
  assert.equal(undoSizes().undo, 2);
  assert.equal(row("r1").audioText, "Hel");
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there!");
  assert.deepEqual(ids(), ["r1", "r2", "r3", "r4"]);
});

test("a keystroke not yet stored is stored by the split and counts as its own edit", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.focus();
  el.appendChild(document.createTextNode("?"));
  selectText(el, 3, 3);
  const got = observe(() => key(el, "Enter", { altKey: true }));
  assert.equal(got.seq, 2);
  assert.equal(got.generation, 2);
  assert.equal(got.undo, 2, "the split ends the typing group, so the stored keystroke is its own entry");
  assert.equal(row("r1").audioText, "Hel");
  assert.equal(currentDocument().rows[1].audioText, "lo there?");
});

test("a Writer split is the same single edit with no grid render", async () => {
  await open();
  writer.openWriter();
  const p = para("r1");
  p.focus();
  selectText(p, 5, 5);
  const got = observe(() => key(p, "Enter"));
  const created = currentDocument().rows[1].id;
  assert.deepEqual(got, { seq: 1, generation: 1, published: [DECLARED], refreshed: [], render: 0, undo: 1, steps: ["rowField:r1.audioText", "insertRow:" + created] });
  assert.equal(document.activeElement, para(created));
  writer.closeWriter();
});

test("Shift+Enter in the Writer is not a split", async () => {
  await open();
  writer.openWriter();
  const p = para("r1");
  p.focus();
  selectText(p, 5, 5);
  observe(() => key(p, "Enter", { shiftKey: true }));
  assert.deepEqual(ids(), ["r1", "r2", "r3", "r4"]);
  writer.closeWriter();
});

const TAG = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="mug" contenteditable="false">mug</span>';
const SHOT_KEY = '<span class="broll-key" data-broll-id="bsA" contenteditable="false">B-roll:</span>';

function panelDoc() {
  return {
    schema: 2,
    title: "Panels",
    rows: [
      { id: "p1", visualText: "", audioText: "Hello there", status: "todo" },
      { id: "p2", visualText: SHOT_KEY + " gulls", audioText: "Pour the " + TAG + " now", status: "todo" }
    ],
    comments: []
  };
}

const texts = (selector) => Array.from(document.querySelectorAll(selector)).map((el) => el.textContent);
const brollScenes = () => texts("#broll-panel .broll-group-scene");
const productionScenes = () => texts("#production-panel .tag-scene");
const waitRefresh = () => new Promise((r) => setTimeout(r, 400));

const PANELS = [
  { name: "production", open: openProductionPanel, scenes: productionScenes, labels: (n) => ["0" + n] },
  { name: "b-roll", open: openBrollPanel, scenes: brollScenes, labels: (n) => ["Scene 0" + n] }
];

async function openPanelUnderWriter(panel) {
  await open(panelDoc());
  writer.openWriter();
  panel.open();
  await waitRefresh();
  assert.deepEqual(panel.scenes(), panel.labels(2), panel.name);
}

test("a Writer split refreshes the production and b-roll panels with the scene numbers after the split", async () => {
  for (const panel of PANELS) {
    await openPanelUnderWriter(panel);
    const p = para("p1");
    p.focus();
    selectText(p, 5, 5);
    key(p, "Enter");
    assert.equal(currentDocument().rows.length, 3, panel.name);
    await waitRefresh();
    assert.deepEqual(panel.scenes(), panel.labels(3), panel.name);
    writer.closeWriter();
  }
});

test("a Writer join refreshes the production and b-roll panels with the scene numbers after the join", async () => {
  for (const panel of PANELS) {
    await openPanelUnderWriter(panel);
    const p = para("p2");
    p.focus();
    selectText(p, 0, 0);
    key(p, "Backspace");
    assert.equal(currentDocument().rows.length, 1, panel.name);
    await waitRefresh();
    assert.deepEqual(panel.scenes(), panel.labels(1), panel.name);
    writer.closeWriter();
  }
});

function joinDoc(statuses) {
  return {
    schema: 2,
    title: "Join",
    rows: statuses.map((status, i) => ({ id: "j" + (i + 1), visualText: "", audioText: "Line " + (i + 1) + ".", status })),
    comments: []
  };
}

async function joinWithBackspace(doc, intoId, curId) {
  await open(doc);
  writer.openWriter();
  const p = para(curId);
  p.focus();
  selectText(p, 0, 0);
  const got = observe(() => key(p, "Backspace"));
  return Object.assign(got, { into: row(intoId), id: curId });
}

test("a join keeps the further status by rank: todo<ready<shot, either side", async () => {
  const cases = [["todo", "ready", "ready"], ["ready", "todo", "ready"], ["shot", "ready", "shot"], ["ready", "shot", "shot"], ["shot", "todo", "shot"], ["todo", "todo", "todo"], ["shot", "shot", "shot"]];
  for (const [a, b, want] of cases) {
    const got = await joinWithBackspace(joinDoc([a, b]), "j1", "j2");
    assert.equal(got.into.status, want, a + " + " + b);
    assert.deepEqual(ids(), ["j1"]);
    writer.closeWriter();
  }
});

test("a join of a scene with a status outside the ranks counts it as todo", async () => {
  await open(joinDoc(["todo", "ready"]));
  row("j1").status = "bespoke";
  row("j2").status = "also-bespoke";
  writer.openWriter();
  const p = para("j2");
  p.focus();
  selectText(p, 0, 0);
  key(p, "Backspace");
  assert.equal(row("j1").status, "bespoke");
  writer.closeWriter();
  await open(joinDoc(["todo", "ready"]));
  row("j1").status = "bespoke";
  writer.openWriter();
  const q = para("j2");
  q.focus();
  selectText(q, 0, 0);
  key(q, "Backspace");
  assert.equal(row("j1").status, "ready", "a rank above the unknown one's 0 wins");
  writer.closeWriter();
});

test("a join publishes one declared edit: one generation, one dirty, production and b-roll derived, one entry removing the later scene and writing the earlier one", async () => {
  const got = await joinWithBackspace(joinDoc(["todo", "ready"]), "j1", "j2");
  assert.deepEqual(got, Object.assign({}, got, {
    seq: 1, generation: 1, published: [DECLARED], refreshed: [], render: 0, undo: 1,
    steps: ["deleteRow:j2", "rowField:j1.audioText", "rowField:j1.status"]
  }));
  assert.equal(got.into.audioText, "Line 1. Line 2.");
  assert.match(got.into.updatedAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal(got.into.updatedBy, "Anonymous");
  writer.closeWriter();
});

test("a join glues with a space only when both sides have text and the earlier one does not end in a space", async () => {
  const doc = joinDoc(["todo", "todo", "todo", "todo", "todo"]);
  doc.rows[0].audioText = "Ends with space ";
  doc.rows[1].audioText = "next";
  doc.rows[2].audioText = "";
  doc.rows[3].audioText = "after empty";
  doc.rows[4].audioText = "";
  await open(doc);
  writer.openWriter();
  for (const id of ["j2", "j3", "j4", "j5"]) {
    const p = para(id);
    p.focus();
    selectText(p, 0, 0);
    key(p, "Backspace");
  }
  assert.deepEqual(ids(), ["j1"]);
  assert.equal(row("j1").audioText, "Ends with space next after empty");
  writer.closeWriter();
});

test("a join where the later scene has media in its audio concatenates the stored HTML instead of the run model", async () => {
  await open(joinDoc(["todo", "todo"]));
  writer.openWriter();
  const p = para("j2");
  storeMedia(p, "see " + CARD);
  assert.match(row("j2").audioText, /^see <a class="video-embed-card"/);
  selectText(p, 0, 0);
  const got = observe(() => key(p, "Backspace"));
  assert.deepEqual(ids(), ["j1"]);
  assert.match(row("j1").audioText, /^Line 1\. see <a class="video-embed-card"/);
  assert.equal(got.undo, 1);
  assert.equal(got.generation, 1);
  writer.closeWriter();
});

test("a join into a scene with a visual and nothing in the later one keeps the earlier visual and its gallery", async () => {
  const doc = joinDoc(["todo", "todo"]);
  doc.rows[0].visualText = "Keep me";
  doc.rows[0].imageLinks = LINKS;
  await open(doc);
  const links = JSON.stringify(row("j1").imageLinks);
  writer.openWriter();
  const p = para("j2");
  p.focus();
  selectText(p, 0, 0);
  const got = observe(() => key(p, "Backspace"));
  assert.deepEqual(got.steps, ["deleteRow:j2", "rowField:j1.audioText"]);
  assert.equal(row("j1").visualText, "Keep me");
  assert.equal(JSON.stringify(row("j1").imageLinks), links);
  writer.closeWriter();
});

test("a join into a scene with no visual takes the later scene's visual text and its gallery slot, and a comment on that visual follows", async () => {
  const doc = joinDoc(["todo", "todo"]);
  doc.rows[1].visualText = "Drone " + cmt("c9", "over") + " the bay";
  doc.rows[1].imageLinks = LINKS;
  doc.comments.push(comment("c9", "j2", "visualText"));
  await open(doc);
  writer.openWriter();
  const p = para("j2");
  p.focus();
  selectText(p, 0, 0);
  const got = observe(() => key(p, "Backspace"));
  assert.deepEqual(got.steps, ["deleteRow:j2", "rowField:j1.visualText", "rowField:j1.audioText", "rowField:j1.imageLinks", "docField:comments"]);
  assert.equal(got.undo, 1);
  assert.equal(row("j1").visualText, "Drone " + cmt("c9", "over") + " the bay");
  assert.equal(JSON.stringify(row("j1").imageLinks), JSON.stringify(LINKS));
  assert.deepEqual(anchors(), [["c9", "j1", "visualText"]]);
  assert.equal(undo().ok, true);
  assert.deepEqual(anchors(), [["c9", "j2", "visualText"]]);
  assert.equal(redo().ok, true);
  assert.deepEqual(anchors(), [["c9", "j1", "visualText"]]);
  writer.closeWriter();
});

test("two scenes with visuals are refused with the toast, whatever the visual is made of, and nothing changes or is counted", async () => {
  const kinds = [
    ["text and text", (d) => { d.rows[0].visualText = "One"; d.rows[1].visualText = "Two"; }],
    ["gallery and text", (d) => { d.rows[0].imageLinks = LINKS; d.rows[1].visualText = "Two"; }],
    ["text and gallery", (d) => { d.rows[0].visualText = "One"; d.rows[1].imageLinks = LINKS; }],
    ["gallery and gallery", (d) => { d.rows[0].imageLinks = LINKS; d.rows[1].imageLinks = LINKS; }]
  ];
  for (const [name, shape] of kinds) {
    const doc = joinDoc(["todo", "todo"]);
    shape(doc);
    await open(doc);
    writer.openWriter();
    const before = JSON.stringify(currentDocument());
    const p = para("j2");
    p.focus();
    selectText(p, 0, 0);
    const got = observe(() => key(p, "Backspace"));
    assert.deepEqual(got, { seq: 0, generation: 0, published: [], refreshed: [], render: 0, undo: 0, steps: [] }, name);
    assert.equal(JSON.stringify(currentDocument()), before, name);
    assert.equal(toasts().at(-1), "Both scenes have a visual — join them in the split view, so you can pick which one to keep.", name);
    writer.closeWriter();
  }
});

test("a visual of only whitespace or an empty line break does not count as a visual", async () => {
  const doc = joinDoc(["todo", "todo"]);
  doc.rows[0].visualText = "One";
  doc.rows[1].visualText = "<br>";
  await open(doc);
  writer.openWriter();
  const p = para("j2");
  p.focus();
  selectText(p, 0, 0);
  const got = observe(() => key(p, "Backspace"));
  assert.equal(got.undo, 1);
  assert.deepEqual(ids(), ["j1"]);
  assert.equal(row("j1").visualText, "One");
  writer.closeWriter();
});

test("a refused join does not end the typing group: typing again afterwards joins the earlier entry", async () => {
  const doc = joinDoc(["todo", "todo"]);
  doc.rows[0].visualText = "One";
  doc.rows[1].visualText = "Two";
  await open(doc);
  writer.openWriter();
  const p = para("j2");
  clock += 5;
  typeChar(p, "!");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  selectText(p, 0, 0);
  clock += 5;
  key(p, "Backspace");
  assert.equal(toasts().at(-1).slice(0, 4), "Both");
  clock += 5;
  typeChar(p, "?");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 }, "the refusal did not break coalescing");
  writer.closeWriter();
});

test("a join ends the typing group: typing then joining are two entries", async () => {
  await open(joinDoc(["todo", "todo"]));
  writer.openWriter();
  const p1 = para("j1");
  clock += 5;
  typeChar(p1, "!");
  await settle();
  const p2 = para("j2");
  p2.focus();
  selectText(p2, 0, 0);
  clock += 5;
  key(p2, "Backspace");
  flushEdits();
  assert.equal(undoSizes().undo, 2);
  assert.equal(undo().ok, true);
  assert.equal(row("j1").audioText, "Line 1.!");
  assert.deepEqual(ids(), ["j1", "j2"]);
  writer.closeWriter();
});

test("a join ends the typing group even when the key it follows has not been recorded yet", async () => {
  await open(joinDoc(["todo", "todo"]));
  writer.openWriter();
  const p1 = para("j1");
  clock += 5;
  typeChar(p1, "!");
  const p2 = para("j2");
  p2.focus();
  selectText(p2, 0, 0);
  key(p2, "Backspace");
  flushEdits();
  assert.equal(undoSizes().undo, 2);
  assert.equal(undo().ok, true);
  assert.equal(row("j1").audioText, "Line 1.!");
  assert.deepEqual(ids(), ["j1", "j2"]);
  writer.closeWriter();
});

test("a Writer split stores text the cell holds but the model does not yet, as its own edit, before it splits", async () => {
  await open();
  writer.openWriter();
  const p = para("r1");
  p.focus();
  p.appendChild(document.createTextNode("?"));
  selectText(p, 3, 3);
  const got = observe(() => key(p, "Enter"));
  assert.equal(got.seq, 2);
  assert.equal(got.generation, 2);
  assert.equal(got.undo, 2);
  assert.equal(row("r1").audioText, "Hel");
  assert.equal(currentDocument().rows[1].audioText, "lo there?");
  writer.closeWriter();
});

test("a join by Delete at the end of the earlier scene is the same edit as Backspace at the start of the later one", async () => {
  await open(joinDoc(["ready", "todo", "shot"]));
  writer.openWriter();
  const p = para("j1");
  p.focus();
  selectText(p, 7, 7);
  const got = observe(() => key(p, "Delete"));
  assert.deepEqual(got.steps, ["deleteRow:j2", "rowField:j1.audioText"]);
  assert.equal(got.seq, 1);
  assert.equal(row("j1").audioText, "Line 1. Line 2.");
  assert.equal(row("j1").status, "ready");
  assert.deepEqual(ids(), ["j1", "j3"]);
  writer.closeWriter();
});

test("a join of a commented phrase cut in two by a split gives one anchor back, and the comment keeps the earlier scene", async () => {
  await open();
  writer.openWriter();
  const p = para("r2");
  p.focus();
  selectText(p, 9, 9);
  key(p, "Enter");
  const created = currentDocument().rows[2].id;
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
  const q = para(created);
  q.focus();
  selectText(q, 0, 0);
  const got = observe(() => key(q, "Backspace"));
  assert.equal(got.undo, 1);
  assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bra vo charlie") + " delta");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
  writer.closeWriter();
});

function withThrowingListener(run) {
  const reported = [];
  const consoleError = console.error;
  console.error = (error) => { reported.push(error.message); };
  const off = liveSession().subscribe(() => { throw new Error("listener broke"); });
  try {
    run();
  } finally {
    off();
    console.error = consoleError;
  }
  return reported;
}

test("a grid split whose commit is followed by a throw still draws the new scene, and the throw is only reported", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.focus();
  selectText(el, 5, 5);
  const reported = withThrowingListener(() => key(el, "Enter", { altKey: true }));
  const created = currentDocument().rows[1].id;
  assert.deepEqual(reported, ["listener broke"]);
  assert.equal(row(created).audioText, " there");
  assert.ok(cellOf(created, "audioText"), "the new scene is on screen");
  assert.equal(unsavedChanges(), true);
});

test("a Writer join whose commit is followed by a throw still redraws the Writer, and the throw is only reported", async () => {
  await open(joinDoc(["todo", "ready"]));
  writer.openWriter();
  const p = para("j2");
  p.focus();
  selectText(p, 0, 0);
  const reported = withThrowingListener(() => key(p, "Backspace"));
  assert.deepEqual(reported, ["listener broke"]);
  assert.deepEqual(ids(), ["j1"]);
  assert.equal(para("j2"), null, "the joined scene left the Writer");
  assert.equal(unsavedChanges(), true);
  writer.closeWriter();
});

test("a Writer split is refused when the session turns review with the Writer open: no scene, no undo step, no new generation", async () => {
  await open();
  writer.openWriter();
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  const p = para("r1");
  p.focus();
  selectText(p, 5, 5);
  const got = observe(() => key(p, "Enter"));
  assert.equal(got.undo, 0);
  assert.equal(got.generation, 0);
  assert.equal(currentDocument().rows.length, 4);
  window.__hostedTest.setSession({ role: "edit", docId: null });
  writer.closeWriter();
});
