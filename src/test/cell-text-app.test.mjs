import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { syncFieldFromDom, handleToolbarCmd } = await import("../js/05-render.js");
const { undo, undoSizes, lastUndoEntry, flushEdits } = await import("../js/12a-undo.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const { fromHtml, sanitizeHtml, storedHtmlFromDom } = await import("../legacy/richtext.ts");
const { toHtml } = await import("../core/text/html.ts");
const writer = await import("../js/19-writer.js");

after(closeApp);

const realNow = Date.now;
let clock = 5_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const ZW = String.fromCharCode(0x200b);
const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const CARD = '<a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>';

function fixture() {
  return {
    schema: 2,
    title: "Typing command",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Alpha " + cmt("c1", "bravo") + " delta", status: "ready" },
      { id: "r3", visualText: "", audioText: "Three.", status: "todo" }
    ],
    comments: [{ id: "c1", rowId: "r2", field: "audioText", anchorId: "c1", quotedText: "", kind: "anchor", text: "note", replies: [] }]
  };
}

let opened = 0;
async function open() {
  if (writer.writerOpen) writer.closeWriter();
  const file = new File([buildSplitpageFile(migrateRows(fixture()))], "typing-" + (++opened) + ".splitpage", { lastModified: opened });
  await openProjectFile(file, null, { skipSnapshot: true });
  flushEdits();
}

const settle = () => new Promise((r) => setImmediate(r));
const row = (id) => S.state.rows.find((r) => r.id === id);
const cellOf = (id, field, root) => document.querySelector((root || "#rows") + ' .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');

function lastText(el) {
  const walker = document.createTreeWalker(el, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

function caretAt(node, offset) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function input(el, data, extra) {
  el.dispatchEvent(new window.InputEvent("input", Object.assign({ bubbles: true, inputType: "insertText", data }, extra || {})));
}

function typeChar(el, ch, extra) {
  el.focus();
  const node = lastText(el);
  node.data += ch;
  caretAt(node, node.data.length);
  input(el, ch, extra);
}

function setText(el, text, extra) {
  const node = lastText(el);
  node.data = text;
  caretAt(node, node.data.length);
  input(el, null, extra);
}

function keydown(el, key, keyCode) {
  el.dispatchEvent(new window.KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true }));
}

function compose(el, type, data) {
  el.dispatchEvent(new window.CompositionEvent(type, { bubbles: true, data: data }));
}

function watch() {
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  return { seen, stop };
}

beforeEach(() => { clock += 10_000; });

test("a keystroke is one typing command: one generation, and the change it publishes is the cell and its stamp, not the whole document", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  const generation = liveSession().generation();
  const seq = S.editSeq;
  const w = watch();
  try {
    typeChar(el, "!");
  } finally {
    w.stop();
  }
  assert.equal(row("r1").audioText, "Hello there!");
  assert.equal(liveSession().generation(), generation + 1);
  assert.equal(S.editSeq, seq + 1);
  assert.equal(w.seen.length, 1);
  const change = w.seen[0];
  assert.equal(change.kind, "edit");
  assert.equal(change.changes.whole, false);
  assert.deepEqual(change.changes.cells.map((c) => c.rowId + "." + c.field), ["r1.audioText", "r1.updatedAt", "r1.updatedBy"]);
  assert.deepEqual(change.changes.derive, ["production", "broll"]);
  assert.equal(change.changes.runsMoved, false);
});

test("an input that leaves the stored cell as it is makes no command", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  const generation = liveSession().generation();
  const stamp = row("r1").updatedAt;
  const w = watch();
  try {
    el.appendChild(document.createTextNode(ZW));
    input(el, ZW);
    syncFieldFromDom(el);
  } finally {
    w.stop();
  }
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(w.seen, []);
  assert.equal(row("r1").updatedAt, stamp);
});

test("a cell holding media is stored as its sanitised HTML through the same command", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  const w = watch();
  try {
    el.innerHTML = "Hello <b>there</b> " + CARD;
    input(el, "");
  } finally {
    w.stop();
  }
  assert.equal(row("r1").audioText, sanitizeHtml(storedHtmlFromDom(el.innerHTML)));
  assert.equal(w.seen.length, 1);
  assert.deepEqual(w.seen[0].changes.cells.map((c) => c.field), ["audioText", "updatedAt", "updatedBy"]);
});

test("typing away a commented word reconciles in the transaction; the comment keeps its place and the keystrokes stay one entry", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  const w = watch();
  try {
    clock += 5;
    el.innerHTML = "Alpha " + cmt("c1", "bravo") + " delta!";
    caretAt(lastText(el), lastText(el).data.length);
    input(el, "!");
    clock += 5;
    el.innerHTML = "Alpha  delta!";
    input(el, "");
  } finally {
    w.stop();
  }
  assert.deepEqual(w.seen.map((c) => c.changes.runsMoved), [false, true]);
  assert.equal(row("r2").audioText, "Alpha  delta!");
  assert.deepEqual(S.state.comments.map((c) => [c.id, c.rowId, c.field]), [["c1", "r2", "audioText"]]);
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  assert.deepEqual(lastUndoEntry().steps.map((s) => s.op + ":" + s.key), ["rowField:audioText"]);
});

test("in review mode, a comment a reviewer anchors on selected words is stored in the cell", async () => {
  await open();
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  try {
    const el = cellOf("r1", "audioText");
    const text = lastText(el);
    const r = document.createRange();
    r.setStart(text, 6);
    r.setEnd(text, 11);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    const generation = liveSession().generation();
    handleToolbarCmd(el.closest(".field-wrap").querySelector('[data-cmd="comment"]'));
    assert.match(row("r1").audioText, /^Hello <span class="cmt-anchor" data-cmt="c[^"]+">there<\/span>$/);
    assert.equal(liveSession().generation(), generation + 1);
    document.getElementById("comment-modal").hidden = true;
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
  }
});

test("#380: a cancelled composition that began its own undo step leaves no step behind", async () => {
  await open();
  const el = cellOf("r3", "audioText");
  el.focus();
  flushEdits();
  const sizes = undoSizes();
  compose(el, "compositionstart", "");
  clock += 5;
  typeChar(el, "x", { inputType: "insertCompositionText", isComposing: true });
  assert.equal(row("r3").audioText, "Three.x");
  await settle();
  const node = lastText(el);
  node.data = "Three.";
  caretAt(node, node.data.length);
  clock += 5;
  input(el, null, { inputType: "deleteCompositionText", isComposing: true });
  await settle();
  compose(el, "compositionend", "");
  await settle();
  assert.equal(row("r3").audioText, "Three.");
  assert.deepEqual(undoSizes(), sizes, "no empty step for Ctrl+Z to spend");
});

test("#380: in the Writer too, a cancelled composition leaves no step", async () => {
  await open();
  writer.openWriter();
  try {
    const p = document.querySelector('#writer-doc .wr-para[data-id="r3"]');
    p.focus();
    flushEdits();
    const sizes = undoSizes();
    compose(p, "compositionstart", "");
    clock += 5;
    typeChar(p, "x", { inputType: "insertCompositionText", isComposing: true });
    assert.equal(row("r3").audioText, "Three.x");
    await settle();
    const node = lastText(p);
    node.data = "Three.";
    caretAt(node, node.data.length);
    input(p, null, { inputType: "deleteCompositionText", isComposing: true });
    await settle();
    compose(p, "compositionend", "");
    await settle();
    assert.equal(row("r3").audioText, "Three.");
    assert.deepEqual(undoSizes(), sizes);
    assert.equal(writer.writerUndoStep("undo"), true, "so the first Ctrl+Z in this fresh Writer closes it");
    assert.equal(writer.writerOpen, false);
  } finally {
    writer.closeWriter();
  }
});

test("#380: a cancelled composition that joined earlier typing keeps that typing's step, unchanged", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  clock += 5;
  typeChar(el, "a");
  await settle();
  compose(el, "compositionstart", "");
  clock += 5;
  typeChar(el, "x", { inputType: "insertCompositionText", isComposing: true });
  await settle();
  const node = lastText(el);
  node.data = "Hello therea";
  caretAt(node, node.data.length);
  input(el, null, { inputType: "deleteCompositionText", isComposing: true });
  await settle();
  compose(el, "compositionend", "");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  assert.equal(lastUndoEntry().steps[0].after, "Hello therea");
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there");
});

test("#380: a committed composition is still its one step, and a cancel in another cell takes no step but its own", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  compose(el, "compositionstart", "");
  clock += 5;
  typeChar(el, "か", { inputType: "insertCompositionText", isComposing: true });
  compose(el, "compositionend", "か");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  const other = cellOf("r3", "audioText");
  compose(other, "compositionstart", "");
  compose(other, "compositionend", "");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 }, "a composition that changed nothing at all takes no step, and leaves the last one alone");
  assert.equal(lastUndoEntry().steps[0].after, "Hello thereか");
});

test("typing a letter and deleting it within a second leaves no step, and the next Ctrl+Z undoes the real entry before it", async () => {
  await open();
  clock += 5;
  typeChar(cellOf("r1", "audioText"), "!");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  clock += 5000;
  const el = cellOf("r3", "audioText");
  typeChar(el, "x");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 2, redo: 0 });
  clock += 5;
  setText(el, "Three.", { inputType: "deleteContentBackward" });
  await settle();
  assert.equal(row("r3").audioText, "Three.");
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
  el.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" }));
  compose(el, "compositionstart", "");
  compose(el, "compositionend", "");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 1, redo: 0 }, "neither a stray compositionend nor a composition that typed nothing takes the real entry");
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there");
  assert.equal(row("r3").audioText, "Three.");
});

test("in the Writer, typing a letter and deleting it leaves no step, so the first Ctrl+Z in a fresh Writer closes it", async () => {
  await open();
  writer.openWriter();
  try {
    const p = document.querySelector('#writer-doc .wr-para[data-id="r3"]');
    clock += 5;
    typeChar(p, "x");
    await settle();
    clock += 5;
    setText(p, "Three.", { inputType: "deleteContentBackward" });
    await settle();
    assert.deepEqual(undoSizes(), { undo: 0, redo: 0 });
    assert.equal(writer.writerUndoStep("undo"), true);
    assert.equal(writer.writerOpen, false);
  } finally {
    writer.closeWriter();
  }
});

test("Ctrl+Y after the Ctrl+Z that closed the Writer reopens it, but not once typing has happened since, even typing that left no step", async () => {
  await open();
  clock += 5;
  typeChar(cellOf("r1", "audioText"), "!");
  await settle();
  clock += 5000;
  writer.openWriter();
  try {
    assert.equal(writer.writerUndoStep("undo"), true);
    assert.equal(writer.writerOpen, false);
    assert.equal(writer.writerUndoStep("redo"), true);
    assert.equal(writer.writerOpen, true);
    assert.equal(writer.writerUndoStep("undo"), true);
    assert.equal(writer.writerOpen, false);
    const el = cellOf("r3", "audioText");
    clock += 5;
    typeChar(el, "x");
    await settle();
    clock += 5;
    setText(el, "Three.", { inputType: "deleteContentBackward" });
    await settle();
    assert.deepEqual(undoSizes(), { undo: 1, redo: 0 });
    assert.equal(writer.writerUndoStep("redo"), false);
    assert.equal(writer.writerOpen, false);
  } finally {
    writer.closeWriter();
  }
});

async function slowComposition(el, start, updates, end) {
  compose(el, "compositionstart", "");
  for (const text of updates) {
    clock += 1100;
    setText(el, start + text, { inputType: "insertCompositionText", isComposing: true });
    await settle();
  }
  clock += 1100;
  if (end === "edge") {
    setText(el, start, { inputType: "deleteCompositionText", isComposing: true });
    await settle();
    compose(el, "compositionend", "");
  } else if (end === "firefox") {
    compose(el, "compositionend", "");
    await settle();
    setText(el, start, { inputType: "deleteCompositionText", isComposing: false });
  } else {
    compose(el, "compositionend", "");
    keydown(el, "Process", 229);
    setText(el, start, { inputType: "deleteByComposition", isComposing: false });
  }
  await settle();
}

for (const end of ["edge", "firefox", "safari"]) {
  test(`#380: a slow composition, each update more than a second apart, leaves no step when cancelled (${end} event order)`, async () => {
    await open();
    const el = cellOf("r3", "audioText");
    el.focus();
    flushEdits();
    const sizes = undoSizes();
    await slowComposition(el, "Three.", ["ね", "ねこ", "ねこが"], end);
    assert.equal(row("r3").audioText, "Three.");
    assert.deepEqual(undoSizes(), sizes, "no step left for Ctrl+Z to spend");
    undo();
    assert.equal(row("r3").audioText, "Three.", "and Ctrl+Z does not bring the cancelled text back");
  });
}

test("#380: in the Writer too, a slow cancelled composition leaves no step", async () => {
  await open();
  writer.openWriter();
  try {
    const p = document.querySelector('#writer-doc .wr-para[data-id="r3"]');
    p.focus();
    flushEdits();
    const sizes = undoSizes();
    await slowComposition(p, "Three.", ["に", "にほ"], "edge");
    assert.equal(row("r3").audioText, "Three.");
    assert.deepEqual(undoSizes(), sizes);
  } finally {
    writer.closeWriter();
  }
});

for (const end of ["firefox", "safari"]) {
  test(`#380: a fast cancelled composition leaves no step when compositionend comes before the reverting input (${end} event order)`, async () => {
    await open();
    const el = cellOf("r3", "audioText");
    el.focus();
    flushEdits();
    const sizes = undoSizes();
    compose(el, "compositionstart", "");
    clock += 5;
    typeChar(el, "x", { inputType: "insertCompositionText", isComposing: true });
    await settle();
    clock += 5;
    compose(el, "compositionend", "");
    if (end === "safari") keydown(el, "Process", 229);
    setText(el, "Three.", { inputType: end === "safari" ? "deleteByComposition" : "deleteCompositionText", isComposing: false });
    await settle();
    assert.equal(row("r3").audioText, "Three.");
    assert.deepEqual(undoSizes(), sizes);
  });
}

test("#380: a slow committed composition keeps its steps, and so does deleting it again later with a key", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.focus();
  flushEdits();
  compose(el, "compositionstart", "");
  for (const text of ["k", "ka", "か"]) {
    clock += 1100;
    setText(el, "Hello there" + text, { inputType: "insertCompositionText", isComposing: true });
    await settle();
  }
  compose(el, "compositionend", "か");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 3, redo: 0 }, "a committed composition undoes through its updates, as before");
  clock += 1100;
  keydown(el, "Backspace", 8);
  setText(el, "Hello there", { inputType: "deleteContentBackward" });
  await settle();
  assert.equal(row("r1").audioText, "Hello there");
  assert.deepEqual(undoSizes(), { undo: 4, redo: 0 }, "a later key's edit is its own step, not part of the composition");
});

test("#380: a composition start that never ended does not reach back past the next composition's own start", async () => {
  await open();
  const el = cellOf("r3", "audioText");
  el.focus();
  flushEdits();
  compose(el, "compositionstart", "");
  clock += 5;
  typeChar(el, "x");
  await settle();
  clock += 1100;
  setText(el, "Three.", { inputType: "deleteContentBackward" });
  await settle();
  assert.deepEqual(undoSizes(), { undo: 2, redo: 0 });
  compose(el, "compositionstart", "");
  compose(el, "compositionend", "");
  await settle();
  assert.deepEqual(undoSizes(), { undo: 2, redo: 0 }, "the typing before the second composition keeps its two steps");
});

test("every zero-width caret spot is stripped, not just the first: a cell with two video cards", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.innerHTML = "One " + CARD + ZW + " two " + CARD + ZW;
  input(el, "");
  assert.equal(row("r1").audioText, oracle(el.innerHTML));
  assert.equal(row("r1").audioText.indexOf(ZW), -1);
});

test("a typing command that fails is thrown from the view and leaves the cell, the edit count and undo as they were", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  flushEdits();
  const seq = S.editSeq, generation = liveSession().generation(), sizes = undoSizes();
  const before = JSON.stringify(S.state);
  const real = Date.prototype.toISOString;
  Date.prototype.toISOString = function () { throw new Error("no clock"); };
  try {
    el.focus();
    lastText(el).data += "!";
    assert.throws(() => syncFieldFromDom(el), /no clock/);
  } finally {
    Date.prototype.toISOString = real;
  }
  await settle();
  assert.equal(JSON.stringify(S.state), before);
  assert.equal(S.editSeq, seq);
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(undoSizes(), sizes);
});

function seeded(seed) {
  let s = Math.imul(seed, 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) / 16777216;
  };
}

const PIECES = [
  "word", " ", "two words", "&amp;", "&lt;b&gt;", "&nbsp;", ZW, "<br>", "かな",
  "<b>bold</b>", "<strong>strong</strong>", "<i>it</i>", "<em>em</em>", "<u>u</u>", "<s>s</s>", "<mark>hl</mark>",
  cmt("c1", "noted"), cmt("c2", "<b>both</b>"), '<span class="stage-dir">(beat)</span>', '<span class="audio-cue">SFX: door</span>',
  '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span>',
  '<a href="https://example.com/x" target="_blank" rel="noopener">link</a>', '<a href="javascript:alert(1)">bad</a>',
  '<span style="font-weight: bold">styled</span>', '<font color="red">font</font>', "<div>block</div>", "<p>para</p>",
  '<span class="tag-anchor" data-tag-cat="props" data-tag-name="Net" contenteditable="false">Net</span>',
  CARD, '<img src="https://example.com/a.png" alt="">', "<script>x()</script>"
];

function randomCell(r) {
  let out = "";
  const n = Math.floor(r() * 6);
  for (let i = 0; i < n; i++) out += PIECES[Math.floor(r() * PIECES.length)];
  return out;
}

function oracle(inner) {
  let html = inner.indexOf(ZW) === -1 ? inner : inner.split(ZW).join("");
  html = storedHtmlFromDom(html);
  return /<img|video-embed-card/.test(html) ? sanitizeHtml(html) : toHtml(fromHtml(html));
}

test("differential (seeded): the stored cell, the stamp and the edit count match the base's syncFieldFromDom on generated cell HTML", async () => {
  await open();
  const fields = ["audioText", "visualText"];
  let changed = 0, same = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const r = seeded(seed);
    const field = fields[Math.floor(r() * 2)];
    const el = cellOf("r1", field);
    el.innerHTML = r() < 0.2 ? row("r1")[field] : randomCell(r);
    const want = oracle(el.innerHTML);
    const was = row("r1")[field];
    const seq = S.editSeq, generation = liveSession().generation();
    clock += 1000;
    const stamp = "unstamped " + seed;
    row("r1").updatedAt = stamp;
    syncFieldFromDom(el);
    assert.equal(row("r1")[field], want, "seed " + seed);
    const moved = was !== want;
    assert.equal(S.editSeq - seq, moved ? 1 : 0, "seed " + seed + ": one edit exactly when the stored cell changes");
    assert.equal(liveSession().generation() - generation, moved ? 1 : 0, "seed " + seed);
    assert.equal(row("r1").updatedAt !== stamp, moved, "seed " + seed + ": stamped exactly when it changes");
    if (moved) changed++; else same++;
    syncFieldFromDom(el);
    assert.equal(S.editSeq - seq, moved ? 1 : 0, "seed " + seed + ": the same cell again is a no-op");
  }
  assert.ok(changed > 150 && same > 10, "both paths were exercised: " + changed + " changed, " + same + " unchanged");
});
