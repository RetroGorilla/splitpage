import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { cloneState } from "../core/document/clone.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { applyMerge } = await import("../js/03-sync.js");
const { render, renderAbsorbed, screenIsStale } = await import("../js/05-render.js");
const { flushEdits, undoSizes } = await import("../js/12a-undo.js");
const { clearDirty } = await import("../js/12-dirty-toast.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");

after(closeApp);

const realNow = Date.now;
let clock = 7_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const session = liveSession();
const published = [];
session.subscribe((c) => { published.push(c.kind); });

const REDRAW = "Could not redraw the script after the update. Nothing was lost — press Redraw before you keep editing.";
function fixture(title) {
  return {
    schema: 2,
    title: title,
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Mine one.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Mine two.", status: "ready" },
      { id: "r3", visualText: "Detail", audioText: "Mine three.", status: "todo" }
    ]
  };
}

function fresh(title) {
  if (viewFlags().writerOpen()) writer.closeWriter();
  window.__hostedTest.setSession({ role: "edit", docId: null });
  clock += 10_000;
  S.state = migrateRows(fixture(title));
  flushEdits();
  renderAbsorbed();
  clearDirty();
  document.getElementById("toast-host").textContent = "";
  return S.state;
}

const para = (id) => document.querySelector('#writer-doc .wr-para[data-id="' + id + '"]');
const gridCell = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + (field || "audioText") + '"]');
const row = (id) => S.state.rows.find((r) => r.id === id);

const modelTexts = () => S.state.rows.map((r) => [r.id, r.visualText, r.audioText]);
const gridTexts = () => Array.from(document.querySelectorAll("#rows > .row")).map((el) => {
  const id = el.getAttribute("data-id");
  return [id, gridCell(id, "visualText").textContent, gridCell(id, "audioText").textContent];
});
const writerTexts = () => Array.from(document.querySelectorAll("#writer-doc .wr-para")).map((el) => [el.getAttribute("data-id"), el.textContent]);

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

function typeAtEnd(cell, text) {
  const [node] = textNodeAt(cell, cell.textContent.length);
  node.data += text;
  caretAt(cell, cell.textContent.length);
  cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  flushEdits();
}

const removals = [];

function chromiumRemoval(run) {
  const proto = window.Element.prototype;
  const nodeProto = window.Node.prototype;
  const inner = Object.getOwnPropertyDescriptor(proto, "innerHTML");
  const replaceChild = nodeProto.replaceChild;
  const removeChild = nodeProto.removeChild;
  const insertBefore = nodeProto.insertBefore;
  const appendChild = nodeProto.appendChild;
  function leaving(subtree) {
    const active = document.activeElement;
    if (!active || active === document.body || !subtree || !subtree.contains || !subtree.contains(active)) return;
    removals.push({ id: active.getAttribute && active.getAttribute("data-id"), writer: !!active.closest("#writer-doc"), connected: active.isConnected, text: active.textContent });
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
  nodeProto.replaceChild = function (fresher, old) { leaving(old); return replaceChild.call(this, fresher, old); };
  nodeProto.removeChild = function (child) { leaving(child); return removeChild.call(this, child); };
  nodeProto.insertBefore = function (child, ref) { if (child.isConnected) leaving(child); return insertBefore.call(this, child, ref); };
  nodeProto.appendChild = function (child) { if (child.isConnected) leaving(child); return appendChild.call(this, child); };
  removals.length = 0;
  try {
    return run();
  } finally {
    Object.defineProperty(proto, "innerHTML", inner);
    nodeProto.replaceChild = replaceChild;
    nodeProto.removeChild = removeChild;
    nodeProto.insertBefore = insertBefore;
    nodeProto.appendChild = appendChild;
  }
}

function observe(run) {
  flushEdits();
  const seq = S.editSeq, generation = session.generation(), sizes = undoSizes();
  published.length = 0;
  const value = chromiumRemoval(run);
  flushEdits();
  return {
    value: value,
    edits: published.filter((k) => k === "edit").length,
    seq: S.editSeq - seq,
    generation: session.generation() - generation,
    undo: undoSizes().undo - sizes.undo
  };
}

const NO_EDIT = { edits: 0, seq: 0, generation: 0, undo: 0 };
const noEdit = (got) => ({ edits: got.edits, seq: got.seq, generation: got.generation, undo: got.undo });

function holds(got, expected, label, opts = {}) {
  assert.deepEqual(noEdit(got), NO_EDIT, label + ": the render made an edit");
  assert.equal(S.dirty, opts.dirty === true, label + ": the dirty state");
  assert.deepEqual(modelTexts(), expected, label + ": the model holds the incoming document");
  assert.deepEqual(gridTexts(), expected, label + ": the grid shows it");
  if (opts.writer) assert.deepEqual(writerTexts(), expected.map((r) => [r[0], r[2]]), label + ": the Writer shows it");
}

function focusCalls(run) {
  const proto = window.HTMLElement.prototype;
  const real = proto.focus;
  const calls = [];
  proto.focus = function (...args) { calls.push(this); return real.apply(this, args); };
  try {
    run();
  } finally {
    proto.focus = real;
  }
  return calls;
}

function merged(theirs, mine, base) {
  return applyMerge({ base: base, mine: mine, theirs: theirs, source: "server-conflict", report: false });
}

test("R1a: a render with a grid cell focused that the update leaves alone keeps that very cell, its focus and its caret, and makes no edit", () => {
  fresh("R1a");
  const cell = gridCell("r2", "audioText");
  caretAt(cell, 3);
  row("r1").audioText = "Theirs one.";
  row("r2").visualText = "Theirs close.";
  row("r3").audioText = "Theirs three.";
  S.state.title = "Theirs title";
  const got = observe(() => render());
  holds(got, [["r1", "Wide", "Theirs one."], ["r2", "Theirs close.", "Mine two."], ["r3", "Detail", "Theirs three."]], "R1a");
  assert.equal(document.getElementById("doc-title").value, "Theirs title");
  assert.equal(gridCell("r2", "audioText"), cell, "the focused cell is the same node");
  assert.equal(document.activeElement, cell);
  assert.equal(caretOffset(cell), 3);
});

test("R1b: a render with a grid cell focused that the update rewrote takes the old cell away holding its old text, writes nothing, and focuses the new cell", () => {
  fresh("R1b");
  caretAt(gridCell("r2", "audioText"), 3);
  row("r2").audioText = "Theirs two, longer.";
  const got = observe(() => render());
  holds(got, [["r1", "Wide", "Mine one."], ["r2", "Close", "Theirs two, longer."], ["r3", "Detail", "Mine three."]], "R1b");
  assert.ok(removals.some((r) => r.id === "r2" && r.connected && r.text === "Mine two."), "the old cell lost focus while it held the old text");
  assert.equal(document.activeElement, gridCell("r2", "audioText"));
  assert.equal(caretOffset(document.activeElement), "Theirs".length, "the caret inside the replaced word maps to that word's place (#464)");
});

test("R1c: a render that reorders the scenes around the focused one never takes that cell out of the page, so it keeps its focus and caret, and makes no edit", () => {
  fresh("R1c");
  const cell = gridCell("r1", "audioText");
  caretAt(cell, 2);
  S.state.rows = [row("r2"), row("r3"), row("r1")];
  const got = observe(() => render());
  holds(got, [["r2", "Close", "Mine two."], ["r3", "Detail", "Mine three."], ["r1", "Wide", "Mine one."]], "R1c");
  assert.deepEqual(removals, [], "the focused cell was never moved or removed");
  assert.equal(gridCell("r1", "audioText"), cell);
  assert.equal(document.activeElement, cell);
  assert.equal(caretOffset(cell), 2);
});

test("R2a: a render with a Writer paragraph focused redraws the Writer from the model, keeps the focus and caret in the Writer on that scene, focuses nothing in the grid, and makes no edit", () => {
  fresh("R2a");
  writer.openWriter();
  caretAt(para("r2"), 4);
  row("r1").audioText = "Theirs one.";
  row("r2").audioText = "Theirs two.";
  row("r3").visualText = "Theirs detail.";
  const calls = focusCalls(() => {
    const got = observe(() => render());
    holds(got, [["r1", "Wide", "Theirs one."], ["r2", "Close", "Theirs two."], ["r3", "Theirs detail.", "Mine three."]], "R2a", { writer: true });
  });
  assert.ok(removals.some((r) => r.id === "r2" && r.writer && r.text === "Mine two."), "the old paragraph lost focus while it held the old text");
  assert.deepEqual(calls.filter((el) => el.closest("#rows")).map((el) => el.getAttribute("data-id")), [], "no cell of the hidden grid was focused");
  assert.equal(document.activeElement, para("r2"));
  assert.equal(caretOffset(document.activeElement), "Theirs".length, "the caret at the end of the replaced word maps to the end of its replacement (#464)");
  writer.closeWriter();
});

test("R2b: a render with a Writer paragraph focused after scenes were added before it and removed after it follows the scene, in the Writer, and makes no edit", () => {
  fresh("R2b");
  writer.openWriter();
  caretAt(para("r2"), 2);
  const extra = migrateRows({ schema: 2, title: "x", rows: [{ id: "r9", visualText: "New", audioText: "Theirs new.", status: "todo" }] }).rows[0];
  S.state.rows = [extra, row("r1"), row("r2")];
  const calls = focusCalls(() => {
    const got = observe(() => render());
    holds(got, [["r9", "New", "Theirs new."], ["r1", "Wide", "Mine one."], ["r2", "Close", "Mine two."]], "R2b", { writer: true });
  });
  assert.deepEqual(calls.filter((el) => el.closest("#rows")), [], "no cell of the hidden grid was focused");
  assert.equal(document.activeElement, para("r2"));
  assert.equal(caretOffset(document.activeElement), 2);
  writer.closeWriter();
});

test("R3a: an incoming merge while a grid cell holds focus after accepted typing keeps that typing and the focus, applies the incoming change beside it, and the render adds no edit", () => {
  fresh("R3a");
  const base = cloneState(S.state);
  const cell = gridCell("r1", "audioText");
  typeAtEnd(cell, "!");
  assert.equal(row("r1").audioText, "Mine one.!");
  assert.equal(S.dirty, true);
  const theirs = cloneState(base);
  theirs.rows[0].visualText = "Theirs wide.";
  theirs.rows[2].audioText = "Theirs three.";
  theirs.title = "Theirs title";
  const got = observe(() => merged(theirs, cloneState(S.state), base));
  holds(got, [["r1", "Theirs wide.", "Mine one.!"], ["r2", "Close", "Mine two."], ["r3", "Detail", "Theirs three."]], "R3a", { dirty: true });
  assert.equal(S.state.title, "Theirs title");
  assert.equal(document.activeElement, gridCell("r1", "audioText"));
  assert.equal(caretOffset(document.activeElement), "Mine one.!".length);
});

function conflictRun(label, focused) {
  fresh(label);
  const base = cloneState(S.state);
  typeAtEnd(gridCell("r1", "audioText"), "!");
  if (!focused) document.activeElement.blur();
  const theirs = cloneState(base);
  theirs.rows[0].audioText = "Theirs one.";
  theirs.rows[1].audioText = "Theirs two.";
  const decided = applyMerge({ base: cloneState(base), mine: cloneState(S.state), theirs: cloneState(theirs), source: "server-conflict", mergeOnly: true })
    .state.rows.map((r) => [r.id, r.visualText, r.audioText]);
  const got = observe(() => merged(theirs, cloneState(S.state), base));
  return { decided: decided, got: got, texts: modelTexts(), grid: gridTexts() };
}

test("R3b: an incoming merge while a grid cell holds focus, whose text both sides changed, leaves the model and the cell showing what the merge decides on its own, and the focus changes nothing about its edits or undo steps", () => {
  const alone = conflictRun("R3b alone", false);
  const run = conflictRun("R3b focused", true);
  assert.deepEqual(run.decided, alone.decided, "the same merge decides the same document");
  assert.equal(run.decided[1][2], "Theirs two.");
  assert.ok(run.decided[0][2].endsWith("!"), "the typing the merge was handed is in the decided cell: " + run.decided[0][2]);
  assert.deepEqual([run.got.edits, run.got.seq, run.got.generation], [0, 0, 0]);
  assert.deepEqual(noEdit(run.got), noEdit(alone.got), "the focused cell added no edit or undo step beyond the merge itself");
  assert.deepEqual(run.texts, run.decided, "the model is what the merge decided");
  assert.deepEqual(run.grid, run.decided, "the grid shows it");
  assert.equal(S.dirty, true);
  assert.equal(document.activeElement, gridCell("r1", "audioText"));
});

test("R3c: an incoming merge that removes the focused cell's scene, after accepted typing there and elsewhere, keeps the typing elsewhere and makes no edit", () => {
  fresh("R3c");
  const base = cloneState(S.state);
  typeAtEnd(gridCell("r3", "audioText"), "?");
  caretAt(gridCell("r1", "audioText"), 2);
  const theirs = cloneState(base);
  theirs.rows.splice(0, 1);
  const got = observe(() => merged(theirs, cloneState(S.state), base));
  assert.deepEqual(noEdit(got), NO_EDIT);
  assert.deepEqual(modelTexts(), [["r2", "Close", "Mine two."], ["r3", "Detail", "Mine three.?"]]);
  assert.deepEqual(gridTexts(), modelTexts());
  assert.equal(S.dirty, true);
  assert.equal(gridCell("r1", "audioText"), null);
  assert.ok(!document.activeElement.closest("#rows .cell-editable[data-id='r1']"), "the removed scene's cell is not focused");
});

const PLACES = [
  {
    name: "a grid cell focused",
    setup: () => caretAt(gridCell("r2", "audioText"), 3),
    stale: () => gridCell("r2", "audioText"),
    writer: false
  },
  {
    name: "a Writer paragraph focused",
    setup: () => { writer.openWriter(); caretAt(para("r2"), 3); },
    stale: () => para("r2"),
    writer: true
  }
];

const THROWS = [
  {
    name: "before any scene is drawn",
    arm: () => {
      document.querySelectorAll = function (selector) {
        if (String(selector).indexOf("#rows .gutter-btn") === 0) throw new Error("render broke (R4)");
        return Document.prototype.querySelectorAll.call(this, selector);
      };
      return () => { delete document.querySelectorAll; };
    }
  },
  {
    name: "in the middle of the scenes",
    arm: () => {
      const target = row("r2");
      const value = target.audioText;
      let armed = true;
      Object.defineProperty(target, "audioText", {
        configurable: true,
        enumerable: true,
        get() { if (armed) throw new Error("render broke (R4)"); return value; },
        set(v) { Object.defineProperty(target, "audioText", { configurable: true, enumerable: true, writable: true, value: v }); }
      });
      return () => {
        armed = false;
        Object.defineProperty(target, "audioText", { configurable: true, enumerable: true, writable: true, value: value });
      };
    }
  },
  {
    name: "when the title is read, after the scenes and before the Writer",
    arm: () => {
      const doc = S.state;
      const value = doc.title;
      let armed = true;
      Object.defineProperty(doc, "title", {
        configurable: true,
        enumerable: true,
        get() { if (armed) throw new Error("render broke (R4)"); return value; },
        set(v) { Object.defineProperty(doc, "title", { configurable: true, enumerable: true, writable: true, value: v }); }
      });
      return () => {
        armed = false;
        Object.defineProperty(doc, "title", { configurable: true, enumerable: true, writable: true, value: value });
      };
    }
  }
];

function logging(run) {
  const consoles = [...new Set([window.console, globalThis.console])];
  const was = consoles.map((c) => c.error);
  const logged = [];
  consoles.forEach((c) => { c.error = (e) => { logged.push((e && e.message) || String(e)); }; });
  try {
    return { value: run(), logged: logged };
  } finally {
    consoles.forEach((c, i) => { c.error = was[i]; });
  }
}

function incomingForThrow() {
  row("r1").audioText = "Theirs one.";
  row("r3").audioText = "Theirs three.";
  S.state.title = "Theirs title";
}

function failingRender(place, how) {
  fresh("R4 " + place.name + " " + how.name);
  place.setup();
  const before = screenMarkup();
  const target = place.stale();
  incomingForThrow();
  row("r2").audioText = "Theirs two.";
  const out = logging(() => observe(() => {
    const disarm = how.arm();
    try {
      return renderAbsorbed();
    } finally {
      disarm();
    }
  }));
  return { out: out, before: before, target: target };
}

function screenMarkup() {
  const rows = {};
  document.querySelectorAll("#rows > .row").forEach((el) => { rows[el.getAttribute("data-id")] = el.innerHTML; });
  const paras = {};
  document.querySelectorAll("#writer-doc .wr-block").forEach((el) => { paras[el.getAttribute("data-row")] = el.innerHTML; });
  return {
    rowOrder: Object.keys(rows),
    rows: rows,
    title: document.getElementById("doc-title").value,
    writerOrder: Object.keys(paras),
    writer: paras,
    writerTitle: document.getElementById("writer-title").value
  };
}

function sameScreen(after, before, label) {
  const changed = [];
  if (JSON.stringify(after.rowOrder) !== JSON.stringify(before.rowOrder)) changed.push("scene order");
  for (const id of Object.keys(before.rows)) if (after.rows[id] !== before.rows[id]) changed.push("scene " + id);
  if (after.title !== before.title) changed.push("title");
  if (JSON.stringify(after.writerOrder) !== JSON.stringify(before.writerOrder)) changed.push("Writer order");
  for (const id of Object.keys(before.writer)) if (after.writer[id] !== before.writer[id]) changed.push("Writer " + id);
  if (after.writerTitle !== before.writerTitle) changed.push("Writer title");
  assert.deepEqual(changed, [], label + ": the screen changed in these parts");
}

const EXPECTED_THROWN = [["r1", "Wide", "Theirs one."], ["r2", "Close", "Theirs two."], ["r3", "Detail", "Theirs three."]];

const redrawToast = () => Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)"))
  .find((el) => el.firstChild && el.firstChild.nodeValue === REDRAW);

for (const place of PLACES) {
  for (const how of THROWS) {
    test("R4: a render that throws " + how.name + " with " + place.name + " makes no edit; the stale cell's blur writes nothing; Redraw draws the incoming document without an edit", () => {
      try {
        const run = failingRender(place, how);
        assert.deepEqual(run.out.logged, ["render broke (R4)"]);
        assert.deepEqual(noEdit(run.out.value), NO_EDIT, "the failed render made an edit");
        assert.deepEqual(modelTexts(), EXPECTED_THROWN, "the model holds the incoming document");
        assert.equal(screenIsStale(), true);
        assert.equal(S.dirty, false);
        const stale = run.target;
        const staleText = stale.textContent;
        assert.equal(staleText, "Mine two.", "the cell the user was in still shows the old text");
        const probe = observe(() => {
          stale.dispatchEvent(new window.FocusEvent("blur"));
          stale.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
        });
        assert.deepEqual(noEdit(probe), NO_EDIT, "the stale cell's blur made an edit");
        assert.deepEqual(modelTexts(), EXPECTED_THROWN, "the stale cell's blur wrote its text over the model");
        assert.equal(S.dirty, false);
        const toast = redrawToast();
        assert.ok(toast, "Redraw is offered");
        const redrawn = observe(() => toast.querySelector(".toast-action").click());
        holds(redrawn, EXPECTED_THROWN, "after Redraw", { writer: place.writer });
        assert.equal(screenIsStale(), false);
        if (place.writer) assert.ok(document.getElementById("writer").contains(document.activeElement), "the focus is in the Writer");
        else assert.equal(document.activeElement, gridCell("r2", "audioText"), "the focus is back in the cell");
      } finally {
        if (viewFlags().writerOpen()) writer.closeWriter();
        if (screenIsStale()) renderAbsorbed();
      }
    });
  }
}

test("R4e: a render that throws before any scene is drawn leaves the whole screen as it was", () => {
  try {
    const run = failingRender(PLACES[0], THROWS[0]);
    sameScreen(screenMarkup(), run.before, "after the failed render");
  } finally {
    renderAbsorbed();
  }
});

test("R4m: a render that throws in the middle of the scenes leaves the whole screen as it was", () => {
  try {
    const run = failingRender(PLACES[0], THROWS[1]);
    sameScreen(screenMarkup(), run.before, "after the failed render");
  } finally {
    renderAbsorbed();
  }
});

test("R4l: a render that throws when the title is read, after the scenes were drawn, leaves the whole screen as it was", () => {
  try {
    const run = failingRender(PLACES[0], THROWS[2]);
    sameScreen(screenMarkup(), run.before, "after the failed render");
  } finally {
    renderAbsorbed();
  }
});

test("R4w: a render that throws when the title is read, between the grid and the Writer, leaves the Writer and the grid as they were", () => {
  try {
    const run = failingRender(PLACES[1], THROWS[2]);
    sameScreen(screenMarkup(), run.before, "after the failed render");
  } finally {
    if (viewFlags().writerOpen()) writer.closeWriter();
    renderAbsorbed();
  }
});

function throwAtRow(id) {
  const target = row(id);
  const value = target.audioText;
  Object.defineProperty(target, "audioText", {
    configurable: true,
    enumerable: true,
    get() { throw new Error("render broke (R4a)"); }
  });
  return () => { Object.defineProperty(target, "audioText", { configurable: true, enumerable: true, writable: true, value: value }); };
}

for (const place of PLACES) {
  for (const id of ["r1", "r2", "r3"]) {
    test("R4a: a render that throws at scene " + id + " with " + place.name + " leaves the whole screen as it was (#463)", () => {
      fresh("R4a " + id + " " + place.name);
      place.setup();
      try {
        const before = screenMarkup();
        incomingForThrow();
        S.state.rows.push(migrateRows({ schema: 2, title: "x", rows: [{ id: "r9", visualText: "New", audioText: "Theirs new.", status: "todo" }] }).rows[0]);
        const out = logging(() => {
          const disarm = throwAtRow(id);
          try {
            return renderAbsorbed();
          } finally {
            disarm();
          }
        });
        assert.equal(out.value, false);
        assert.deepEqual(out.logged, ["render broke (R4a)"]);
        sameScreen(screenMarkup(), before, "after the failed render");
        assert.equal(screenIsStale(), true);
      } finally {
        if (viewFlags().writerOpen()) writer.closeWriter();
        renderAbsorbed();
      }
    });
  }
}

function focusGridUnderWriter(cell) {
  const hold = (e) => e.stopImmediatePropagation();
  window.addEventListener("focusin", hold, true);
  try {
    cell.focus();
  } finally {
    window.removeEventListener("focusin", hold, true);
  }
}

test("R5a: with the Writer open and a Writer paragraph focused, restoring the render focus focuses nothing in the hidden grid, even when every grid cell changed", () => {
  fresh("R5a");
  writer.openWriter();
  caretAt(para("r3"), 5);
  S.state.rows.forEach((r) => { r.audioText = "Theirs " + r.id + "."; r.visualText = "Seen " + r.id; });
  const expected = [["r1", "Seen r1", "Theirs r1."], ["r2", "Seen r2", "Theirs r2."], ["r3", "Seen r3", "Theirs r3."]];
  const calls = focusCalls(() => {
    holds(observe(() => render()), expected, "R5a", { writer: true });
  });
  assert.deepEqual(calls.filter((el) => el.closest("#rows")), []);
  assert.equal(document.activeElement, para("r3"));
  assert.equal(caretOffset(document.activeElement), "Theirs ".length, "the caret after the kept space stays after it (#464)");
  writer.closeWriter();
});

function underWriter(label) {
  fresh(label);
  writer.openWriter();
  const cell = gridCell("r2", "audioText");
  focusGridUnderWriter(cell);
  assert.equal(document.activeElement, cell, "a cell of the grid is focused under the open Writer");
  row("r2").audioText = "Theirs two.";
  row("r1").audioText = "Theirs one.";
}

const EXPECTED_UNDER_WRITER = [["r1", "Wide", "Theirs one."], ["r2", "Close", "Theirs two."], ["r3", "Detail", "Mine three."]];

test("R5b: with the Writer open and a grid cell still the active element, a render makes no edit and both surfaces show the incoming document", () => {
  underWriter("R5b");
  try {
    holds(observe(() => render()), EXPECTED_UNDER_WRITER, "R5b", { writer: true });
  } finally {
    writer.closeWriter();
  }
});

test("R5d: with the Writer open and a grid cell still the active element, the render focuses no cell of the grid", () => {
  underWriter("R5d");
  try {
    const calls = focusCalls(() => { observe(() => render()); });
    assert.deepEqual(calls.filter((el) => el.closest("#rows")).map((el) => el.getAttribute("data-id") + "/" + el.getAttribute("data-field")), [], "a grid cell was focused under the open Writer");
  } finally {
    writer.closeWriter();
  }
});

test("R5c: with the Writer open and its title focused, a render keeps the title box and the focus, restores no grid cell, and makes no edit", () => {
  fresh("R5c");
  writer.openWriter();
  const box = document.getElementById("writer-title");
  box.focus();
  assert.equal(document.activeElement, box);
  row("r2").audioText = "Theirs two.";
  const calls = focusCalls(() => {
    holds(observe(() => render()), [["r1", "Wide", "Mine one."], ["r2", "Close", "Theirs two."], ["r3", "Detail", "Mine three."]], "R5c", { writer: true });
  });
  assert.deepEqual(calls.filter((el) => el.closest("#rows")), []);
  assert.equal(document.activeElement, box);
  writer.closeWriter();
});
