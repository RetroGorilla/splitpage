import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { cloneState } from "../core/document/clone.ts";
import { saveChanges, unsavedChanges } from "../legacy/save-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { applyMerge } = await import("../js/03-sync.js");
const { paintingScreen, renderAbsorbed, renderRow } = await import("../js/05-render.js");
const { paintGuard } = await import("../legacy/editor-bridge.ts");
const whilePainting = (paint) => paintGuard().whilePainting(paint);
const afterThisPaint = (work) => paintGuard().afterThisPaint(work);
const { setHideShotScenes } = await import("../js/01b-hide-shot.js");
const { runBrollRefresh, closeBrollPage, openBrollPage, openBrollPanel } = await import("../js/08d-broll-panel.js");
const { sidePanels } = await import("../legacy/panels-bridge.ts");
const { flushEdits, undoSizes } = await import("../js/12a-undo.js");
const { clearDirty } = await import("../js/12-dirty-toast.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const realNow = Date.now;
let clock = 5_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const session = liveSession();
const published = [];
const publishedWhilePainting = [];
session.subscribe((c) => { published.push(c.kind); publishedWhilePainting.push(paintingScreen()); });

const REDRAW = "Could not redraw the script after the update. Nothing was lost — press Redraw before you keep editing.";

function fixture(title) {
  return {
    schema: 2,
    title: title,
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Mine one.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Mine two.", status: "ready" },
      { id: "r3", visualText: "", audioText: "Mine three.", status: "todo" }
    ]
  };
}

function fresh(title, build = fixture) {
  if (viewFlags().writerOpen()) writer.closeWriter();
  window.__hostedTest.setSession({ role: "edit", docId: null });
  clock += 10_000;
  loadTestDocument(migrateRows(build(title)));
  flushEdits();
  renderAbsorbed();
  clearDirty();
  document.getElementById("toast-host").textContent = "";
  return S.state;
}

const para = (id) => document.querySelector('#writer-doc .wr-para[data-id="' + id + '"]');
const gridCell = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + (field || "audioText") + '"]');
const audio = (id) => S.state.rows.find((r) => r.id === id).audioText;

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

function caretAt(el, offset) {
  el.focus();
  const [node, at] = textNodeAt(el, offset);
  const r = document.createRange();
  r.setStart(node, at);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function caretOffset(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) return null;
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return probe.toString().length;
}

const removals = [];

function chromiumRemoval(run) {
  const proto = window.Element.prototype;
  const nodeProto = window.Node.prototype;
  const inner = Object.getOwnPropertyDescriptor(proto, "innerHTML");
  const replaceChild = nodeProto.replaceChild;
  const removeChild = nodeProto.removeChild;
  function leaving(subtree) {
    const active = document.activeElement;
    if (!active || active === document.body || !subtree || !subtree.contains || !subtree.contains(active)) return;
    removals.push({ id: active.getAttribute && active.getAttribute("data-id"), connected: active.isConnected, text: active.textContent });
    active.dispatchEvent(new window.FocusEvent("blur"));
    active.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  }
  Object.defineProperty(proto, "innerHTML", {
    configurable: true,
    get() { return inner.get.call(this); },
    set(value) {
      const active = document.activeElement;
      if (active && active !== this && this.contains(active)) leaving(this);
      inner.set.call(this, value);
    }
  });
  nodeProto.replaceChild = function (fresh, old) { leaving(old); return replaceChild.call(this, fresh, old); };
  nodeProto.removeChild = function (child) { leaving(child); return removeChild.call(this, child); };
  removals.length = 0;
  try {
    return run();
  } finally {
    Object.defineProperty(proto, "innerHTML", inner);
    nodeProto.replaceChild = replaceChild;
    nodeProto.removeChild = removeChild;
  }
}

function observe(run) {
  flushEdits();
  const seq = saveChanges(), generation = session.generation(), sizes = undoSizes();
  published.length = 0;
  publishedWhilePainting.length = 0;
  const value = chromiumRemoval(run);
  flushEdits();
  return {
    value: value,
    edits: published.filter((k) => k === "edit").length,
    seq: saveChanges() - seq,
    generation: session.generation() - generation,
    undo: undoSizes().undo - sizes.undo
  };
}

const NO_EDIT = { edits: 0, seq: 0, generation: 0, undo: 0 };
const noEdit = (got) => ({ edits: got.edits, seq: got.seq, generation: got.generation, undo: got.undo });

function merge(theirs) {
  return applyMerge({ theirs: theirs, source: "server-conflict", unchanged: true, report: false });
}

test("an update drawn while a Writer paragraph has focus keeps the incoming text, makes no edit and leaves the caret where it was in the Writer (#477)", () => {
  const doc = fresh("Writer focus");
  writer.openWriter();
  caretAt(para("r2"), 4);
  const theirs = cloneState(doc);
  theirs.rows[0].audioText = "Theirs one.";
  theirs.rows[1].audioText = "Theirs two.";
  const got = observe(() => merge(theirs));
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r1"), "Theirs one.");
  assert.equal(audio("r2"), "Theirs two.");
  assert.equal(unsavedChanges(), false);
  assert.ok(removals.some((r) => r.id === "r2" && r.text === "Mine two."), "the old paragraph lost focus while it held the old text");
  const active = document.activeElement;
  assert.equal(active, para("r2"), "the focus stays in the Writer, on the same scene");
  assert.equal(active.textContent, "Theirs two.");
  assert.equal(caretOffset(active), "Theirs".length, "the caret at the end of the replaced word maps to the end of its replacement (#464)");
  assert.equal(gridCell("r2").textContent, "Theirs two.");
  writer.closeWriter();
});

test("an update drawn while a grid cell has focus keeps the incoming text in that cell, makes no edit and keeps the focus on the redrawn cell (#477)", () => {
  const doc = fresh("Grid focus");
  caretAt(gridCell("r1"), 3);
  const theirs = cloneState(doc);
  theirs.rows[0].audioText = "Theirs one, longer.";
  const got = observe(() => merge(theirs));
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r1"), "Theirs one, longer.");
  assert.equal(unsavedChanges(), false);
  assert.ok(removals.some((r) => r.id === "r1" && r.connected && r.text === "Mine one."), "the old cell lost focus while it held the old text");
  const active = document.activeElement;
  assert.equal(active, gridCell("r1"));
  assert.equal(active.textContent, "Theirs one, longer.");
  assert.equal(caretOffset(active), "Theirs".length, "the caret inside the replaced word maps to that word's place (#464)");
});

test("an update that removes the focused scene makes no edit, in the grid and in the Writer (#477)", () => {
  const doc = fresh("Removed in grid");
  caretAt(gridCell("r2"), 2);
  const theirs = cloneState(doc);
  theirs.rows.splice(1, 1);
  theirs.rows[0].audioText = "Theirs one.";
  assert.deepEqual(noEdit(observe(() => merge(theirs))), NO_EDIT);
  assert.deepEqual(S.state.rows.map((r) => r.id), ["r1", "r3"]);
  assert.equal(audio("r1"), "Theirs one.");
  assert.equal(gridCell("r2"), null);

  const doc2 = fresh("Removed in Writer");
  writer.openWriter();
  caretAt(para("r2"), 2);
  const theirs2 = cloneState(doc2);
  theirs2.rows.splice(1, 1);
  theirs2.rows[1].audioText = "Theirs three.";
  assert.deepEqual(noEdit(observe(() => merge(theirs2))), NO_EDIT);
  assert.deepEqual(S.state.rows.map((r) => r.id), ["r1", "r3"]);
  assert.equal(audio("r3"), "Theirs three.");
  assert.equal(para("r2"), null);
  assert.ok(!document.activeElement.closest("#rows"), "the focus is not moved into the hidden grid");
  writer.closeWriter();
});

test("a Writer redraw on its own does not write the focused paragraph's old text over the model (#477)", () => {
  fresh("Writer redraw");
  writer.openWriter();
  caretAt(para("r1"), 2);
  S.state.rows[0].audioText = "Changed under the Writer.";
  const got = observe(() => writer.renderWriter());
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r1"), "Changed under the Writer.");
  assert.equal(document.activeElement, para("r1"));
  assert.equal(para("r1").textContent, "Changed under the Writer.");
  writer.closeWriter();
});

test("a single-row redraw does not write the focused cell's old text over the model (#477)", () => {
  fresh("Row redraw");
  caretAt(gridCell("r2"), 2);
  S.state.rows[1].audioText = "Changed under the cell.";
  const got = observe(() => renderRow("r2"));
  assert.equal(got.value, true);
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r2"), "Changed under the cell.");
  assert.equal(gridCell("r2").textContent, "Changed under the cell.");
});

test("a render that throws between the grid and the Writer makes no edit, and typing after Redraw is saved again (#477)", () => {
  const doc = fresh("Throw mid-render");
  writer.openWriter();
  caretAt(para("r2"), 3);
  const theirs = cloneState(doc);
  theirs.rows[1].audioText = "Theirs two.";
  const box = document.getElementById("doc-title");
  const real = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  Object.defineProperty(box, "value", { configurable: true, get() { return real.get.call(this); }, set() { throw new Error("render broke (#477)"); } });
  const consoles = [...new Set([window.console, globalThis.console])];
  const was = consoles.map((c) => c.error);
  const logged = [];
  consoles.forEach((c) => { c.error = (e) => { logged.push((e && e.message) || String(e)); process.stderr.write("STACK " + (e && e.stack) + "\n"); }; });
  let got;
  try {
    got = observe(() => merge(theirs));
  } finally {
    delete box.value;
    consoles.forEach((c, i) => { c.error = was[i]; });
  }
  assert.deepEqual(logged, ["render broke (#477)"]);
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r2"), "Theirs two.");
  const toast = Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)"))
    .find((el) => el.firstChild && el.firstChild.nodeValue === REDRAW);
  assert.ok(toast, "the redraw toast is offered");
  toast.querySelector(".toast-action").click();
  assert.equal(para("r2").textContent, "Theirs two.");
  const p = para("r2");
  caretAt(p, "Theirs two.".length);
  const typed = observe(() => {
    const [node] = textNodeAt(p, "Theirs two.".length);
    node.data += "!";
    caretAt(p, "Theirs two.!".length);
    p.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "!" }));
  });
  assert.equal(typed.edits, 1, "typing after the redraw is an edit again");
  assert.equal(audio("r2"), "Theirs two.!");
  const blurred = observe(() => {
    const [node] = textNodeAt(p, "Theirs two.!".length);
    node.data += "?";
    p.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });
  assert.equal(blurred.edits, 1, "a focusout after the redraw saves the cell again");
  assert.equal(audio("r2"), "Theirs two.!?");
  writer.closeWriter();
});

test("a paint nested in another ends without ending the outer one: a focusout the outer paint causes after it writes nothing (#495)", () => {
  fresh("Nested paint");
  caretAt(gridCell("r2"), 2);
  const got = observe(() => whilePainting(() => {
    assert.equal(renderRow("r2"), true);
    assert.equal(paintingScreen(), true, "the outer paint is still running");
    const cell = gridCell("r2");
    textNodeAt(cell, 0)[0].data = "Stale under the outer paint.";
    cell.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  }));
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(audio("r2"), "Mine two.");
  assert.equal(paintingScreen(), false);
  textNodeAt(gridCell("r2"), 0)[0].data = "Mine two.";
});

test("work queued during a nested paint runs once, after the outermost paint ends; with no paint it runs at once; after a paint that throws it waits for the next paint that finishes (#485)", () => {
  const ran = [];
  whilePainting(() => {
    whilePainting(() => afterThisPaint(() => ran.push("queued")));
    ran.push("outer");
  });
  assert.deepEqual(ran, ["outer", "queued"]);
  afterThisPaint(() => ran.push("now"));
  assert.deepEqual(ran, ["outer", "queued", "now"]);
  assert.throws(() => whilePainting(() => {
    afterThisPaint(() => ran.push("kept"));
    throw new Error("paint broke (#485)");
  }), /paint broke/);
  assert.deepEqual(ran, ["outer", "queued", "now"]);
  whilePainting(() => {});
  assert.deepEqual(ran, ["outer", "queued", "now", "kept"]);
  whilePainting(() => {});
  assert.deepEqual(ran, ["outer", "queued", "now", "kept"]);
});

function withShot(title) {
  const doc = fixture(title);
  doc.brollShots = [{ id: "bs1", name: "Harbour wide", origin: "list", notes: "Mine note.", audioRef: "Mine line.", location: "Mine quay" }];
  return doc;
}

const panelEl = () => document.getElementById("broll-panel");
const shotBox = (cls) => panelEl().querySelector("." + cls + '[data-id="bs1"]');
const shot = () => S.state.brollShots.find((b) => b.id === "bs1");

const PANEL_FIELDS = [
  { name: "note", key: "notes", cls: "broll-notes-input" },
  { name: "reference", key: "audioRef", cls: "broll-ref-input", open: "broll-ref-edit" },
  { name: "location", key: "location", cls: "broll-loc-input", open: "broll-loc-edit" }
];

function focusShotField(title, f) {
  const doc = fresh(title, withShot);
  openBrollPanel();
  if (!panelEl().querySelector('.broll-card[data-id="bs1"]')) panelEl().querySelector('.broll-row-main[data-id="bs1"]').click();
  if (f.open) panelEl().querySelector('[data-action="' + f.open + '"][data-id="bs1"]').click();
  clearDirty();
  const box = shotBox(f.cls);
  box.focus();
  assert.equal(document.activeElement, box);
  assert.equal(box.value, shot()[f.key]);
  return doc;
}

function typeInto(box, value) {
  box.value = value;
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

function theirsFor(doc, key, value) {
  const theirs = cloneState(doc);
  theirs.brollShots[0][key] = value;
  return theirs;
}

function leavePanel() {
  const active = document.activeElement;
  if (active && active !== document.body) active.blur();
  sidePanels().close("broll-panel");
}

for (const f of PANEL_FIELDS) {
  test("an update redrawn while the b-roll " + f.name + " box has focus, untouched, keeps the incoming " + f.name + " and makes no edit; a blur afterwards writes nothing (#485)", () => {
    try {
      const doc = focusShotField("Panel " + f.name, f);
      const got = observe(() => {
        merge(theirsFor(doc, f.key, "Theirs " + f.name + "."));
        runBrollRefresh();
      });
      assert.ok(removals.some((r) => r.id === "bs1"), "the redraw took the focused box away");
      assert.deepEqual(noEdit(got), NO_EDIT);
      assert.equal(shot()[f.key], "Theirs " + f.name + ".");
      assert.equal(unsavedChanges(), false);
      assert.equal(document.activeElement, shotBox(f.cls), "the redrawn box has the focus");
      observe(() => runBrollRefresh());
      const box = shotBox(f.cls);
      assert.equal(document.activeElement, box, "the box is still open and focused after the next redraw");
      assert.equal(box.value, "Theirs " + f.name + ".");
      const blurred = observe(() => box.blur());
      assert.deepEqual(noEdit(blurred), NO_EDIT);
      assert.equal(shot()[f.key], "Theirs " + f.name + ".");
      assert.equal(unsavedChanges(), false);
      if (f.open) assert.equal(shotBox(f.cls), null, "a blur closes the " + f.name + " editor");
    } finally {
      leavePanel();
    }
  });

  test("a blur from the untouched b-roll " + f.name + " box after an update changed that field, before the panel redraws, writes nothing (#485)", () => {
    try {
      const doc = focusShotField("Panel blur " + f.name, f);
      const box = shotBox(f.cls);
      const got = observe(() => {
        merge(theirsFor(doc, f.key, "Theirs " + f.name + "."));
        box.blur();
      });
      assert.deepEqual(noEdit(got), NO_EDIT);
      assert.equal(shot()[f.key], "Theirs " + f.name + ".");
      assert.equal(unsavedChanges(), false);
    } finally {
      leavePanel();
    }
  });

  test("typing in the b-roll " + f.name + " box is saved before a redraw replaces the box, over an incoming change to the same field, and the redrawn box keeps the typing and the focus (#485)", () => {
    try {
      const doc = focusShotField("Panel typed " + f.name, f);
      typeInto(shotBox(f.cls), "Typed " + f.name + ".");
      observe(() => {
        merge(theirsFor(doc, f.key, "Theirs " + f.name + "."));
        runBrollRefresh();
      });
      assert.equal(shot()[f.key], "Typed " + f.name + ".");
      assert.equal(unsavedChanges(), true);
      observe(() => runBrollRefresh());
      const box = shotBox(f.cls);
      assert.equal(document.activeElement, box, "the box is still open and focused after the next redraw");
      assert.equal(box.value, "Typed " + f.name + ".");
      const blurred = observe(() => box.blur());
      assert.deepEqual(noEdit(blurred), NO_EDIT, "the blur has nothing left to save");
      assert.equal(shot()[f.key], "Typed " + f.name + ".");
    } finally {
      leavePanel();
    }
  });

  test("typing in the b-roll " + f.name + " box that a redraw already saved is not written back over a later incoming change by the next redraw (#510)", () => {
    try {
      focusShotField("Panel saved " + f.name, f);
      typeInto(shotBox(f.cls), "Typed " + f.name + ".");
      observe(() => runBrollRefresh());
      assert.equal(shot()[f.key], "Typed " + f.name + ".");
      assert.equal(document.activeElement, shotBox(f.cls));
      clearDirty();
      const got = observe(() => {
        merge(theirsFor(S.state, f.key, "Theirs later " + f.name + "."));
        runBrollRefresh();
      });
      assert.deepEqual([got.edits, got.seq], [0, 0]);
      assert.equal(shot()[f.key], "Theirs later " + f.name + ".");
      assert.equal(unsavedChanges(), false);
      assert.equal(shotBox(f.cls).value, "Theirs later " + f.name + ".");
    } finally {
      leavePanel();
    }
  });
}

const NORMALISED = [
  { name: "a leading line break", text: "\nLead", fields: ["note", "reference", "page note"] },
  { name: "markup", text: "a<b>c", fields: ["note", "reference", "location", "page note"] },
  { name: "a control character", text: "a" + String.fromCharCode(1) + "b", fields: ["page note"] },
  { name: "text over the cap", text: "x".repeat(2005), fields: ["page note"] }
];

for (const n of NORMALISED) {
  for (const f of PANEL_FIELDS.filter((p) => n.fields.includes(p.name))) {
    test("typing " + n.name + " in the b-roll " + f.name + " box that a redraw already saved is not written back over a later incoming change (#510)", () => {
      try {
        focusShotField("Panel normalised " + f.name, f);
        typeInto(shotBox(f.cls), n.text);
        observe(() => runBrollRefresh());
        const saved = shot()[f.key];
        assert.notEqual(saved, undefined);
        clearDirty();
        const got = observe(() => {
          merge(theirsFor(S.state, f.key, "Theirs."));
          runBrollRefresh();
        });
        assert.deepEqual([got.edits, got.seq], [0, 0]);
        assert.equal(shot()[f.key], "Theirs.");
        assert.equal(unsavedChanges(), false);
      } finally {
        leavePanel();
      }
    });
  }
}

const pageEl = () => document.getElementById("broll-page");
const pageBox = () => pageEl().querySelector('.broll-page-note[data-id="bs1"]');

function focusPageNote(title, note) {
  const doc = fresh(title, (t) => {
    const d = withShot(t);
    d.brollShots[0].notes = note;
    return d;
  });
  openBrollPage();
  clearDirty();
  const box = pageBox();
  assert.equal(box.tagName, "TEXTAREA");
  box.focus();
  assert.equal(document.activeElement, box);
  return doc;
}

function leavePage() {
  const active = document.activeElement;
  if (active && active !== document.body) active.blur();
  closeBrollPage();
}

test("typing in the b-roll page note box that a redraw already saved is not written back over a later incoming change by the next redraw (#510)", () => {
  try {
    focusPageNote("Page saved", "Mine note.");
    typeInto(pageBox(), "Typed note.");
    observe(() => runBrollRefresh());
    assert.equal(shot().notes, "Typed note.");
    assert.equal(document.activeElement, pageBox());
    clearDirty();
    const got = observe(() => {
      merge(theirsFor(S.state, "notes", "Theirs later."));
      runBrollRefresh();
    });
    assert.deepEqual([got.edits, got.seq], [0, 0]);
    assert.equal(shot().notes, "Theirs later.");
    assert.equal(unsavedChanges(), false);
    assert.equal(pageBox().value, "Theirs later.");
  } finally {
    leavePage();
  }
});

for (const n of NORMALISED.filter((v) => v.fields.includes("page note"))) {
  test("typing " + n.name + " in the b-roll page note box that a redraw already saved is not written back over a later incoming change (#510)", () => {
    try {
      focusPageNote("Page normalised", "Mine note.");
      typeInto(pageBox(), n.text);
      observe(() => runBrollRefresh());
      clearDirty();
      const got = observe(() => {
        merge(theirsFor(S.state, "notes", "Theirs."));
        runBrollRefresh();
      });
      assert.deepEqual([got.edits, got.seq], [0, 0]);
      assert.equal(shot().notes, "Theirs.");
      assert.equal(unsavedChanges(), false);
    } finally {
      leavePage();
    }
  });
}

test("an update redrawn while an untouched b-roll page note box with a line break has focus keeps the incoming note and makes no edit (#511)", () => {
  try {
    const doc = focusPageNote("Page multi untouched", "Line one\nLine two");
    assert.equal(pageBox().value, "Line one\nLine two");
    const got = observe(() => {
      merge(theirsFor(doc, "notes", "Theirs note."));
      runBrollRefresh();
    });
    assert.deepEqual(noEdit(got), NO_EDIT);
    assert.equal(shot().notes, "Theirs note.");
    assert.equal(unsavedChanges(), false);
    assert.equal(pageBox().value, "Theirs note.");
  } finally {
    leavePage();
  }
});

test("a blur from the untouched b-roll page note box keeps the line breaks of a multi-line note and makes no edit (#512)", () => {
  try {
    focusPageNote("Page multi blur", "Line one\nLine two");
    const got = observe(() => pageBox().blur());
    assert.deepEqual(noEdit(got), NO_EDIT);
    assert.equal(shot().notes, "Line one\nLine two");
    assert.equal(unsavedChanges(), false);
    assert.equal(pageBox().value, "Line one\nLine two");
  } finally {
    leavePage();
  }
});

test("typing in the b-roll page note box keeps its line breaks on blur (#512)", () => {
  try {
    focusPageNote("Page multi typed", "Mine note.");
    typeInto(pageBox(), "Typed one\nTyped two");
    observe(() => pageBox().blur());
    assert.equal(shot().notes, "Typed one\nTyped two");
  } finally {
    leavePage();
  }
});

test("typing in the b-roll note box is saved when an update takes the shot out of the filtered list, before the box goes (#485)", () => {
  try {
    const doc = focusShotField("Panel filtered", PANEL_FIELDS[0]);
    panelEl().querySelector('[data-action="broll-filter"][data-filter="unshot"]').click();
    assert.equal(document.activeElement, shotBox("broll-notes-input"));
    typeInto(shotBox("broll-notes-input"), "Typed before it went.");
    observe(() => {
      merge(theirsFor(doc, "status", "shot"));
      runBrollRefresh();
    });
    assert.equal(shotBox("broll-notes-input"), null, "the shot left the list");
    assert.equal(shot().status, "shot");
    assert.equal(shot().notes, "Typed before it went.");
  } finally {
    panelEl().querySelector('[data-action="broll-filter"][data-filter="all"]').click();
    leavePanel();
  }
});

const lengthBox = () => document.querySelector("#rows .row-read-input");
const lengthOf = (id) => S.state.rows.find((r) => r.id === id).lengthSeconds;

function openLength(id) {
  document.querySelector('#rows .row[data-id="' + id + '"] .row-read').dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const box = lengthBox();
  assert.ok(box, "the length editor is open");
  assert.equal(document.activeElement, box);
  return box;
}

function hidingShotScenes(run) {
  setHideShotScenes(true);
  try {
    return run();
  } finally {
    setHideShotScenes(false);
  }
}

const editsWhilePainting = () => published.map((k, i) => [k, publishedWhilePainting[i]]).filter((p) => p[0] === "edit").map((p) => p[1]);

test("a length typed into the scene-length editor is set after a redraw that removes the editor, not from inside it, and the incoming change is kept too (#485)", () => hidingShotScenes(() => {
  const doc = fresh("Length typed");
  openLength("r1").value = "2:00";
  const theirs = cloneState(doc);
  theirs.rows[0].status = "shot";
  const got = observe(() => merge(theirs));
  assert.equal(lengthBox(), null, "the redraw took the editor away");
  assert.ok(removals.length > 0, "the editor lost focus during the redraw");
  assert.equal(S.state.rows[0].status, "shot");
  assert.equal(lengthOf("r1"), 120);
  assert.equal(got.edits, 1);
  assert.deepEqual(editsWhilePainting(), [false], "the length is set with no paint running");
}));

test("an untouched scene-length editor that a redraw removes sets nothing and keeps the incoming length (#485)", () => hidingShotScenes(() => {
  const doc = fresh("Length untouched");
  openLength("r1");
  const theirs = cloneState(doc);
  theirs.rows[0].status = "shot";
  theirs.rows[0].lengthSeconds = 45;
  const got = observe(() => merge(theirs));
  assert.equal(lengthBox(), null);
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.equal(lengthOf("r1"), 45);
}));

test("a length typed into an editor that a failing redraw removed is set in the document once that redraw has failed, so a save keeps it, and Redraw then sets nothing more (#485, #514)", () => hidingShotScenes(() => {
  const doc = fresh("Length failed");
  openLength("r1").value = "2:00";
  const theirs = cloneState(doc);
  theirs.rows[0].status = "shot";
  const box = document.getElementById("doc-title");
  const real = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  Object.defineProperty(box, "value", { configurable: true, get() { return real.get.call(this); }, set() { throw new Error("render broke (#485)"); } });
  const consoles = [...new Set([window.console, globalThis.console])];
  const was = consoles.map((c) => c.error);
  const logged = [];
  consoles.forEach((c) => { c.error = (e) => { logged.push((e && e.message) || String(e)); }; });
  let got;
  try {
    got = observe(() => merge(theirs));
  } finally {
    delete box.value;
    consoles.forEach((c, i) => { c.error = was[i]; });
  }
  assert.deepEqual(logged, ["render broke (#485)"]);
  assert.ok(removals.length > 0, "the editor was removed before the redraw failed");
  assert.equal(got.edits, 1);
  assert.equal(lengthOf("r1"), 120);
  assert.equal(unsavedChanges(), true);
  assert.deepEqual(editsWhilePainting(), [false], "the length is set with no paint running");
  const toast = Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)"))
    .find((el) => el.firstChild && el.firstChild.nodeValue === REDRAW);
  assert.ok(toast, "the redraw toast is offered");
  const redrawn = observe(() => toast.querySelector(".toast-action").click());
  assert.deepEqual(noEdit(redrawn), NO_EDIT);
  assert.equal(lengthOf("r1"), 120);
  assert.equal(S.state.rows[0].status, "shot");
}));
