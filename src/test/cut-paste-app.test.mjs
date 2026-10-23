import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { saveChanges, unsavedChanges } from "../legacy/save-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
window.__splitpageNoRemote = true;
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { currentDocument, liveSession } = await import("../legacy/session-bridge.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { copyFromCell, pasteIntoCell } = await import("../js/05c-clipboard.js");
const { render } = await import("../js/05-render.js");
const { cellEditing } = await import("../legacy/editor-bridge.ts");
const { cellSelection } = await import("../features/common/cell-selection.ts");
const { armDeleteComment } = await import("../js/10-comments.js");
const { undo, redo, undoSizes, lastUndoEntry, flushEdits } = await import("../js/12a-undo.js");
const { openDocument } = await import("../legacy/transition-bridge.ts");

after(closeApp);

const realNow = Date.now;
let clock = 5_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const KEY = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;
const CARD = '<a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>';
const comment = (id, rowId, field) => ({ id, rowId, field, anchorId: id, quotedText: "", kind: "anchor", text: "note", replies: [] });
const PIC = { sha256: "a".repeat(64), width: 4, height: 3, mime: "image/png" };
const OLD = "2026-01-01T00:00:00.000Z";

function fixture() {
  return {
    schema: 2,
    title: "Cut and paste",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r2", visualText: "Close", audioText: "Alpha " + cmt("c1", "bravo charlie") + " delta", status: "ready", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r3", visualText: KEY("bsA") + " gulls", audioText: "Three.", status: "todo", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r4", visualText: "", audioText: "Four " + cmt("c2", "words") + ".", status: "shot", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r5", visualText: "Holds", audioText: "Five", status: "todo", updatedAt: OLD, updatedBy: "Sam" }
    ],
    comments: [comment("c1", "r2", "audioText"), comment("c2", "r4", "audioText")]
  };
}

let opened = 0;
async function open(doc) {
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(doc || fixture())))], "cut-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } });
  flushEdits();
}

function holdMedia() {
  row("r5").visualText = "Holds " + CARD;
  render();
  cellEditing().sync(cellOf("r5", "visualText"));
  row("r5").updatedAt = OLD;
  row("r5").updatedBy = "Sam";
  flushEdits();
}

const session = liveSession();
const row = (id) => currentDocument().rows.find((r) => r.id === id);
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');
const anchors = () => currentDocument().comments.map((c) => [c.id, c.rowId, c.field]);
const toasts = () => Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)")).map((t) => t.textContent);

function clip(type, el, data) {
  const store = Object.assign({}, data || {});
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: { getData: (t) => store[t] || "", setData: (t, v) => { store[t] = v; }, files: [], types: Object.keys(store) }
  });
  el.dispatchEvent(ev);
  return { store, prevented: ev.defaultPrevented };
}

function selectText(el, from, to) {
  const walker = document.createTreeWalker(el, 4);
  let at = 0, start = null, end = null;
  while (walker.nextNode()) {
    const n = walker.currentNode, len = n.data.length;
    if (!start && from <= at + len) start = [n, from - at];
    if (!end && to <= at + len) { end = [n, to - at]; break; }
    at += len;
  }
  const r = document.createRange();
  r.setStart(start[0], start[1]);
  r.setEnd(end[0], end[1]);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function selectAll(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function record(run) {
  flushEdits();
  const seq0 = saveChanges(), gen0 = session.generation(), undo0 = undoSizes().undo, top0 = lastUndoEntry();
  const heard = [];
  const stop = session.subscribe((c) => heard.push(c.kind));
  const out = run();
  stop();
  const seq = saveChanges() - seq0, generation = session.generation() - gen0;
  flushEdits();
  const top = lastUndoEntry();
  const steps = top && top !== top0 ? top.steps.map((s) => s.op + ":" + (s.op === "rowField" ? s.rowId + "." + s.key : s.op === "docField" ? s.key : s.row ? s.row.id : "")) : [];
  return { seq, generation, heard, undo: undoSizes().undo - undo0, steps, out };
}

beforeEach(() => { clock += 10_000; });

test("a copy writes the words and their formatting, prevents the default and changes nothing", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const before = JSON.stringify(currentDocument());
  const got = record(() => clip("copy", el));
  assert.equal(got.out.prevented, true);
  assert.equal(got.out.store["text/plain"], "bravo charlie");
  assert.equal(got.out.store["text/html"], "bravo charlie", "a copy carries no comment mark and no cut marker");
  assert.deepEqual({ seq: got.seq, generation: got.generation, heard: got.heard, undo: got.undo }, { seq: 0, generation: 0, heard: [], undo: 0 });
  assert.equal(JSON.stringify(currentDocument()), before);
});

test("a cut dirties once, stamps only the cut scene, and records one entry for the one cell", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.focus();
  selectText(el, 0, 6);
  const got = record(() => clip("cut", el));
  assert.equal(got.out.prevented, true);
  assert.equal(got.out.store["text/plain"], "Hello ");
  assert.match(got.out.store["text/html"], /^<span data-splitpage-cut="[0-9a-f]{32}">Hello <\/span>$/);
  assert.deepEqual({ seq: got.seq, generation: got.generation, heard: got.heard, undo: got.undo, steps: got.steps },
    { seq: 1, generation: 1, heard: ["edit"], undo: 1, steps: ["rowField:r1.audioText"] });
  assert.equal(row("r1").audioText, "there");
  assert.notEqual(row("r1").updatedAt, OLD);
  assert.equal(row("r2").updatedAt, OLD);
  assert.equal(unsavedChanges(), true);
  assert.equal(document.activeElement, cellOf("r1", "audioText"));
});

test("a cut leaves the caret collapsed at the cut point, not at the start of the cell", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.focus();
  selectText(el, 3, 8);
  clip("cut", el);
  assert.equal(row("r1").audioText, "Helere");
  assert.deepEqual(cellSelection(cellOf("r1", "audioText")), { from: 3, to: 3 });
});

test("a cut with nothing selected, or a cell holding a picture or video card, is not taken at all", async () => {
  await open();
  holdMedia();
  const empty = cellOf("r1", "audioText");
  empty.focus();
  selectText(empty, 3, 3);
  let got = record(() => clip("cut", empty));
  assert.equal(got.out.prevented, false);
  assert.deepEqual(got.out.store, {});
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo }, { seq: 0, generation: 0, undo: 0 });
  const holder = cellOf("r5", "visualText");
  holder.focus();
  selectAll(holder);
  got = record(() => clip("cut", holder));
  assert.equal(got.out.prevented, false);
  assert.deepEqual(got.out.store, {});
  assert.match(row("r5").visualText, /^Holds <a class="video-embed-card"/);
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo }, { seq: 0, generation: 0, undo: 0 });
});

test("a plain paste over a selection dirties once and is one entry; the stamp is the pasted scene's only", async () => {
  await open();
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 0, 5);
  const got = record(() => clip("paste", to, { "text/plain": "Two" }));
  assert.equal(row("r3").audioText, "Two.");
  assert.deepEqual({ seq: got.seq, generation: got.generation, heard: got.heard, undo: got.undo, steps: got.steps },
    { seq: 1, generation: 1, heard: ["edit"], undo: 1, steps: ["rowField:r3.audioText"] });
  assert.notEqual(row("r3").updatedAt, OLD);
  assert.equal(row("r1").updatedAt, OLD);
  assert.equal(document.activeElement, cellOf("r3", "audioText"));
  const sel = window.getSelection().getRangeAt(0);
  assert.equal(sel.collapsed, true);
  assert.equal(sel.startContainer.data.slice(0, sel.startOffset), "Two");
  assert.equal(undo().ok, true);
  assert.equal(row("r3").audioText, "Three.");
  assert.equal(redo().ok, true);
  assert.equal(row("r3").audioText, "Two.");
});

test("a paste into a cell that holds a picture or video card is refused: nothing changes and nothing is dirtied", async () => {
  await open();
  holdMedia();
  const to = cellOf("r5", "visualText");
  to.focus();
  selectText(to, 0, 0);
  assert.match(row("r5").visualText, /video-embed-card/);
  const before = JSON.stringify(currentDocument());
  const got = record(() => clip("paste", to, { "text/plain": "more", "text/html": "more" }));
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo }, { seq: 0, generation: 0, undo: 0 });
  const res = pasteIntoCell(to, "more", "more", null);
  assert.equal(res.done, false);
  assert.equal(JSON.stringify(currentDocument()), before);
});

test("a video link pasted on its own attaches to the scene's gallery, leaves the words, and dirties once", async () => {
  await open();
  const to = cellOf("r1", "audioText");
  to.focus();
  selectText(to, 11, 11);
  const got = record(() => clip("paste", to, { "text/plain": "https://vimeo.com/76979871" }));
  assert.equal(row("r1").audioText, "Hello there");
  assert.deepEqual(row("r1").imageLinks, [{ href: "https://vimeo.com/76979871", poster: true }]);
  assert.notEqual(row("r1").updatedAt, OLD);
  assert.deepEqual({ seq: got.seq, generation: got.generation, heard: got.heard, undo: got.undo, steps: got.steps },
    { seq: 1, generation: 1, heard: ["edit"], undo: 1, steps: ["rowField:r1.imageLinks"] });
  assert.ok(toasts().some((t) => t.indexOf("Video added to scene 1") === 0));
});

test("the same video link pasted again is dirtied and stamped but makes no second tile and no undo entry", async () => {
  await open();
  const to = cellOf("r1", "audioText");
  to.focus();
  selectText(to, 11, 11);
  clip("paste", to, { "text/plain": "https://vimeo.com/76979871" });
  flushEdits();
  clock += 5000;
  to.focus();
  selectText(to, 11, 11);
  const stamp = row("r1").updatedAt;
  const got = record(() => clip("paste", to, { "text/plain": "https://vimeo.com/76979871" }));
  assert.equal(row("r1").imageLinks.length, 1);
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo, steps: got.steps }, { seq: 1, generation: 1, undo: 0, steps: [] });
  assert.notEqual(row("r1").updatedAt, stamp, "the stamp still moves");
});

test("words with a video link inside are typed in and the link is attached too: one dirty, one entry", async () => {
  await open();
  const to = cellOf("r1", "audioText");
  to.focus();
  selectText(to, 11, 11);
  const got = record(() => clip("paste", to, { "text/plain": " see https://youtu.be/abc123 now" }));
  assert.equal(row("r1").audioText, "Hello there see https://youtu.be/abc123 now");
  assert.deepEqual(row("r1").imageLinks, [{ href: "https://youtu.be/abc123", poster: true }]);
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo, steps: got.steps },
    { seq: 1, generation: 1, undo: 1, steps: ["rowField:r1.audioText", "rowField:r1.imageLinks"] });
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there");
  assert.equal(row("r1").imageLinks, undefined);
});

test("pasteIntoCell reports what it did: done, the words, what it attached and whether comments moved", async () => {
  await open();
  const to = cellOf("r1", "audioText");
  to.focus();
  selectText(to, 0, 0);
  const attach = [{ kind: "image", ref: PIC, name: "a.png" }, { kind: "video", href: "https://vimeo.com/1" }];
  const res = pasteIntoCell(to, "", "Lead ", { attach });
  assert.deepEqual(
    { done: res.done, media: res.media, lost: res.lost, attached: res.attached, rowIndex: res.rowIndex, field: res.field, movedComments: res.movedComments, same: res.cellEl === to },
    { done: true, media: 0, lost: 0, attached: { pictures: 1, videos: 1, links: ["https://vimeo.com/1"] }, rowIndex: 0, field: "audioText", movedComments: false, same: true });
  assert.equal(row("r1").audioText, "Lead Hello there");
  assert.deepEqual(row("r1").imageRef, PIC);
  assert.deepEqual(row("r1").moreImages, [{ links: [{ href: "https://vimeo.com/1", poster: true }] }]);
  const gone = pasteIntoCell(to, "", "", { attach: [] });
  assert.equal(gone.done, true);
  assert.equal(gone.attached, null);
});

test("a video file with no name adds no tile, so nothing is edited, stamped or dirtied", async () => {
  await open();
  const to = cellOf("r1", "audioText");
  assert.equal(unsavedChanges(), false);
  const got = record(() => pasteIntoCell(to, "", "", { attach: [{ kind: "videoFile", name: "", size: 3 }] }));
  assert.equal(got.out.done, true);
  assert.equal(got.out.attached, null);
  assert.deepEqual({ seq: got.seq, generation: got.generation, heard: got.heard, undo: got.undo }, { seq: 0, generation: 0, heard: [], undo: 0 });
  assert.equal(unsavedChanges(), false);
  assert.equal(row("r1").updatedAt, OLD);
  assert.equal(row("r1").moreImages, undefined);
});

test("attached pictures with no words: no repaint of the cell, the stamp moves, the gallery fields are set", async () => {
  await open();
  const to = cellOf("r3", "audioText");
  const node = to.firstChild;
  const res = pasteIntoCell(to, "", "", { attach: [{ kind: "image", ref: PIC, name: "p.png" }], skipImages: true });
  assert.equal(res.done, true);
  assert.deepEqual(res.attached, { pictures: 1, videos: 0, links: [] });
  assert.deepEqual(row("r3").imageRef, PIC);
  assert.equal(row("r3").imageName, "p.png");
  assert.notEqual(row("r3").updatedAt, OLD);
  assert.equal(to.firstChild, node, "the words were not touched");
  assert.equal(row("r3").audioText, "Three.");
});

test("a paste at the end of an unfocused cell with no selection lands after the last word", async () => {
  await open();
  const to = cellOf("r1", "audioText");
  window.getSelection().removeAllRanges();
  const res = pasteIntoCell(to, "", "!", null);
  assert.equal(res.done, true);
  assert.equal(row("r1").audioText, "Hello there!");
});

test("a pasted picture or video card is taken out of the words; in a visual cell, directions and cues are flattened", async () => {
  await open();
  const to = cellOf("r4", "visualText");
  to.focus();
  selectAll(to);
  const html = 'drone <span class="stage-dir">pans</span> <span class="audio-cue">hum</span>' + CARD;
  const got = record(() => clip("paste", to, { "text/html": html, "text/plain": "drone pans hum" }));
  assert.equal(row("r4").visualText.indexOf("stage-dir"), -1);
  assert.equal(row("r4").visualText.indexOf("audio-cue"), -1);
  assert.equal(row("r4").visualText.indexOf("video-embed-card"), -1);
  assert.match(row("r4").visualText, /^drone \(pans\) hum/);
  assert.deepEqual(row("r4").imageLinks, [{ href: "https://youtu.be/abc", poster: true }]);
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo }, { seq: 1, generation: 1, undo: 1 });
});

test("a cut b-roll key pasted back in the same tab: one entry, no second shot record, undo and redo keep the shot list", async () => {
  await open();
  const el = cellOf("r3", "visualText");
  el.focus();
  selectAll(el);
  const cut = clip("cut", el);
  const to = cellOf("r4", "visualText");
  to.focus();
  selectAll(to);
  const got = record(() => clip("paste", to, cut.store));
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo, steps: got.steps },
    { seq: 1, generation: 1, undo: 1, steps: ["rowField:r4.visualText"] });
  assert.deepEqual(currentDocument().brollShots.map((s) => s.id), ["bsA"]);
  assert.equal(row("r4").visualText, KEY("bsA") + " gulls");
  assert.equal(undo().ok, true);
  assert.equal(row("r4").visualText, "");
  assert.equal(redo().ok, true);
  assert.equal(row("r4").visualText, KEY("bsA") + " gulls");
});

test("a copied b-roll key gets a fresh id and a shot record seeded from the scene's words; one undo takes both", async () => {
  await open();
  const el = cellOf("r3", "visualText");
  el.focus();
  selectAll(el);
  const copied = clip("copy", el);
  const to = cellOf("r4", "visualText");
  to.focus();
  selectAll(to);
  const got = record(() => clip("paste", to, copied.store));
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo, steps: got.steps },
    { seq: 1, generation: 1, undo: 1, steps: ["rowField:r4.visualText", "docField:brollShots"] });
  const id = /data-broll-id="([^"]+)"/.exec(row("r4").visualText)[1];
  const shot = currentDocument().brollShots.find((s) => s.id === id);
  assert.ok(shot);
  assert.equal(shot.name, "gulls");
  assert.equal(shot.audioRef, "Four words.");
  assert.equal(shot.origin, "script");
  assert.equal(undo().ok, true);
  assert.deepEqual(currentDocument().brollShots.map((s) => s.id), ["bsA"]);
  assert.equal(redo().ok, true);
  assert.deepEqual(currentDocument().brollShots.map((s) => s.id), ["bsA", id]);
});

test("a cut's comment follows its words into the next paste, which is one dirty for the cell and the move", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  const got = record(() => clip("paste", to, cut.store));
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo, steps: got.steps },
    { seq: 1, generation: 1, undo: 1, steps: ["rowField:r3.audioText", "docField:comments"] });
  assert.equal(row("r3").audioText, "Three." + cmt("c1", "bravo charlie"));
  assert.deepEqual(anchors(), [["c1", "r3", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a second paste of the same cut is a plain paste: the comment mark is dropped", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  const first = cellOf("r3", "audioText");
  first.focus();
  selectText(first, 6, 6);
  clip("paste", first, cut.store);
  const second = cellOf("r1", "audioText");
  second.focus();
  selectText(second, 11, 11);
  const got = record(() => clip("paste", second, cut.store));
  assert.equal(row("r1").audioText, "Hello therebravo charlie");
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo }, { seq: 1, generation: 1, undo: 1 });
  assert.deepEqual(anchors(), [["c1", "r3", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a cut undone and then pasted brings the words and no second anchor for the comment", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  assert.equal(row("r2").audioText, "Alpha  delta");
  undo();
  assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bravo charlie") + " delta");
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  clip("paste", to, cut.store);
  assert.equal(row("r3").audioText, "Three.bravo charlie");
  assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bravo charlie") + " delta");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a cut undone and pasted over its own restored words keeps the comment on those words", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  undo();
  const again = cellOf("r2", "audioText");
  again.focus();
  selectText(again, 6, 19);
  clip("paste", again, cut.store);
  assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bravo charlie") + " delta");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a cut undone and pasted before its own restored words brings no second anchor", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  undo();
  const again = cellOf("r2", "audioText");
  again.focus();
  selectText(again, 0, 0);
  clip("paste", again, cut.store);
  assert.equal(row("r2").audioText, "bravo charlieAlpha " + cmt("c1", "bravo charlie") + " delta");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a cut undone and pasted after its own restored words brings no second anchor", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  undo();
  const again = cellOf("r2", "audioText");
  again.focus();
  selectText(again, 25, 25);
  clip("paste", again, cut.store);
  assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bravo charlie") + " deltabravo charlie");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a cut undone from a picture cell and pasted brings no second anchor", async () => {
  const doc = fixture();
  doc.rows[1].visualText = "Close " + cmt("c1", "bravo charlie") + " up";
  doc.rows[1].audioText = "Alpha delta";
  doc.comments = [comment("c1", "r2", "visualText"), comment("c2", "r4", "audioText")];
  await open(doc);
  const el = cellOf("r2", "visualText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  undo();
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  clip("paste", to, cut.store);
  assert.equal(row("r3").audioText, "Three.bravo charlie");
  assert.deepEqual(anchors(), [["c1", "r2", "visualText"], ["c2", "r4", "audioText"]]);
});

test("a cut undone and redone, then pasted, still moves the comment with its words", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  undo();
  redo();
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  clip("paste", to, cut.store);
  assert.equal(row("r3").audioText, "Three." + cmt("c1", "bravo charlie"));
  assert.deepEqual(anchors(), [["c1", "r3", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a cut undone and pasted over its restored words that the model has not heard moved yet keeps the comment on them", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  undo();
  const again = cellOf("r2", "audioText");
  again.focus();
  again.firstChild.data = "XX" + again.firstChild.data;
  selectText(again, 8, 21);
  clip("paste", again, cut.store);
  assert.equal(row("r2").audioText, "XXAlpha " + cmt("c1", "bravo charlie") + " delta");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a cut undone and pasted over the same offsets in another scene, or in the other cell of its own scene, brings no second anchor", async () => {
  for (const [rowId, field] of [["r1", "audioText"], ["r2", "visualText"]]) {
    const doc = fixture();
    doc.rows[0].audioText = "Hello there, all of you";
    doc.rows[1].visualText = "Close shot of the harbour";
    await open(doc);
    const el = cellOf("r2", "audioText");
    el.focus();
    selectText(el, 6, 19);
    const cut = clip("cut", el);
    undo();
    const to = cellOf(rowId, field);
    to.focus();
    selectText(to, 6, 19);
    clip("paste", to, cut.store);
    assert.equal(row(rowId)[field].indexOf("cmt-anchor"), -1, rowId + "." + field);
    assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bravo charlie") + " delta");
    assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
  }
});

test("a cut whose comment was deleted before the paste brings the words with no mark", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  armDeleteComment(null, "c1");
  armDeleteComment(null, "c1");
  assert.deepEqual(anchors(), [["c2", "r4", "audioText"]]);
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  clip("paste", to, cut.store);
  assert.equal(row("r3").audioText, "Three.bravo charlie");
  assert.deepEqual(anchors(), [["c2", "r4", "audioText"]]);
});

test("a cut of part of a comment's words pastes them plain and the comment stays on the rest", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 11);
  const cut = clip("cut", el);
  const kept = row("r2").audioText;
  assert.match(kept, /data-cmt="c1"/);
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  const got = record(() => clip("paste", to, cut.store));
  assert.equal(row("r3").audioText, "Three.bravo");
  assert.deepEqual(got.steps, ["rowField:r3.audioText"]);
  assert.equal(row("r2").audioText, kept);
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a cut of one of two cells holding a comment pastes its words plain and the other cell keeps the comment", async () => {
  const doc = fixture();
  doc.rows[1].audioText = "Alpha " + cmt("c1", "bravo");
  doc.rows[2].audioText = cmt("c1", "charlie") + " delta";
  await open(doc);
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 11);
  const cut = clip("cut", el);
  const to = cellOf("r1", "audioText");
  to.focus();
  selectText(to, 11, 11);
  clip("paste", to, cut.store);
  assert.equal(row("r1").audioText, "Hello therebravo");
  assert.equal(row("r3").audioText, cmt("c1", "charlie") + " delta");
  assert.equal(currentDocument().comments.filter((c) => c.id === "c1").length, 1);
});

test("a paste of another tab's cut, or of a cut whose comment no longer exists, brings the words and no comment", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  const foreign = { "text/html": cut.store["text/html"].replace(/data-splitpage-cut="[0-9a-f]+"/, 'data-splitpage-cut="ffff"'), "text/plain": cut.store["text/plain"] };
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  const got = record(() => clip("paste", to, foreign));
  assert.equal(row("r3").audioText, "Three.bravo charlie");
  assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo, steps: got.steps },
    { seq: 1, generation: 1, undo: 1, steps: ["rowField:r3.audioText"] });
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a paste over a selection holding a comment's words leaves the comment where it was", async () => {
  await open();
  const to = cellOf("r2", "audioText");
  to.focus();
  selectText(to, 6, 19);
  record(() => clip("paste", to, { "text/plain": "kilo" }));
  assert.equal(row("r2").audioText, "Alpha kilo delta");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a scene that has left the document: a paste into its stale cell is refused and an attach does nothing", async () => {
  await open();
  const stale = cellOf("r1", "audioText").cloneNode(true);
  stale.setAttribute("data-id", "gone");
  const before = JSON.stringify(currentDocument());
  const text = pasteIntoCell(stale, "", "x", null);
  assert.equal(text.done, false);
  assert.equal(text.rowIndex, -1);
  const files = pasteIntoCell(stale, "", "", { attach: [{ kind: "video", href: "https://vimeo.com/1" }] });
  assert.equal(files.done, true);
  assert.equal(files.attached, null);
  assert.equal(JSON.stringify(currentDocument()), before);
});

test("in review mode a cut only copies and a paste is ignored: the words stay, no marker is written, nothing is dirtied", async () => {
  await open();
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  try {
    const el = cellOf("r1", "audioText");
    el.focus();
    selectText(el, 0, 6);
    const before = JSON.stringify(currentDocument());
    const got = record(() => clip("cut", el));
    assert.equal(got.out.prevented, true);
    assert.equal(got.out.store["text/plain"], "Hello ");
    assert.equal(got.out.store["text/html"], "Hello ", "a copy, with no cut marker");
    assert.equal(JSON.stringify(currentDocument()), before);
    assert.deepEqual({ seq: got.seq, generation: got.generation, undo: got.undo }, { seq: 0, generation: 0, undo: 0 });
    const to = cellOf("r3", "audioText");
    to.focus();
    selectText(to, 6, 6);
    const pasted = record(() => clip("paste", to, { "text/plain": "x", "text/html": "x" }));
    assert.equal(pasted.out.prevented, true, "the browser's own paste is still stopped");
    assert.equal(row("r3").audioText, "Three.");
    assert.deepEqual({ seq: pasted.seq, generation: pasted.generation, undo: pasted.undo }, { seq: 0, generation: 0, undo: 0 });
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
  }
});
test("the undo entry of a cut or a paste is on the stack as soon as the call returns, which the Undo toast relies on", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.focus();
  selectText(el, 0, 6);
  flushEdits();
  const start = lastUndoEntry();
  const cut = clip("cut", el);
  const cutEntry = lastUndoEntry();
  assert.notEqual(cutEntry, start);
  assert.deepEqual(cutEntry.steps.map((s) => s.key), ["audioText"]);
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  flushEdits();
  clip("paste", to, { "text/plain": "https://vimeo.com/76979871" });
  const attachEntry = lastUndoEntry();
  assert.notEqual(attachEntry, cutEntry);
  assert.deepEqual(attachEntry.steps.map((s) => s.key), ["imageLinks"]);
  to.focus();
  selectText(to, 6, 6);
  clip("paste", to, cut.store);
  const wordsEntry = lastUndoEntry();
  assert.notEqual(wordsEntry, attachEntry);
  assert.deepEqual(wordsEntry.steps.map((s) => s.key), ["audioText"]);
});
test("pasteIntoCell reports the moved comments of this tab's cut, and none for another tab's", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  const cut = clip("cut", el);
  const foreign = cut.store["text/html"].replace(/data-splitpage-cut="[0-9a-f]+"/, 'data-splitpage-cut="ffff"');
  const other = cellOf("r1", "audioText");
  other.focus();
  selectText(other, 11, 11);
  assert.equal(pasteIntoCell(other, foreign, "bravo charlie", null).movedComments, false);
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  const mine = pasteIntoCell(to, cut.store["text/html"], cut.store["text/plain"], null);
  assert.equal(mine.movedComments, true);
  assert.equal(pasteIntoCell(to, cut.store["text/html"], cut.store["text/plain"], null).movedComments, false, "the cut is spent");
});

test("an attach-only paste leaves its undo entry on the stack by the time pasteIntoCell returns", async () => {
  await open();
  const to = cellOf("r1", "audioText");
  flushEdits();
  const before = lastUndoEntry();
  const res = pasteIntoCell(to, "", "", { attach: [{ kind: "video", href: "https://vimeo.com/1" }] });
  assert.equal(res.done, true);
  assert.notEqual(lastUndoEntry(), before);
  assert.deepEqual(lastUndoEntry().steps.map((s) => s.key), ["imageLinks"]);
});

test("plain text pasted at the end of bold words carries on in bold, as typing does; pasted HTML keeps its own marks", async () => {
  const doc = fixture();
  doc.rows[0].audioText = "Hello <strong>there</strong>";
  await open(doc);
  const to = cellOf("r1", "audioText");
  to.focus();
  selectText(to, 11, 11);
  clip("paste", to, { "text/plain": " again" });
  assert.equal(row("r1").audioText, "Hello <strong>there again</strong>");
  to.focus();
  selectText(to, 17, 17);
  clip("paste", to, { "text/html": "plain", "text/plain": "plain" });
  assert.equal(row("r1").audioText, "Hello <strong>there again</strong>plain");
});
test("a stamp that throws fails a paste or a cut whole: the call throws and the scene, its gallery, the shot list and the counters are as they were", async () => {
  await open();
  const to = cellOf("r4", "visualText");
  to.focus();
  selectAll(to);
  const el = cellOf("r1", "audioText");
  el.focus();
  selectText(el, 0, 6);
  flushEdits();
  const before = JSON.stringify(currentDocument());
  const seq = saveChanges(), generation = session.generation(), entries = undoSizes().undo;
  const real = Date.prototype.toISOString;
  Date.prototype.toISOString = function () { throw new Error("no clock"); };
  try {
    to.focus();
    selectAll(to);
    assert.throws(() => pasteIntoCell(to, KEY("bsA") + " gulls", "x", { attach: [{ kind: "video", href: "https://vimeo.com/1" }] }), /no clock/);
    assert.throws(() => pasteIntoCell(cellOf("r3", "audioText"), "", "", { attach: [{ kind: "video", href: "https://vimeo.com/2" }] }), /no clock/);
    el.focus();
    selectText(el, 0, 6);
    const event = { clipboardData: { setData() {} }, preventDefault() {} };
    assert.throws(() => copyFromCell(event, el, true, false), /no clock/);
  } finally {
    Date.prototype.toISOString = real;
  }
  flushEdits();
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.equal(saveChanges(), seq);
  assert.equal(session.generation(), generation);
  assert.equal(undoSizes().undo, entries);
});

test("a cut whose stamp throws is not armed: pasting what it left on the clipboard brings the words and no second anchor", async () => {
  await open();
  const el = cellOf("r2", "audioText");
  el.focus();
  selectText(el, 6, 19);
  flushEdits();
  const store = {};
  const event = { clipboardData: { setData(type, value) { store[type] = value; } }, preventDefault() {} };
  const real = Date.prototype.toISOString;
  Date.prototype.toISOString = function () { throw new Error("no clock"); };
  try {
    assert.throws(() => copyFromCell(event, el, true, false), /no clock/);
  } finally {
    Date.prototype.toISOString = real;
  }
  assert.match(store["text/html"], /data-splitpage-cut=/);
  const to = cellOf("r3", "audioText");
  to.focus();
  selectText(to, 6, 6);
  const res = pasteIntoCell(to, store["text/html"], store["text/plain"], null);
  assert.equal(res.movedComments, false);
  assert.equal(row("r3").audioText, "Three.bravo charlie");
  assert.equal(row("r2").audioText, "Alpha " + cmt("c1", "bravo charlie") + " delta");
  assert.deepEqual(anchors(), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

function typeChar(el, ch) {
  el.focus();
  const walker = document.createTreeWalker(el, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  last.data += ch;
  const r = document.createRange();
  r.setStart(last, last.data.length);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
}

test("a paste or a cut is never merged into the typing before it or after it, even inside the 1,000 ms window", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  clock += 10;
  typeChar(el, "!");
  flushEdits();
  const typed = undoSizes().undo;
  selectText(el, 12, 12);
  clock += 10;
  clip("paste", el, { "text/plain": "?" });
  flushEdits();
  assert.equal(undoSizes().undo, typed + 1, "the paste is an entry of its own");
  assert.equal(row("r1").audioText, "Hello there!?");
  clock += 10;
  typeChar(cellOf("r1", "audioText"), "#");
  flushEdits();
  assert.equal(undoSizes().undo, typed + 2, "and typing after it starts another");
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there!?");
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there!");
  clock += 10;
  const fresh = cellOf("r1", "audioText");
  selectText(fresh, 0, 5);
  clip("cut", fresh);
  flushEdits();
  assert.equal(undoSizes().undo, typed + 1, "the cut is an entry of its own too");
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there!");
});
test("an attach-only paste right after typing, in the same tick, is an entry of its own", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  clock += 10;
  typeChar(el, "!");
  flushEdits();
  const base = undoSizes().undo;
  clock += 10;
  typeChar(el, "?");
  pasteIntoCell(el, "", "", { attach: [{ kind: "video", href: "https://vimeo.com/1" }] });
  flushEdits();
  assert.equal(undoSizes().undo, base + 1, "the second key joined the first word's entry, the attach is the one new entry");
  assert.deepEqual(lastUndoEntry().steps.map((s) => s.key), ["imageLinks"]);
  assert.equal(undo().ok, true);
  assert.equal(row("r1").audioText, "Hello there!?");
});

test("a paste first takes in what the cell shows but the model has not heard yet", async () => {
  await open();
  const el = cellOf("r1", "audioText");
  el.focus();
  el.firstChild.data = "Hello there+";
  selectText(el, 12, 12);
  clip("paste", el, { "text/plain": "X" });
  assert.equal(row("r1").audioText, "Hello there+X");
});

test("a paste that ends in a tag leaves the caret spot after it, so typing can go on", async () => {
  await open();
  const to = cellOf("r4", "visualText");
  to.focus();
  selectAll(to);
  const tag = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="mug" contenteditable="false">mug</span>';
  clip("paste", to, { "text/html": "a mug: " + tag, "text/plain": "a mug: mug" });
  const last = cellOf("r4", "visualText").lastChild;
  assert.equal(last.nodeType, 3);
  assert.equal(last.data, String.fromCharCode(0x200b));
});
