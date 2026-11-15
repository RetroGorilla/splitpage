import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(() => { closeApp(); });

const { adoptReplacement, runCommand, sessionStamps, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { sharedUndoRoute, stepSharedUndo, undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { sharedSessionParts } = await import("../bootstrap/wiring/shared-session.ts");
const { sharedStructurePorts } = await import("../bootstrap/wiring/ports/shared-values.ts");
const { fromHtml } = await import("../bootstrap/richtext.ts");
const { addBeatCommand } = await import("../application/commands/rows.ts");
const { encodeSharedState, encodeSharedStateVector, encodeSharedUpdate } = await import("../adapters/collab/document.ts");
const { PART_SEAMS, markParts } = await import("../../tests/collab/measure/mark-parts.mjs");
const { timingMarks } = await import("../../shared/timing-marks.ts");
const hook = window.__sharedTest;

function dispatched(run) {
  if (!timingMarks.marksOn) return run();
  performance.mark("measure:event:start");
  try { return run(); } finally { performance.mark("measure:event:end"); }
}

const dispatch = (target, event) => dispatched(() => target.dispatchEvent(event));

const ROWS = [{ id: "r1", audioText: "Hello", visualText: "" }, { id: "r2", audioText: "World", visualText: "" }];
const FILLED = "€".repeat(4);

function script(given = ROWS) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Measure", rows: given }));
  undoOwner().flush();
  writerControls().openWriter();
}

function appTypes(data) {
  const root = document.getElementById("writer-doc"), element = root.querySelector('.wr-beat[data-id="r1"]'), node = element.lastChild;
  dispatched(() => { root.focus(); });
  const range = document.createRange();
  range.setStart(node, node.data.length); range.collapse(true);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data });
  const target = range.cloneRange();
  Object.defineProperty(before, "getTargetRanges", { value: () => [target] });
  assert.equal(dispatch(element, before), true);
  node.data += data;
  return () => { dispatch(element, new window.InputEvent("input", { bubbles: true, inputType: "insertText", data })); };
}

function fakeClock() {
  let now = 0;
  const due = new Set();
  return {
    now: () => now,
    start: (run, ms) => { const timer = { at: now + ms, run }; due.add(timer); return timer; },
    stop: timer => { due.delete(timer); },
    advance(ms) {
      const until = now + ms;
      for (let next = [...due].sort((a, b) => a.at - b.at)[0]; next && next.at <= until; next = [...due].sort((a, b) => a.at - b.at)[0]) {
        due.delete(next); now = next.at; next.run();
      }
      now = until;
    },
    pending: () => due.size
  };
}

const rows = doc => doc.rows.map(row => [row.id, row.audioText]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const entries = () => performance.getEntriesByType("mark").filter(entry => entry.name.startsWith("measure:"));
const marks = () => entries().map(entry => entry.name);
const queued = () => hook.counters().queued;
const snapshot = () => JSON.stringify([hook.read(), hook.peer.recoveryEntries("app"), hook.peer.recoveryEntries("peer")]);
const bytesOf = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));

function spans(names) {
  const open = new Map(), out = [];
  names.forEach((name, at) => {
    const [, seam, edge] = name.split(":");
    if (edge === "start") { if (!open.has(seam)) open.set(seam, []); open.get(seam).push(at); return; }
    const start = open.get(seam)?.pop();
    assert.notEqual(start, undefined, "every end mark has its start: " + name);
    out.push({ seam, start, end: at });
  });
  for (const [seam, starts] of open) assert.deepEqual(starts, [], "every start mark has its end: " + seam);
  return out;
}

const of = (found, seam) => found.filter(span => span.seam === seam);
const inside = (inner, outer) => outer.start < inner.start && inner.end < outer.end;
const insideOne = (inner, outers) => outers.some(outer => inside(inner, outer));

async function shared(run, given = ROWS) {
  script(given);
  assert.deepEqual(await hook.enter(), { ok: true });
  try { await run(hook.peer); } finally {
    hook.timing(false);
    performance.clearMarks();
    if (sharedSession()) hook.leave();
  }
}

function counted(run) {
  const realMark = performance.mark, realFor = Symbol.for, calls = { mark: 0, symbolFor: 0 };
  performance.mark = function (...args) { calls.mark++; return realMark.apply(this, args); };
  Symbol.for = function (...args) { calls.symbolFor++; return realFor.apply(this, args); };
  try { run(); } finally { performance.mark = realMark; Symbol.for = realFor; }
  return calls;
}

function oneCommandWithItsWrite(label) {
  const found = spans(marks()), writes = of(found, "input-write");
  const commands = of(found, "input-command").filter(command => writes.some(write => inside(write, command)));
  assert.equal(commands.length, 1, label + ": one input command holds the write in " + marks().join(" "));
  assert.ok(writes.length >= 1 && writes.every(write => inside(write, commands[0])), label + ": every write runs inside that command");
  for (const seam of ["mirror-apply", "assembly", "session-receive", "render"]) {
    assert.ok(of(found, seam).length > 0 && of(found, seam).every(span => insideOne(span, writes)), label + ": " + seam + " runs inside the write");
  }
}

test("timing marks: switched off, a valid update, a refused update and a typed character call no mark and no symbol lookup; switched on, a remote update marks its trial, live apply, projection, session receive and render, nested in that order", async () => {
  await shared(p => {
    p.hold();
    assert.equal(p.type("r1", 0, "Y").kind, "applied");
    performance.clearMarks();
    const off = counted(() => {
      assert.equal(p.deliver("forward", "app"), 1);
      assert.deepEqual(p.inject(p.refusedUpdate("throws")), { ok: false, reason: "invalid-update" });
      appTypes("?")();
    });
    assert.deepEqual(off, { mark: 0, symbolFor: 0 }, "a test build with the marks off reads one flag per mark line and calls nothing");
    assert.deepEqual(marks(), []);
    assert.equal(hook.read().app.rows[0].audioText, "YHello?");
    hook.timing(true);
    assert.equal(p.type("r2", 0, "Z").kind, "applied");
    performance.clearMarks();
    assert.equal(p.deliver("forward", "app"), 1);
    const found = spans(marks());
    assert.deepEqual([...new Set(found.map(span => span.seam))].sort(),
      ["assembly", "document-entry", "live-apply", "mirror-apply", "projection-listeners", "receive", "render", "session-receive", "trial"]);
    const [trial] = of(found, "trial"), [live] = of(found, "live-apply"), [receive] = of(found, "session-receive");
    assert.ok(trial.end < live.start, "the trial ends before the live apply starts");
    for (const seam of ["mirror-apply", "assembly", "projection-listeners"]) assert.ok(of(found, seam).every(span => inside(span, live)), seam + " runs inside the live apply");
    assert.ok(inside(receive, of(found, "projection-listeners")[0]), "the session receive is a projection listener");
    for (const seam of ["document-entry", "render"]) assert.ok(of(found, seam).every(span => inside(span, receive)), seam + " runs inside the session receive");
    hook.timing(false);
    performance.clearMarks();
    assert.equal(p.type("r2", 0, "W").kind, "applied");
    assert.equal(p.deliver("forward", "app"), 1);
    assert.deepEqual(marks(), [], "switching the marks off stops them");
  });
});

test("timing marks: the app's own typing marks its input handler, then the command from before the buffer plans, then the write, with the projection and render inside the write and no trial", async () => {
  await shared(p => {
    p.hold();
    hook.timing(true);
    const author = sharedSessionParts().author, realNext = author.next;
    let atAuthor = null;
    author.next = () => { atAuthor ??= marks(); return realNext(); };
    performance.clearMarks();
    try { appTypes("!")(); } finally { author.next = realNext; }
    assert.equal(atAuthor?.at(-1), "measure:input-command:start", "the command span is open before the buffer plans and names its author");
    const found = spans(marks()), seams = new Set(found.map(span => span.seam));
    assert.deepEqual(["trial", "live-apply"].filter(seam => seams.has(seam)), [], "a local write runs no trial and no remote apply");
    oneCommandWithItsWrite("typing");
    assert.ok(of(found, "input-command").every(command => insideOne(command, of(found, "input-handler"))), "every command runs inside the input handler");
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello!"], ["r2", "World"]]);
  });
});

test("timing marks: a structural command, its undo and its redo each mark one input command with its write, projection and render inside", async () => {
  await shared(() => {
    const parts = sharedSessionParts();
    const structure = sharedStructurePorts({ handle: () => parts.handle, author: () => parts.author.next(), stamps: sessionStamps, cells: html => fromHtml(html) });
    hook.timing(true);
    performance.clearMarks();
    assert.equal(runCommand(addBeatCommand("r2", "r3", sessionStamps, structure() ?? undefined)).kind, "applied");
    oneCommandWithItsWrite("add a beat");
    const added = rows(hook.read().app).map(([id]) => id);
    assert.deepEqual(added.slice(0, 2), ["r1", "r2"]);
    assert.equal(added.length, 3);
    for (const [direction, ids] of [["undo", ["r1", "r2"]], ["redo", added]]) {
      performance.clearMarks();
      const outcome = stepSharedUndo(sharedUndoRoute(), direction, message => { assert.fail(message); });
      assert.deepEqual([outcome.ok, outcome.effective], [true, true], direction);
      oneCommandWithItsWrite(direction);
      assert.deepEqual(rows(hook.read().app).map(([id]) => id), ids, direction);
    }
  });
});

test("timing marks: on a recorded remote update and a typed character, the exclusive parts and the unattributed time add up to the outer spans", async () => {
  await shared(p => {
    p.hold();
    assert.equal(p.type("r2", 0, "Z").kind, "applied");
    hook.timing(true);
    performance.clearMarks();
    assert.equal(p.deliver("forward", "app"), 1);
    appTypes("!")();
    const parts = markParts(entries());
    const sum = parts.validation + parts.apply + parts.projection + parts.rendering + parts.input;
    assert.ok(Math.abs(sum + parts.unattributed - parts.outer) < 1e-6, `parts ${sum} and ${parts.unattributed} unattributed against outer ${parts.outer}`);
    assert.ok(parts.validation > 0 && parts.projection > 0 && parts.rendering > 0 && parts.input > 0, JSON.stringify(parts));
    assert.ok(parts.unattributed > -1e-6 && Object.values(parts.exclusive).every(time => time >= 0), JSON.stringify(parts));
  });
});

const PART_STARTS = new Set(Object.values(PART_SEAMS).flat().map(seam => `measure:${seam}:start`));
const PROBES = [[Uint8Array, "from"], [Y.Doc.prototype, "emit"], [window.Element.prototype, "getBoundingClientRect"], [window.Element.prototype, "getClientRects"],
  [window.Range.prototype, "getBoundingClientRect"], [window.Range.prototype, "getClientRects"], [window.Node.prototype, "appendChild"],
  [window.Node.prototype, "insertBefore"], [window.Node.prototype, "removeChild"], [window.Element.prototype, "setAttribute"], [globalThis, "setTimeout"],
  [window, "setTimeout"], [globalThis, "requestAnimationFrame"], [Date, "now"]];

function probed(run) {
  const recorded = [], restore = [], realMark = performance.mark;
  let now = 0;
  for (const [owner, name] of PROBES) {
    const real = owner[name], own = Object.hasOwn(owner, name);
    if (typeof real !== "function" || restore.some(entry => entry.owner === owner && entry.name === name)) continue;
    owner[name] = function (...args) {
      if (owner !== Date || !/[\\/]jsdom[\\/].*Event-impl\.js/.test(new Error().stack)) now++;
      return real.apply(this, args);
    };
    restore.push({ owner, name, undo: () => { if (own) owner[name] = real; else delete owner[name]; } });
  }
  performance.mark = name => { recorded.push({ name, startTime: now }); if (PART_STARTS.has(name)) now++; };
  try { run(steps => { now += steps; }); } finally {
    performance.mark = realMark;
    for (const entry of restore.reverse()) entry.undo();
  }
  const names = recorded.map(entry => entry.name.slice(8));
  try { return { parts: markParts(recorded), names }; } catch (error) { assert.fail(error.message + " in " + names.join(" ")); }
}

const key = (element, name, options = {}) => dispatch(element, new window.KeyboardEvent(name, { bubbles: true, cancelable: true, ...options }));

function press(element, data, insert, between = () => {}) {
  key(element, "keydown", { key: data });
  key(element, "keypress", { key: data });
  const range = window.getSelection().getRangeAt(0).cloneRange();
  const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  assert.equal(dispatch(element, before), true);
  insert(range);
  between();
  dispatch(element, new window.InputEvent("input", { bubbles: true, inputType: "insertText", data }));
  key(element, "keyup", { key: data });
}

function writerBeat() {
  const root = document.getElementById("writer-doc"), element = root.querySelector('.wr-beat[data-id="r1"]'), node = element.lastChild;
  dispatched(() => { root.focus(); });
  const range = document.createRange();
  range.setStart(node, node.data.length); range.collapse(true);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  return { root, element, type: (data, between) => { press(element, data, () => { node.data += data; }, between); } };
}

function splitCell() {
  writerControls().closeWriter();
  const cell = document.querySelector('#rows .cell-editable[data-id="r1"][data-field="audioText"]');
  assert.ok(cell);
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell); range.collapse(false);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  return { cell, type: data => { press(cell, data, inserted(data)); } };
}

const inserted = data => at => {
  at.deleteContents();
  const text = document.createTextNode(data);
  at.insertNode(text);
  window.getSelection().setBaseAndExtent(text, data.length, text, data.length);
};

test("unattributed time: on a clock that only marked stages and one deliberately unmarked listener advance, unattributed is exactly that listener's time", async () => {
  await shared(() => {
    hook.timing(true);
    const unmarked = advance => () => { advance(7); };
    let listener = null;
    const { parts } = probed(advance => {
      listener = unmarked(advance);
      document.addEventListener("input", listener);
      try { writerBeat().type("!"); } finally { document.removeEventListener("input", listener); }
    });
    assert.equal(parts.unattributed, 7, JSON.stringify(parts));
    assert.ok(parts.input > 0 && parts.projection > 0 && parts.rendering > 0, JSON.stringify(parts));
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello!"], ["r2", "World"]]);
  });
});

test("outer spans from the test's own dispatch: an unmarked capture listener on the window, a listener after one that stops the event on the same target, and a selectionchange on the document each count inside the event span", async () => {
  await shared(p => {
    p.hold();
    hook.timing(true);
    const listened = (target, type, listener, run, capture = false) => {
      target.addEventListener(type, listener, capture);
      try { run(); } finally { target.removeEventListener(type, listener, capture); }
    };
    const captured = probed(advance => {
      listened(window, "keydown", () => { advance(5); }, () => { writerBeat().type("!"); }, true);
    });
    assert.equal(captured.parts.unattributed, 5, "a capture listener on the window runs before the app's: " + JSON.stringify(captured.parts));
    const stopped = probed(advance => {
      const { root, type } = writerBeat();
      listened(root, "keyup", event => { event.stopPropagation(); }, () => {
        listened(root, "keyup", () => { advance(4); }, () => { type("?"); });
      });
    });
    assert.equal(stopped.parts.unattributed, 4, "the listener after the stop on the same target still runs: " + JSON.stringify(stopped.parts));
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello!?"], ["r2", "World"]]);
    const element = document.querySelector('#writer-doc .wr-beat[data-id="r1"]');
    window.getSelection().setBaseAndExtent(element.lastChild, 0, element.lastChild, 0);
    const moved = probed(() => { dispatch(document, new window.Event("selectionchange")); });
    assert.deepEqual([moved.names[0], moved.names.at(-1)], ["event:start", "event:end"], moved.names.join(" "));
    const movedSpans = spans(moved.names.map(name => "measure:" + name));
    assert.ok(of(movedSpans, "input-handler").length === 1 && insideOne(of(movedSpans, "input-handler")[0], of(movedSpans, "event")),
      "the Writer's selection handler runs inside the event span: " + moved.names.join(" "));
  });
});

test("unattributed time is zero on a clock that every probed call advances: a typed character in the Writer and in Split, a valid update, an update held then drained, refused updates, undo, a structural command, and a Split command that captures, settles and drains", async () => {
  await shared(p => {
    p.hold();
    assert.equal(p.type("r2", 0, "Z").kind, "applied");
    hook.timing(true);
    const zero = (label, run) => {
      const found = probed(run);
      assert.equal(found.parts.unattributed, 0, label + ": " + JSON.stringify(found.parts) + " " + found.names.join(" "));
      return found;
    };
    const writer = zero("a typed character in the Writer", () => { writerBeat().type("!"); });
    assert.ok(writer.parts.input > 0 && writer.parts.rendering > 0, JSON.stringify(writer.parts));
    const valid = zero("a valid update", () => { assert.equal(p.deliver("forward", "app"), 1); });
    assert.ok(valid.parts.validation > 0 && valid.parts.apply > 0 && valid.parts.projection > 0, JSON.stringify(valid.parts));
    assert.equal(p.type("r2", 0, "Y").kind, "applied");
    const held = zero("an update held, then drained by the commit", () => {
      writerBeat().type("?", () => { assert.equal(p.deliver("forward", "app"), 1); });
    });
    assert.ok(held.parts.exclusive.queue > 0, "the held copy is its own span");
    assert.ok(held.names.indexOf("drain:start") >= 0 && held.names.indexOf("drain:start") === held.names.indexOf("live-apply:start") - 1, held.names.join(" "));
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello!?"], ["r2", "YZWorld"]]);
    zero("refused updates", () => {
      for (const kind of ["throws", "zero-length"]) assert.deepEqual(p.inject(p.refusedUpdate(kind)), { ok: false, reason: "invalid-update" });
    });
    const undo = zero("undo", () => {
      const { root } = writerBeat();
      key(root, "keydown", { key: "z", ctrlKey: true });
      key(root, "keyup", { key: "z", ctrlKey: true });
    });
    assert.ok(undo.names.includes("input-write:start"), "the undo wrote");
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello"], ["r2", "YZWorld"]], "the two typed characters are one undo step");
    const structure = zero("a structural command", () => {
      const { root } = writerBeat();
      key(root, "keydown", { key: "Enter" });
      key(root, "keyup", { key: "Enter" });
    });
    assert.ok(structure.names.includes("input-write:start"), "the command wrote");
    assert.equal(hook.read().app.rows.length, 3);
    const cell = splitCell();
    const split = zero("a typed character in Split", () => { cell.type("%"); });
    assert.ok(split.parts.exclusive["cell-refresh"] > 0 && split.parts.input > 0, JSON.stringify(split.parts));
    const splitSpans = spans(split.names.map(name => "measure:" + name));
    assert.ok(of(splitSpans, "cell-refresh").every(span => insideOne(span, of(splitSpans, "input-handler"))), "the cell refresh runs inside the bubbling input handler");
    assert.equal(hook.read().app.rows[0].audioText, "Hello%");
    assert.equal(p.type("r2", 0, "X").kind, "applied");
    const capture = zero("Ctrl+Enter in Split with typing still open and a peer update held: the capture settles the typing, reads the caret and drains the update on release", () => {
      const range = window.getSelection().getRangeAt(0).cloneRange();
      const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "^" });
      Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
      assert.equal(dispatch(cell.cell, before), true);
      range.deleteContents();
      const text = document.createTextNode("^");
      range.insertNode(text);
      window.getSelection().setBaseAndExtent(text, 1, text, 1);
      assert.equal(p.deliver("forward", "app"), 1);
      key(cell.cell, "keydown", { key: "Enter", ctrlKey: true });
      key(cell.cell, "keyup", { key: "Enter", ctrlKey: true });
    });
    const captureSpans = spans(capture.names.map(name => "measure:" + name)), drains = of(captureSpans, "drain");
    assert.ok(of(captureSpans, "queue").length === 1 && drains.length >= 1, capture.names.join(" "));
    assert.ok(drains.every(span => insideOne(span, of(captureSpans, "input-command"))), "the held update drains inside the command's settle and capture");
    assert.ok(capture.parts.apply > 0, JSON.stringify(capture.parts));
    assert.deepEqual(rows(hook.read().app).map(([, text]) => text).filter(text => text !== ""), ["Hello%^", "XYZWorld"], "the typing and the peer update both landed");
    assert.equal(hook.read().app.rows.length, 4, "Ctrl+Enter added a beat");
  });
});

test("unattributed time is zero when leaving a shared Split visual cell keys its b-roll line, and the keying runs as an input command with its write", async () => {
  await shared(p => {
    p.hold();
    hook.timing(true);
    writerControls().closeWriter();
    const cellOf = (rowId, field) => document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);
    const visual = cellOf("r1", "visualText"), other = cellOf("r2", "audioText");
    assert.ok(visual && other);
    dispatched(() => { visual.focus(); });
    const first = document.createTreeWalker(visual, window.NodeFilter.SHOW_TEXT).nextNode();
    window.getSelection().setBaseAndExtent(first, 0, first, 0);
    for (const character of "B-roll: ") press(visual, character, inserted(character));
    assert.equal(hook.read().app.rows[0].visualText, "B-roll: Close up");
    const left = probed(() => { dispatched(() => { other.focus(); }); });
    assert.equal(left.parts.unattributed, 0, JSON.stringify(left.parts) + " " + left.names.join(" "));
    const found = spans(left.names.map(name => "measure:" + name)), writes = of(found, "input-write");
    assert.ok(writes.length >= 1 && writes.every(write => insideOne(write, of(found, "input-command"))), "the keying writes inside its command: " + left.names.join(" "));
    assert.match(hook.read().app.rows[0].visualText, /class="broll-key"/, "leaving the cell keyed the line");
  }, [{ id: "r1", audioText: "Hello", visualText: "Close up" }, { id: "r2", audioText: "World", visualText: "" }]);
});

test("unattributed time is zero when leaving the shared Writer's visual box keys its b-roll line, and the keying runs as an input command with its write", async () => {
  await shared(p => {
    p.hold();
    hook.timing(true);
    writerControls().writerFlowControl().openVisual("r1");
    const box = document.querySelector(".wr-flow-visual-box"), visual = box?.querySelector(".wr-flow-visual-text");
    assert.ok(box && visual && !box.hidden);
    dispatched(() => { visual.focus(); });
    const first = document.createTreeWalker(visual, window.NodeFilter.SHOW_TEXT).nextNode();
    window.getSelection().setBaseAndExtent(first, 0, first, 0);
    for (const character of "B-roll: ") press(visual, character, inserted(character));
    assert.equal(hook.read().app.rows[0].visualText, "B-roll: Close up");
    const left = probed(() => { key(visual, "keydown", { key: "Escape" }); });
    assert.equal(left.parts.unattributed, 0, JSON.stringify(left.parts) + " " + left.names.join(" "));
    const found = spans(left.names.map(name => "measure:" + name)), writes = of(found, "input-write");
    assert.ok(writes.length >= 1 && writes.every(write => insideOne(write, of(found, "input-command"))), "the keying writes inside its command: " + left.names.join(" "));
    assert.equal(box.hidden, true, "Escape left the box");
    assert.match(hook.read().app.rows[0].visualText, /class="broll-key"/, "leaving the box keyed the line");
  }, [{ id: "r1", audioText: "Hello", visualText: "Close up" }, { id: "r2", audioText: "World", visualText: "" }]);
});

const STRUCTURE = [
  { name: "splits a beat", run: p => p.split("r1", 2), label: "split-scene", after: id => [["r1", "He"], [id, "llo"], ["r2", "World"]] },
  { name: "adds a beat", run: p => p.add("r2"), label: "add-scene", after: id => [["r1", "Hello"], ["r2", "World"], [id, ""]] },
  { name: "joins two beats", run: p => ({ kind: p.join("r1"), id: null }), label: "join-scenes", after: () => [["r1", "Hello World"]] }
];

for (const edit of STRUCTURE) test(`the peer ${edit.name} as a shared command, every copy agrees, and its undo takes it back everywhere`, async () => {
  await shared(p => {
    const done = edit.run(p);
    assert.equal(done.kind, "applied");
    assert.equal(p.deliver(), 1);
    assert.deepEqual(rows(hook.read().app), edit.after(done.id));
    assert.ok(same(hook.read().app, hook.read().peer), "app and peer agree");
    assert.ok(same(p.lateJoiner("app"), hook.read().app), "a late joiner agrees");
    const undone = p.undo();
    assert.deepEqual([undone.ok, undone.effective, undone.label], [true, true, edit.label]);
    assert.equal(p.deliver(), 1);
    assert.deepEqual(rows(hook.read().app), ROWS.map(row => [row.id, row.audioText]));
    assert.ok(same(hook.read().app, hook.read().peer) && same(p.catchUp(), hook.read().app), "after the undo every copy agrees");
  });
});

test("the peer's structural edits answer what the command answers: a split or add of a missing beat and a join of the last beat change nothing", async () => {
  await shared(p => {
    const before = snapshot();
    assert.deepEqual([p.split("gone", 1), p.add("gone"), p.join("r2")], [{ kind: "noop", id: null }, { kind: "noop", id: null }, "noop"]);
    assert.equal(queued(), 0);
    assert.equal(snapshot(), before);
  });
});

test("a refused update of each kind: throwing while applying and a zero-length struct are refused as invalid, and queue-full while the app's buffer is open; nothing changes, the marks pair, and the declined update is sent again after the commit", async () => {
  await shared(p => {
    const before = snapshot();
    const decoded = kind => Y.decodeUpdate(bytesOf(p.refusedUpdate(kind))).structs.map(struct => struct.length);
    assert.deepEqual(decoded("throws"), [1], "the throwing update decodes, with a positive length, so only applying it fails");
    assert.ok(decoded("zero-length").includes(0), "the zero-length update carries a struct of length zero");
    hook.timing(true);
    for (const kind of ["throws", "zero-length"]) {
      performance.clearMarks();
      assert.deepEqual(p.inject(p.refusedUpdate(kind)), { ok: false, reason: "invalid-update" }, kind);
      assert.deepEqual(p.inject(p.refusedUpdate(kind), "peer"), { ok: false, reason: "invalid-update" }, kind + " to the peer");
      assert.deepEqual(of(spans(marks()), "live-apply"), [], kind + " marks no live apply");
      assert.equal(snapshot(), before, kind + " changes no copy");
    }
    assert.throws(() => p.refusedUpdate("queue-full"), /There is no refused update of that kind/);
    assert.throws(() => p.refusedUpdate("late"), /There is no refused update of that kind/);
    const full = p.refusedUpdate("queue-full", "r2");
    assert.equal(queued(), 0, "the refused update is handed out, not queued");
    assert.ok(hook.read().peer.rows[1].audioText.startsWith(FILLED), "the peer wrote it");
    const app = JSON.stringify(hook.read().app);
    const commit = appTypes("!");
    performance.clearMarks();
    assert.deepEqual(p.inject(full), { ok: false, reason: "queue-full" }, "an open buffer refuses an update larger than its queue");
    assert.deepEqual(spans(marks()).map(span => span.seam), ["receive"], "a queue-full refusal is decided before the trial");
    assert.equal(JSON.stringify(hook.read().app), app, "the refusal wrote nothing");
    performance.clearMarks();
    commit();
    assert.equal(of(spans(marks()), "live-apply").length, 1, "the catch-up after the commit marks one live apply");
    assert.equal(hook.read().app.rows[0].audioText, "Hello!");
    assert.ok(hook.read().app.rows[1].audioText.startsWith(FILLED), "after the commit the declined change arrives again as one catch-up update");
    assert.equal(p.deliver(), 1);
    assert.ok(same(hook.read().app, hook.read().peer), "app and peer agree");
  });
});

test("catch-up delivery: held peer updates reach the app as one state-vector update with one trial, the same result as delivering each", async () => {
  await shared(p => {
    p.hold();
    for (const [at, letter] of [[0, "A"], [1, "B"], [2, "C"]]) assert.equal(p.type("r1", at, letter).kind, "applied");
    assert.equal(queued(), 3);
    hook.timing(true);
    performance.clearMarks();
    assert.equal(p.deliver("catch-up", "app"), 3);
    assert.equal(marks().filter(name => name === "measure:trial:start").length, 1, "one update, one trial");
    assert.deepEqual(rows(hook.read().app), [["r1", "ABCHello"], ["r2", "World"]]);
    assert.ok(same(hook.read().app, hook.read().peer));
    assert.deepEqual(p.appliedUpdates().map(entry => entry.to), ["app", "app", "app"]);
    assert.equal(queued(), 0);
    assert.equal(p.deliver("catch-up"), 0, "nothing held, nothing sent");
  });
});

test("replay: on an injected clock, after k intervals exactly k captured updates have reached the app, none early and none after a stop, while the app's own updates stay held for the peer", async () => {
  await shared(async p => {
    p.hold();
    for (const [at, letter] of [[0, "A"], [1, "B"], [2, "C"]]) assert.equal(p.type("r2", at, letter).kind, "applied");
    const captured = p.capture();
    assert.equal(captured.length, 3);
    assert.ok(captured.every(update => typeof update === "string"));
    assert.equal(queued(), 0);
    assert.deepEqual(rows(hook.read().app), ROWS.map(row => [row.id, row.audioText]), "capturing delivers nothing");
    p.release();
    const clock = fakeClock();
    assert.equal(p.replay(captured, 40, "app", clock), 3);
    assert.deepEqual(p.replayed(), { delivered: 0, refused: 0, recovered: 0, remaining: 3, running: true });
    appTypes("!")();
    await new Promise(resolve => { queueMicrotask(resolve); });
    assert.equal(queued(), 1, "the app's typing waits for the peer, so the peer does no work during the replay");
    for (let k = 1; k <= 3; k++) {
      clock.advance(39);
      assert.equal(p.replayed().delivered, k - 1, `nothing early before interval ${k}`);
      clock.advance(1);
      assert.deepEqual(p.replayed(), { delivered: k, refused: 0, recovered: 0, remaining: 3 - k, running: k < 3 }, `interval ${k}`);
    }
    assert.equal(clock.pending(), 0);
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello!"], ["r2", "ABCWorld"]]);
    assert.equal(p.deliver(), 1);
    assert.ok(same(hook.read().app, hook.read().peer));
    p.hold();
    assert.equal(p.type("r2", 0, "D").kind, "applied");
    assert.equal(p.type("r2", 0, "E").kind, "applied");
    const second = p.capture(), stopping = fakeClock();
    assert.equal(p.replay(second.map(bytesOf), 40, "app", stopping), 2);
    stopping.advance(40);
    p.stopReplay();
    assert.equal(stopping.pending(), 0, "a stop withdraws the pending interval");
    stopping.advance(400);
    assert.deepEqual(p.replayed(), { delivered: 1, refused: 0, recovered: 0, remaining: 1, running: false }, "a stopped replay delivers nothing more");
    assert.equal(hook.read().app.rows[1].audioText, "DABCWorld");
  });
});

test("replay recovery: a queue-full update refused at its deadline is taken back from the bytes already emitted when the app commits, and the next update keeps its own deadline", async () => {
  await shared(p => {
    p.hold();
    const full = p.refusedUpdate("queue-full", "r2");
    assert.equal(p.type("r1", 0, "FUTURE").kind, "applied");
    const later = p.capture();
    assert.equal(later.length, 1);
    const commit = appTypes("!"), clock = fakeClock();
    assert.equal(p.replay([full, ...later], 2000, "app", clock), 2);
    clock.advance(2000);
    assert.deepEqual(p.replayed(), { delivered: 0, refused: 1, recovered: 0, remaining: 1, running: true }, "the open buffer refuses the first update");
    clock.advance(1000);
    commit();
    assert.deepEqual(p.replayed(), { delivered: 0, refused: 1, recovered: 1, remaining: 1, running: true }, "the commit takes back the refused bytes");
    assert.equal(hook.read().app.rows[0].audioText, "Hello!", "nothing from the future arrives early");
    assert.ok(hook.read().app.rows[1].audioText.startsWith(FILLED));
    clock.advance(999);
    assert.equal(hook.read().app.rows[0].audioText, "Hello!");
    clock.advance(1);
    assert.deepEqual(p.replayed(), { delivered: 1, refused: 1, recovered: 1, remaining: 0, running: false });
    assert.equal(hook.read().app.rows[0].audioText, "FUTUREHello!", "the second update arrives at its own deadline");
    assert.equal(p.deliver(), 1);
    assert.ok(same(hook.read().app, hook.read().peer), "app and peer agree");
  });
});

test("entry from an encoded shared state: the app enters the stored document with its history and recovery, the undo stack starts empty, and an empty, incomplete, truncated or unreadable state is refused with the standalone script unchanged", async () => {
  let stored = null, expected = null, recovery = null, partial = null, gapped = null;
  await shared(p => {
    const handle = sharedSessionParts().handle, start = encodeSharedState(handle), vector = encodeSharedStateVector(handle);
    assert.equal(p.type("r1", 5, "?").kind, "applied");
    assert.equal(p.deliver(), 1);
    const middle = encodeSharedStateVector(handle);
    assert.equal(p.type("r1", 6, "?").kind, "applied");
    assert.equal(p.deliver(), 1);
    gapped = Y.mergeUpdates([start, encodeSharedUpdate(handle, middle)]);
    assert.equal(p.erase("r1", 6, 7), "applied");
    assert.equal(p.remove("r2"), "applied");
    assert.equal(p.deliver(), 2);
    stored = encodeSharedState(sharedSessionParts().handle);
    partial = encodeSharedUpdate(sharedSessionParts().handle, vector);
    expected = rows(hook.read().app);
    recovery = p.recoveryEntries("app");
    assert.equal(recovery.length, 1);
  });
  const other = [{ id: "o1", audioText: "Other", visualText: "" }];
  for (const [name, bytes] of [["an empty state", new Uint8Array([0, 0])], ["an update without its base", partial],
    ["a script with pending structs", gapped],
    ["a truncated state", stored.slice(0, Math.floor(stored.length / 2))], ["unreadable bytes", new Uint8Array([1, 2, 3])]]) {
    script(other);
    const standalone = JSON.stringify(hook.read());
    assert.deepEqual(await hook.enterFrom(bytes), { ok: false, reason: "enter-failed" }, name);
    assert.equal(sharedSession(), false, name);
    assert.equal(JSON.stringify(hook.read()), standalone, name + " leaves the standalone script unchanged");
    assert.deepEqual(hook.leave(), { ok: false, reason: "not-shared" }, name);
  }
  script(other);
  let text = "";
  for (const byte of stored) text += String.fromCharCode(byte);
  assert.deepEqual(await hook.enterFrom(btoa(text)), { ok: true });
  try {
    assert.deepEqual(rows(hook.read().app), expected, "the stored document, not the open standalone script");
    assert.deepEqual(hook.peer.recoveryEntries("app"), recovery, "the stored recovery entry comes with it");
    assert.ok(same(hook.read().app, hook.read().peer), "the peer copies the stored state");
    assert.deepEqual(sharedSessionParts().undo.sizes(), { undo: 0, redo: 0, dropped: 0 }, "the undo stack starts empty");
    assert.equal(hook.peer.type("r1", 0, "N").kind, "applied");
    assert.equal(hook.peer.deliver(), 1);
    assert.equal(hook.read().app.rows[0].audioText, "NHello?");
  } finally { if (sharedSession()) hook.leave(); }
});
