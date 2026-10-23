import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
const scrolled = [];
window.Element.prototype.scrollIntoView = function () { scrolled.push(this); };
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { undo, undoSizes, flushEdits } = await import("../js/12a-undo.js");
const { currentDocument, liveSession } = await import("../legacy/session-bridge.ts");
const { editorSelection } = await import("../legacy/editor-bridge.ts");
const { setHideShotScenes } = await import("../js/01b-hide-shot.js");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");
const { openDocument } = await import("../legacy/transition-bridge.ts");

after(closeApp);

const realNow = Date.now;
let clock = 9_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

function fixture() {
  return {
    schema: 2,
    title: "Remaining rows",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Sound", status: "shot" },
      { id: "r3", visualText: "Pier", audioText: "Last words", status: "todo" }
    ]
  };
}

let opened = 0;
async function open() {
  if (viewFlags().writerOpen()) writer.closeWriter();
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "remaining-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } });
  flushEdits();
  document.getElementById("toast-host").innerHTML = "";
  scrolled.length = 0;
}

const settle = () => new Promise((r) => setImmediate(r));
const row = (id) => currentDocument().rows.find((r) => r.id === id);
const rowEl = (id) => document.querySelector('#rows .row[data-id="' + id + '"]');
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');
const wrapOf = (cell) => cell.closest(".field-wrap");
const toasts = () => Array.from(document.querySelectorAll("#toast-host .toast"), (t) => t.textContent);

function lastText(el) {
  const walker = document.createTreeWalker(el, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

function select(el, from, to) {
  el.focus();
  const text = lastText(el);
  const r = document.createRange();
  r.setStart(text, from);
  r.setEnd(text, to);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
}

function click(el) {
  assert.ok(el, "the control is on the page");
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}

function key(target, init) {
  const e = new window.KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, init));
  target.dispatchEvent(e);
  return e;
}

function drop(target, data) {
  const e = new window.MouseEvent("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", {
    value: {
      types: data.types || [],
      files: data.files || [],
      getData: (kind) => (kind === "text/html" ? data.html || "" : kind === "text/plain" ? data.text || "" : "")
    }
  });
  target.dispatchEvent(e);
  return e;
}

async function throughSession(gesture) {
  const before = undoSizes();
  const generation = liveSession().generation();
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  try {
    gesture();
    await settle();
  } finally {
    stop();
  }
  assert.equal(seen.length, 1, "one publication for one gesture");
  assert.equal(seen[0].kind, "edit");
  assert.equal(liveSession().generation(), generation + 1, "one generation");
  assert.equal(undoSizes().undo, before.undo + 1, "one undo entry");
  return seen[0].changes;
}

async function nothingWritten(gesture) {
  const before = JSON.stringify(currentDocument());
  const sizes = undoSizes();
  const generation = liveSession().generation();
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  try {
    gesture();
    await settle();
  } finally {
    stop();
  }
  assert.deepEqual(seen, [], "nothing published");
  assert.equal(liveSession().generation(), generation);
  assert.deepEqual(undoSizes(), sizes, "no undo entry");
  assert.equal(JSON.stringify(currentDocument()), before, "the document is unchanged");
}

async function inReview(body) {
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  try {
    await body();
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
  }
}

beforeEach(() => { clock += 10_000; });

test("B03: the toolbar's Bold over a selection is one edit through the session and one undo step", async () => {
  await open();
  const cell = cellOf("r1", "audioText");
  select(cell, 6, 11);
  const changes = await throughSession(() => click(wrapOf(cell).querySelector('.mini-toolbar button[data-cmd="bold"]')));
  assert.equal(changes.whole, false, "the session is told what changed");
  assert.equal(row("r1").audioText, "Hello <strong>there</strong>");
  undo();
  await settle();
  assert.equal(row("r1").audioText, "Hello there");
});

test("S04: Ctrl+B, Ctrl+I and Ctrl+U in a script cell format the selection through the session, one step each", async () => {
  await open();
  select(cellOf("r1", "audioText"), 0, 5);
  await throughSession(() => key(cellOf("r1", "audioText"), { key: "b", ctrlKey: true }));
  assert.equal(row("r1").audioText, "<strong>Hello</strong> there");
  select(cellOf("r3", "audioText"), 5, 10);
  const e = await (async () => { let ev; await throughSession(() => { ev = key(cellOf("r3", "audioText"), { key: "I", ctrlKey: true }); }); return ev; })();
  assert.ok(e.defaultPrevented, "the browser's own formatting is held back");
  assert.equal(row("r3").audioText, "Last <em>words</em>");
  select(cellOf("r3", "visualText"), 0, 4);
  await throughSession(() => key(cellOf("r3", "visualText"), { key: "u", metaKey: true }));
  assert.equal(row("r3").visualText, "<u>Pier</u>");
  await nothingWritten(() => key(cellOf("r1", "visualText"), { key: "k", ctrlKey: true }));
});

test("B04 and B05: a link added by Enter or Add lands as one edit; Escape and Cancel close the box and write nothing", async () => {
  await open();
  const cell = cellOf("r1", "audioText");
  const popover = () => wrapOf(cellOf("r1", "audioText")).querySelector(".link-popover");
  select(cell, 0, 5);
  await nothingWritten(() => click(wrapOf(cell).querySelector('.mini-toolbar button[data-cmd="link"]')));
  assert.equal(popover().hidden, false, "the link box opens");
  popover().querySelector("input").value = "example.com";
  await throughSession(() => key(popover().querySelector("input"), { key: "Enter" }));
  assert.equal(popover().hidden, true);
  assert.match(row("r1").audioText, /^<a href="https:\/\/example\.com"[^>]*>Hello<\/a> there$/);

  select(cellOf("r3", "audioText"), 0, 4);
  click(wrapOf(cellOf("r3", "audioText")).querySelector('.mini-toolbar button[data-cmd="link"]'));
  const box = wrapOf(cellOf("r3", "audioText")).querySelector(".link-popover");
  box.querySelector("input").value = "https://splitpage.test/a";
  await throughSession(() => click(box.querySelector('[data-action="link-confirm"]')));
  assert.match(row("r3").audioText, /^<a href="https:\/\/splitpage\.test\/a"[^>]*>Last<\/a> words$/);

  select(cellOf("r3", "visualText"), 0, 4);
  click(wrapOf(cellOf("r3", "visualText")).querySelector('.mini-toolbar button[data-cmd="link"]'));
  const vbox = wrapOf(cellOf("r3", "visualText")).querySelector(".link-popover");
  vbox.querySelector("input").value = "nowhere.test";
  let esc;
  await nothingWritten(() => { esc = key(vbox.querySelector("input"), { key: "Escape" }); });
  assert.ok(esc.defaultPrevented);
  assert.equal(vbox.hidden, true);
  assert.equal(editorSelection().heldLink(), null, "the saved selection is dropped");
  click(wrapOf(cellOf("r3", "visualText")).querySelector('.mini-toolbar button[data-cmd="link"]'));
  await nothingWritten(() => click(vbox.querySelector('[data-action="link-cancel"]')));
  assert.equal(vbox.hidden, true);
});

test("B44: a scene's status button cycles its status through the session; B45: a review copy's static lamp is refused with a word", async () => {
  await open();
  await throughSession(() => click(rowEl("r1").querySelector('[data-action="cycle-status"]')));
  assert.notEqual(row("r1").status, "todo");
  await inReview(async () => {
    const lamp = rowEl("r3").querySelector(".status-btn.is-static");
    assert.ok(lamp, "a review copy shows a static lamp");
    assert.equal(rowEl("r3").querySelector('[data-action="cycle-status"]'), null);
    await nothingWritten(() => click(lamp));
    assert.equal(toasts().length, 1, "the refusal says why");
  });
});

test("the review gate still refuses a formatting button forced into a review copy's toolbar, with a word", async () => {
  await open();
  await inReview(async () => {
    const cell = cellOf("r1", "audioText");
    const toolbar = wrapOf(cell).querySelector(".mini-toolbar");
    assert.ok(toolbar);
    assert.equal(toolbar.querySelector('[data-cmd="bold"]'), null, "a review copy has no Bold");
    const forced = document.createElement("button");
    forced.setAttribute("data-cmd", "bold");
    toolbar.appendChild(forced);
    select(cell, 0, 5);
    await nothingWritten(() => click(forced));
    assert.equal(toasts().length, 1);
  });
});

test("B46: a hidden-shot strip opens its scenes without an edit", async () => {
  await open();
  setHideShotScenes(true);
  try {
    const strip = document.querySelector('#rows [data-action="expand-hidden-shot"]');
    assert.ok(strip, "the shot scene is folded into a strip");
    assert.equal(rowEl("r2"), null);
    await nothingWritten(() => click(strip));
    assert.ok(rowEl("r2"), "the scene is shown again");
    assert.equal(document.querySelector('#rows [data-action="expand-hidden-shot"]'), null);
  } finally {
    setHideShotScenes(false);
  }
});

test("B47: jump to scene centres and flashes the scene, opening a hidden one first; a scene that is gone says so", async () => {
  await open();
  setHideShotScenes(true);
  const host = document.getElementById("history-panel");
  const jump = (rowId) => {
    const b = document.createElement("button");
    b.setAttribute("data-action", "jump-row");
    b.setAttribute("data-row", rowId);
    host.appendChild(b);
    return b;
  };
  try {
    await nothingWritten(() => click(jump("r2")));
    assert.ok(rowEl("r2"), "the hidden scene is revealed");
    assert.ok(rowEl("r2").classList.contains("just-merged"), "and flashed");
    assert.ok(scrolled.includes(rowEl("r2")), "and scrolled into view");
    await nothingWritten(() => click(jump("no-such-scene")));
    assert.deepEqual(toasts(), ["That scene is no longer here."]);
  } finally {
    host.querySelectorAll('[data-action="jump-row"]').forEach((b) => b.remove());
    setHideShotScenes(false);
  }
});

test("a text drop on a script cell inserts through the session as one edit; a review copy refuses it", async () => {
  await open();
  const cell = cellOf("r3", "audioText");
  select(cell, 10, 10);
  let e;
  await throughSession(() => { e = drop(cell, { types: ["text/plain"], text: " more" }); });
  assert.ok(e.defaultPrevented);
  assert.equal(row("r3").audioText, "Last words more");
  await inReview(async () => {
    select(cellOf("r1", "audioText"), 11, 11);
    await nothingWritten(() => drop(cellOf("r1", "audioText"), { types: ["text/plain"], text: "no" }));
  });
});

test("a file that is not a picture or video dropped on a scene's Image section is refused with a word and writes nothing", async () => {
  await open();
  const media = rowEl("r1").querySelector(".visual-media");
  assert.ok(media);
  let e;
  await nothingWritten(() => {
    e = drop(media, { types: ["Files"], files: [new File(["x"], "notes.txt", { type: "text/plain" })] });
  });
  assert.ok(e.defaultPrevented);
  assert.deepEqual(toasts(), ["Only pictures and video files go in a scene's Image section."]);
});

test("the add-scene bar adds a scene through the session", async () => {
  await open();
  const changes = await throughSession(() => click(document.querySelector('.add-row-bar [data-action="add-row"]')));
  assert.equal(changes.rowsInserted.length, 1);
  assert.equal(currentDocument().rows.length, 4);
});
