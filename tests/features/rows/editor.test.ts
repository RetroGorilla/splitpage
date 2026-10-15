import { test } from "node:test";
import assert from "node:assert/strict";
import { mountRowsEditor } from "../../../src/features/rows/editor.ts";
import type { RowsEditor } from "../../../src/features/rows/editor.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;

const ROUTED: ReadonlySet<string> = new Set(["click", "mousedown", "input", "keydown", "dragover", "dragleave", "drop"]);

function page() {
  const win = jsdomWindow() as unknown as Realm;
  win.document.body.innerHTML = '<div id="rows"><div class="row" data-id="r1">' +
    '<div class="visual-cell" id="visual"><div class="visual-media" id="media"><span id="media-inner"></span></div>' +
    '<div class="cell-editable script" id="vcell" contenteditable="true" data-id="r1" data-field="visualText"></div></div>' +
    '<div class="cell-editable script" id="acell" contenteditable="true" data-id="r1" data-field="audioText"></div>' +
    '<div class="cell-editable" id="draft" contenteditable="true"></div><span id="grip"></span></div></div>' +
    '<div class="add-row-bar" id="bar"><button data-action="add-row" id="add"></button></div><div id="other"></div>';
  const byId = (id: string): HTMLElement => win.document.getElementById(id) as HTMLElement;
  return { win, doc: win.document, byId };
}

interface Drag {
  readonly types?: readonly string[];
  readonly files?: readonly File[];
  readonly html?: string;
  readonly text?: string;
}

function dragEvent(win: Realm, type: string, drag: Drag | null, init: MouseEventInit = {}): Event {
  const e = new win.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init));
  const data = drag ? {
    types: drag.types || [],
    files: drag.files || [],
    dropEffect: "none",
    getData: (kind: string): string => (kind === "text/html" ? drag.html || "" : kind === "text/plain" ? drag.text || "" : "")
  } : null;
  Object.defineProperty(e, "dataTransfer", { value: data });
  return e;
}

function counted(target: EventTarget) {
  const tally = { added: [] as string[], removed: [] as string[] };
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => { if (ROUTED.has(type)) tally.added.push(type); add(type, fn, opts); };
  target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => { if (ROUTED.has(type)) tally.removed.push(type); remove(type, fn, opts); };
  return tally;
}

function harness(p: ReturnType<typeof page>) {
  const state = { dragging: false, review: false, rowOver: false, rowDrop: false };
  const calls: string[] = [];
  const name = (el: EventTarget | null): string => (el && "id" in el ? (el as Element).id : "?");
  const mount = (): RowsEditor => mountRowsEditor({
    window: p.win,
    rows: p.byId("rows"),
    addBar: p.byId("bar"),
    ports: {
      click: (e) => { calls.push("click:" + name(e.target)); },
      mousedown: (e) => { calls.push("mousedown:" + name(e.target)); },
      input: (e) => { calls.push("input:" + name(e.target)); },
      keydown: (e) => { calls.push("keydown:" + name(e.target)); },
      rowDragging: () => state.dragging,
      rowDragOver: () => { calls.push("rowOver"); return state.rowOver; },
      rowDrop: () => { calls.push("rowDrop"); return state.rowDrop; },
      scriptCell: (cell) => cell.classList.contains("script"),
      reviewOnly: () => state.review,
      hasMedia: (files) => !!files && Array.prototype.some.call(files, (f: File) => /^(image|video)\//.test(f.type)),
      insert: (cell, html, text, files) => { calls.push("insert:" + cell.id + ":" + html + ":" + text + ":" + (files ? files.length : 0)); },
      notMedia: () => { calls.push("notMedia"); }
    }
  });
  return { state, calls, mount };
}

const picture = (win: Realm): File => new win.File(["x"], "a.png", { type: "image/png" });
const textFile = (win: Realm): File => new win.File(["x"], "a.txt", { type: "text/plain" });

test("rows editor: click, mousedown, input and keydown on the script's rows and the add-row bar reach the shared routes", () => {
  const p = page();
  const h = harness(p);
  const editor = h.mount();
  p.byId("acell").dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
  p.byId("add").dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
  p.byId("grip").dispatchEvent(new p.win.MouseEvent("mousedown", { bubbles: true }));
  p.byId("acell").dispatchEvent(new p.win.Event("input", { bubbles: true }));
  p.byId("acell").dispatchEvent(new p.win.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  p.byId("other").dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(h.calls, ["click:acell", "click:add", "mousedown:grip", "input:acell", "keydown:acell"]);
  editor.dispose();
});

test("rows editor: a picture dragged over a scene's Image section marks that section and takes a copy", () => {
  const p = page();
  const h = harness(p);
  const editor = h.mount();
  const e = dragEvent(p.win, "dragover", { types: ["Files"], files: [picture(p.win)] });
  p.byId("media-inner").dispatchEvent(e);
  assert.ok(e.defaultPrevented);
  assert.ok(p.byId("visual").classList.contains("drag-over"));
  assert.deepEqual(h.calls, [], "the scene move is not asked");
  const leave = dragEvent(p.win, "dragleave", null, { relatedTarget: p.byId("vcell") });
  p.byId("media").dispatchEvent(leave);
  assert.ok(p.byId("visual").classList.contains("drag-over"), "moving inside the section keeps the mark");
  p.byId("media").dispatchEvent(dragEvent(p.win, "dragleave", null, { relatedTarget: p.byId("other") }));
  assert.ok(!p.byId("visual").classList.contains("drag-over"), "leaving the section clears it");
  editor.dispose();
});

test("rows editor: while a scene drags, a file drag is not a media drop; the scene move is asked before the editable", () => {
  const p = page();
  const h = harness(p);
  const editor = h.mount();
  h.state.dragging = true;
  h.state.rowOver = true;
  const over = dragEvent(p.win, "dragover", { types: ["Files"] });
  p.byId("media-inner").dispatchEvent(over);
  assert.ok(!p.byId("visual").classList.contains("drag-over"));
  assert.ok(!over.defaultPrevented, "the scene move route decided, and it did not prevent here");
  h.state.dragging = false;
  h.state.rowOver = false;
  const text = dragEvent(p.win, "dragover", { types: ["text/plain"] });
  p.byId("acell").dispatchEvent(text);
  assert.ok(text.defaultPrevented, "an editable takes a copy");
  const outside = dragEvent(p.win, "dragover", { types: ["text/plain"] });
  p.byId("grip").dispatchEvent(outside);
  assert.ok(!outside.defaultPrevented);
  assert.deepEqual(h.calls, ["rowOver", "rowOver", "rowOver"]);
  editor.dispose();
});

test("rows editor: a media file dropped on the Image section goes into the scene's Visual cell; a review copy takes nothing", () => {
  const p = page();
  const h = harness(p);
  const editor = h.mount();
  p.byId("visual").classList.add("drag-over");
  const drop = dragEvent(p.win, "drop", { types: ["Files"], files: [picture(p.win)] });
  p.byId("media-inner").dispatchEvent(drop);
  assert.ok(drop.defaultPrevented);
  assert.ok(!p.byId("visual").classList.contains("drag-over"));
  h.state.review = true;
  const refused = dragEvent(p.win, "drop", { types: ["Files"], files: [picture(p.win)] });
  p.byId("media").dispatchEvent(refused);
  assert.ok(refused.defaultPrevented);
  assert.deepEqual(h.calls, ["insert:vcell:::1"]);
  editor.dispose();
});

test("rows editor: a file that is not a picture or video dropped on the Image section is refused with a word", () => {
  const p = page();
  const h = harness(p);
  const editor = h.mount();
  const drop = dragEvent(p.win, "drop", { types: ["Files"], files: [textFile(p.win)] });
  p.byId("media").dispatchEvent(drop);
  assert.ok(drop.defaultPrevented);
  const empty = dragEvent(p.win, "drop", { types: ["Files"], files: [] });
  p.byId("media").dispatchEvent(empty);
  assert.deepEqual(h.calls, ["notMedia"], "no word when nothing was dropped");
  editor.dispose();
});

test("rows editor: a drop on a script cell inserts there after the scene move declines; review and empty drops do nothing", () => {
  const p = page();
  const h = harness(p);
  const editor = h.mount();
  const drop = dragEvent(p.win, "drop", { types: ["text/html"], html: "<b>hi</b>", text: "hi" });
  p.byId("acell").dispatchEvent(drop);
  assert.ok(drop.defaultPrevented);
  assert.equal(p.doc.activeElement, p.byId("acell"), "the cell takes the focus");
  const empty = dragEvent(p.win, "drop", { types: [] });
  p.byId("acell").dispatchEvent(empty);
  assert.ok(empty.defaultPrevented, "an empty drop on a cell is still taken");
  h.state.review = true;
  p.byId("acell").dispatchEvent(dragEvent(p.win, "drop", { types: ["text/plain"], text: "no" }));
  h.state.review = false;
  p.byId("draft").dispatchEvent(dragEvent(p.win, "drop", { types: ["text/plain"], text: "draft" }));
  assert.equal(p.doc.activeElement, p.byId("draft"), "an editable that is not a script cell takes the focus, and nothing more");
  h.state.rowDrop = true;
  p.byId("acell").dispatchEvent(dragEvent(p.win, "drop", { types: ["text/plain"], text: "moved" }));
  assert.deepEqual(h.calls, ["rowDrop", "insert:acell:<b>hi</b>:hi:0", "rowDrop", "rowDrop", "rowDrop", "rowDrop"]);
  editor.dispose();
});

test("rows editor: dispose removes all eight registrations and stops every route; a remount has one of each", () => {
  const p = page();
  const rows = counted(p.byId("rows"));
  const bar = counted(p.byId("bar"));
  const h = harness(p);
  const first = h.mount();
  assert.deepEqual(rows.added, ["click", "mousedown", "input", "keydown", "dragover", "dragleave", "drop"]);
  assert.deepEqual(bar.added, ["click"]);
  first.dispose();
  first.dispose();
  assert.deepEqual(rows.removed, rows.added, "symmetric, and a second dispose does nothing");
  assert.deepEqual(bar.removed, ["click"]);
  p.byId("add").dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
  p.byId("acell").dispatchEvent(dragEvent(p.win, "drop", { types: ["text/plain"], text: "x" }));
  assert.deepEqual(h.calls, [], "nothing reacts after dispose");
  const second = h.mount();
  p.byId("add").dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(h.calls, ["click:add"], "the remount handles one click once");
  second.dispose();
});
