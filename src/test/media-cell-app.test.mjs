import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { syncFieldFromDom } = await import("../js/05-render.js");
const { undo, undoSizes, flushEdits } = await import("../js/12a-undo.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const { sanitizeHtml } = await import("../legacy/richtext.ts");
const cellText = await import("../application/commands/cell-text.ts");
const splitJoin = await import("../application/commands/split-join.ts");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");

after(closeApp);

const realNow = Date.now;
let clock = 7_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const ZW = String.fromCharCode(0x200b);
const SHA = "ab".repeat(32);
const CARD = '<a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>';
const PICTURE = '<img class="comment-img" data-blob="' + SHA + '">';
const STORED_CARD = sanitizeHtml(CARD);

function fixture() {
  return {
    schema: 2,
    title: "Media cells",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo" },
      { id: "r2", visualText: "", audioText: "Two.", status: "todo" }
    ],
    comments: []
  };
}

function joinFixture() {
  return {
    schema: 2,
    title: "Media join",
    rows: [
      { id: "j1", visualText: "", audioText: "<strong>Bold </strong>", status: "todo" },
      { id: "j2", visualText: "", audioText: "Line 2.", status: "todo" }
    ],
    comments: []
  };
}

let opened = 0;
async function open(doc) {
  if (viewFlags().writerOpen()) writer.closeWriter();
  window.__hostedTest.setSession({ role: "edit", docId: null });
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(doc || fixture())))], "media-" + (++opened) + ".splitpage", { lastModified: opened });
  await openProjectFile(file, null, { skipSnapshot: true });
  flushEdits();
}

const row = (id) => S.state.rows.find((r) => r.id === id);
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');
const para = (id) => document.querySelector('#writer-doc .wr-para[data-id="' + id + '"]');

function store(el, html) {
  el.focus();
  el.innerHTML = html;
  el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "" }));
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

function caretAt(node, offset) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function key(el, name, mods) {
  const ev = new window.KeyboardEvent("keydown", Object.assign({ key: name, bubbles: true, cancelable: true }, mods || {}));
  el.dispatchEvent(ev);
  return ev;
}

function watch() {
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  return { seen, stop };
}

beforeEach(() => { clock += 10_000; });

test("no typed HTML cell value can be produced: the typing and split commands take runs only", () => {
  assert.equal("sanitisedMediaHtml" in cellText, false, "cell-text.ts no longer offers the SanitisedMediaHtml variant");
  assert.equal("mediaHalves" in splitJoin, false, "split-join.ts no longer offers HTML halves");
});

test("a cell holding a video card is stored as the runs' canonical form, not as the sanitiser's nesting", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  const w = watch();
  try {
    store(el, "<em><strong>Hi</strong></em> " + CARD);
  } finally {
    w.stop();
  }
  assert.equal(row("r1").audioText, "<strong><em>Hi</em></strong> " + STORED_CARD);
  assert.equal(w.seen.length, 1);
  assert.equal(w.seen[0].kind, "edit");
  assert.deepEqual(w.seen[0].changes.cells.map((c) => c.field), ["audioText", "updatedAt", "updatedBy"]);
});

test("a cell holding a picture is stored as the runs' canonical form", async () => {
  await open();
  const el = cellOf("r1", "visualText");
  store(el, "<i><b>Shot</b></i> " + PICTURE + " end");
  assert.equal(row("r1").visualText, "<strong><em>Shot</em></strong> " + PICTURE + " end");
});

test("markup that changes nothing in a media cell's runs stores nothing new and records no edit", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  store(el, "Hello <strong>there</strong> " + CARD);
  const first = row("r1").audioText;
  const seq = S.editSeq, generation = liveSession().generation(), undos = undoSizes().undo;
  store(el, "Hello <strong>the</strong><strong>re</strong> " + CARD + ZW);
  assert.equal(row("r1").audioText, first);
  assert.equal(S.editSeq, seq);
  assert.equal(liveSession().generation(), generation);
  assert.equal(undoSizes().undo, undos);
});

test("a stored media cell is a fixed point of the sanitiser and of a second sync", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  store(el, "<u><mark>Look</mark></u> " + PICTURE + " <s>and</s> " + CARD + " done");
  const stored = row("r1").audioText;
  assert.equal(sanitizeHtml(stored), stored);
  const seq = S.editSeq;
  el.innerHTML = stored;
  syncFieldFromDom(el);
  assert.equal(row("r1").audioText, stored);
  assert.equal(S.editSeq, seq);
});

test("a split of a media cell cuts the runs at the caret: both halves are in canonical form", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  store(el, "Before <em><strong>bold</strong></em> " + CARD + " after");
  flushEdits();
  const at = textNodeAt(el, 3);
  caretAt(at[0], at[1]);
  key(el, "Enter", { altKey: true });
  const created = S.state.rows[1].id;
  assert.equal(row("r1").audioText, "Bef");
  assert.equal(row(created).audioText, "ore <strong><em>bold</em></strong> " + STORED_CARD + " after");
});

test("a split just after a video card keeps the card in the first scene", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  store(el, "Ab " + CARD + " cd");
  flushEdits();
  const card = el.querySelector(".video-embed-card");
  caretAt(el, Array.prototype.indexOf.call(el.childNodes, card) + 1);
  key(el, "Enter", { altKey: true });
  const created = S.state.rows[1].id;
  assert.equal(row("r1").audioText, "Ab " + STORED_CARD);
  assert.equal(row(created).audioText, " cd");
  undo();
  assert.equal(row("r1").audioText, "Ab " + STORED_CARD + " cd");
  assert.equal(S.state.rows.length, 2);
});

test("a join with media in the later scene joins the runs: no doubled space, formatting merged", async () => {
  await open(joinFixture());
  writer.openWriter();
  const p = para("j2");
  store(p, "<strong>more</strong> " + CARD);
  flushEdits();
  const start = textNodeAt(p, 0);
  caretAt(start[0], start[1]);
  key(p, "Backspace");
  assert.deepEqual(S.state.rows.map((r) => r.id), ["j1"]);
  assert.equal(row("j1").audioText, "<strong>Bold more</strong> " + STORED_CARD);
  writer.closeWriter();
});
