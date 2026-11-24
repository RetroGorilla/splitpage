import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { adoptReplacement, currentCapabilities, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const peer = hook.nativePeer;
const wait = (ms = 45) => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const docTitle = () => document.getElementById("doc-title");
const writerTitle = () => document.getElementById("writer-title");
const emptyInput = () => document.querySelector(".empty-script-input");
const addBarBtn = () => document.querySelector('.add-row-bar [data-action="add-row"]');
const firstRowBtn = () => document.querySelector('.empty-state [data-action="add-row"]');
const audioCell = id => document.querySelector(`#rows .cell-editable[data-id="${id}"][data-field="audioText"]`);

function beforeInput(target, inputType, data = null, options = {}) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data, ...options });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function pressKey(target, key, options = {}) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

async function enter(t, { title = "Draft", rows = [{ id: "r1", audioText: "Alpha" }, { id: "r2", audioText: "Beta" }], writer = false } = {}) {
  adoptReplacement(migrateRows({ schema: 2, title, paragraphsDecided: true, rows }));
  const show = t.mock.method(notices, "show", () => {});
  if (writer) writerControls().openWriter();
  assert.deepEqual(await hook.enter(), { ok: true });
  t.after(() => {
    writerControls().closeWriter();
    if (sharedSession()) assert.deepEqual(hook.leave(), { ok: true });
  });
  return { show, notices: () => show.mock.calls.map(call => call.arguments) };
}

test("shared Split and Writer title editing supports buffered typing, deletes, paste, cut, IME, and undo/redo", async t => {
  const f = await enter(t, { title: "Hello" });
  const input = docTitle();
  input.focus();
  input.setSelectionRange(5, 5);
  assert.equal(beforeInput(input, "insertText", " "), true);
  assert.equal(beforeInput(input, "insertText", "W"), true);
  assert.equal(beforeInput(input, "insertText", "o"), true);
  assert.equal(input.value, "Hello Wo");
  assert.equal(hook.read().app.title, "Hello ");
  await wait();
  assert.equal(hook.read().app.title, "Hello Wo");
  assert.equal(hook.read().peer.title, "Hello Wo");
  assert.equal(document.title.includes("Hello Wo"), true);
  assert.equal(input.selectionStart, 8);

  input.setSelectionRange(0, 0);
  assert.equal(beforeInput(input, "deleteContentBackward"), true);
  input.setSelectionRange(8, 8);
  assert.equal(beforeInput(input, "deleteContentForward"), true);
  assert.deepEqual(f.notices(), []);

  assert.equal(beforeInput(input, "deleteContentBackward"), true);
  await wait();
  assert.equal(hook.read().app.title, "Hello W");
  assert.equal(hook.read().peer.title, "Hello W");

  const paste = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { types: ["text/plain"], getData: type => type === "text/plain" ? "orld" : "" } });
  input.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true);
  await tick();
  assert.equal(hook.read().app.title, "Hello World");
  assert.equal(hook.read().peer.title, "Hello World");

  let cutText = "";
  input.setSelectionRange(5, 11);
  const cut = new window.Event("cut", { bubbles: true, cancelable: true });
  Object.defineProperty(cut, "clipboardData", { value: { setData: (_type, value) => { cutText = value; } } });
  input.dispatchEvent(cut);
  assert.equal(cut.defaultPrevented, true);
  assert.equal(cutText, " World");
  await tick();
  assert.equal(hook.read().app.title, "Hello");
  assert.equal(hook.read().peer.title, "Hello");

  assert.equal(pressKey(input, "z", { ctrlKey: true }), true);
  await tick();
  assert.equal(hook.read().app.title, "Hello World");
  assert.equal(hook.read().peer.title, "Hello World");
  assert.equal(input.value, "Hello World");
  assert.equal(input.selectionStart, 5);
  assert.equal(input.selectionEnd, 11);

  writerControls().openWriter();
  const wt = writerTitle();
  assert.equal(wt.value, "Hello World");
  wt.focus();
  wt.setSelectionRange(11, 11);
  wt.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, cancelable: true, data: "" }));
  wt.value = "Hello World案";
  wt.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data: "案" }));
  assert.equal(hook.read().app.title, "Hello World");
  wt.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" }));
  assert.equal(wt.value, "Hello World");
  assert.equal(hook.read().app.title, "Hello World");

  wt.setSelectionRange(11, 11);
  wt.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, cancelable: true, data: "" }));
  wt.value = "Hello World!";
  wt.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "!" }));
  await tick();
  assert.equal(hook.read().app.title, "Hello World!");
  assert.equal(hook.read().peer.title, "Hello World!");
  assert.equal(docTitle().value, "Hello World!");

  assert.equal(pressKey(wt, "z", { ctrlKey: true }), true);
  await tick();
  assert.equal(hook.read().app.title, "Hello World");
  assert.equal(document.activeElement, wt);
  assert.equal(pressKey(wt, "y", { ctrlKey: true }), true);
  await tick();
  assert.equal(hook.read().app.title, "Hello World!");
  assert.deepEqual(f.notices(), []);
});

test("two copies editing the title at once converge and undo/redo independently", async t => {
  const f = await enter(t, { title: "Pilot" });
  const input = docTitle();
  input.focus();
  input.setSelectionRange(5, 5);
  peer.hold();
  assert.equal(peer.titleType(0, "S1: ").kind, "written");
  assert.equal(beforeInput(input, "insertText", " "), true);
  assert.equal(beforeInput(input, "insertText", "v2"), true);
  await wait();
  assert.equal(hook.read().app.title, "Pilot v2");
  assert.equal(hook.read().peer.title, "S1: Pilot");
  peer.deliver();
  await tick();
  assert.equal(hook.read().app.title, "S1: Pilot v2");
  assert.equal(hook.read().peer.title, "S1: Pilot v2");
  assert.equal(input.value, "S1: Pilot v2");

  assert.equal(pressKey(input, "z", { ctrlKey: true }), true);
  await tick();
  assert.equal(hook.read().app.title, "S1: Pilot ");
  assert.equal(hook.read().peer.title, "S1: Pilot ");

  assert.equal(peer.undoPeer().kind, "written");
  await tick();
  assert.equal(hook.read().app.title, "Pilot ");
  assert.equal(hook.read().peer.title, "Pilot ");

  assert.equal(pressKey(input, "y", { ctrlKey: true }), true);
  await tick();
  assert.equal(hook.read().app.title, "Pilot v2");
  assert.equal(hook.read().peer.title, "Pilot v2");

  assert.equal(peer.redoPeer().kind, "written");
  await tick();
  assert.equal(hook.read().app.title, "S1: Pilot v2");
  assert.equal(hook.read().peer.title, "S1: Pilot v2");
  assert.deepEqual(f.notices(), []);
});

test("shared Split add bar adds after the last visible beat beside peer edits, joins, and removals", async t => {
  const f = await enter(t);
  assert.equal(peer.type("r2", 4, " updated").kind, "written");
  await tick();
  addBarBtn().click();
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Alpha", "Beta updated", ""]);
  assert.deepEqual(hook.read().peer, hook.read().app);
  const firstAdded = hook.read().app.rows[2].id;

  assert.equal(peer.removeBeat(firstAdded).kind, "written");
  assert.equal(peer.removeBeat("r2").kind, "written");
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.id), ["r1"]);

  addBarBtn().click();
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Alpha", ""]);
  assert.deepEqual(hook.read().peer, hook.read().app);

  assert.equal(peer.step("undo").kind, "written");
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.id), ["r1"]);
  assert.deepEqual(hook.read().peer, hook.read().app);

  assert.equal(peer.step("redo").kind, "written");
  await tick();
  assert.equal(hook.read().app.rows.length, 2);
  assert.deepEqual(hook.read().peer, hook.read().app);

  const cell = audioCell("r1");
  cell.focus();
  setCellSelection(cell, 5);
  assert.equal(beforeInput(cell, "insertText", "!"), true);
  peer.hold();
  assert.equal(peer.removeBeat(hook.read().app.rows[1].id).kind, "written");
  assert.equal(peer.removeBeat("r1").kind, "written");
  peer.deliver();
  addBarBtn().click();
  await tick();
  assert.equal(hook.read().app.rows.length, 1);
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.deepEqual(f.notices(), []);
});

test("shared Split add bar after a joined last row keeps its members together", async t => {
  const f = await enter(t);
  assert.equal(peer.join("r2", "r1").kind, "written");
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Alpha Beta"]);
  addBarBtn().click();
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Alpha Beta", ""]);
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.deepEqual(f.notices(), []);
});

test("empty shared Split + Add your first row creates the first beat on both copies with undo and redo", async t => {
  const f = await enter(t, { rows: [] });
  assert.ok(firstRowBtn());
  assert.deepEqual(hook.read().app.rows, []);
  assert.deepEqual(hook.read().peer.rows, []);

  firstRowBtn().click();
  await tick();
  assert.equal(hook.read().app.rows.length, 1);
  assert.equal(hook.read().app.rows[0].audioText, "");
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(firstRowBtn(), null);

  assert.equal(peer.step("undo").kind, "written");
  await tick();
  assert.deepEqual(hook.read().app.rows, []);
  assert.deepEqual(hook.read().peer.rows, []);
  assert.ok(firstRowBtn());

  assert.equal(peer.step("redo").kind, "written");
  await tick();
  assert.equal(hook.read().app.rows.length, 1);
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.deepEqual(f.notices(), []);
});

test("empty shared Split + Add your first row concurrently from both copies converges and undoes independently", async t => {
  const f = await enter(t, { rows: [] });
  peer.hold();
  assert.equal(peer.createFirstBeat("Peer first").kind, "written");
  firstRowBtn().click();
  await tick();
  assert.equal(hook.read().app.rows.length, 1);
  assert.equal(hook.read().peer.rows.length, 1);

  peer.deliver();
  await tick();
  assert.equal(hook.read().app.rows.length, 2);
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(hook.read().app.rows.some(row => row.audioText === "Peer first"), true);
  assert.equal(hook.read().app.rows.some(row => row.audioText === ""), true);

  assert.equal(peer.step("undo").kind, "written");
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Peer first"]);
  assert.deepEqual(hook.read().peer, hook.read().app);

  assert.equal(peer.undoPeer().kind, "written");
  await tick();
  assert.deepEqual(hook.read().app.rows, []);
  assert.deepEqual(hook.read().peer.rows, []);
  assert.ok(firstRowBtn());
  assert.deepEqual(f.notices(), []);
});

test("empty shared Writer IME composition while a peer creates a beat keeps both beats on both copies", async t => {
  const f = await enter(t, { rows: [] });
  writerControls().openWriter();
  const box = emptyInput();
  assert.ok(box);
  box.focus();
  box.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, cancelable: true, data: "" }));
  box.value = "かな";
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data: "かな" }));

  assert.equal(peer.createFirstBeat("Peer arrived").kind, "written");
  await tick();
  assert.deepEqual(hook.read().peer.rows.map(row => row.audioText), ["Peer arrived"]);
  assert.equal(box.closest(".empty-script").hidden, false);

  box.value = "先に書いた";
  box.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "先に書いた" }));
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["先に書いた", "Peer arrived"]);
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(writerControls().writerFlowControl().selection()?.head.offset, "先に書いた".length);

  assert.equal(pressKey(document.getElementById("writer-doc"), "z", { ctrlKey: true }), true);
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Peer arrived"]);
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.deepEqual(f.notices(), []);
});

test("empty shared Writer supports typing, IME composition, peer race, undo/redo, and leaves standalone unchanged", async t => {
  adoptReplacement(migrateRows({ schema: 2, title: "Standalone empty", paragraphsDecided: true, rows: [] }));
  writerControls().openWriter();
  assert.equal(emptyInput(), null);
  writerControls().closeWriter();

  const f = await enter(t, { rows: [], writer: false });
  writerControls().openWriter();
  const box = emptyInput();
  assert.ok(box);
  assert.equal(box.closest(".empty-script").hidden, false);

  box.focus();
  box.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, cancelable: true, data: "" }));
  box.value = "かな";
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data: "かな" }));
  assert.deepEqual(hook.read().app.rows, []);
  assert.deepEqual(hook.leave(), { ok: false, reason: "native-input-pending" });

  box.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" }));
  assert.equal(box.value, "");
  assert.deepEqual(hook.read().app.rows, []);
  assert.equal(box.closest(".empty-script").hidden, false);

  box.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, cancelable: true, data: "" }));
  box.value = "日本語";
  box.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "日本語" }));
  await tick();
  assert.equal(box.closest(".empty-script").hidden, true);
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["日本語"]);
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(writerControls().writerFlowControl().selection()?.head.offset, 3);

  assert.equal(pressKey(document.getElementById("writer-doc"), "z", { ctrlKey: true }), true);
  await tick();
  assert.deepEqual(hook.read().app.rows, []);
  assert.deepEqual(hook.read().peer.rows, []);
  assert.equal(box.closest(".empty-script").hidden, false);

  box.focus();
  assert.equal(pressKey(box, "y", { ctrlKey: true }), true);
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["日本語"]);
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(box.closest(".empty-script").hidden, true);

  assert.equal(pressKey(document.getElementById("writer-doc"), "z", { ctrlKey: true }), true);
  await tick();
  assert.deepEqual(hook.read().app.rows, []);
  assert.equal(box.closest(".empty-script").hidden, false);

  box.focus();
  box.value = "Typed first";
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Typed first" }));
  await tick();
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Typed first"]);
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(writerControls().writerFlowControl().selection()?.head.offset, "Typed first".length);

  assert.deepEqual(hook.leave(), { ok: true });
  assert.equal(emptyInput(), null);
  assert.deepEqual(currentDocument().rows.map(row => row.audioText), ["Typed first"]);
  assert.equal(f.notices().length, 1);
});

test("read-only shared session refuses title edits and disables empty Writer input", async t => {
  adoptReplacement(migrateRows({ schema: 2, title: "Locked", paragraphsDecided: true, rows: [] }),
    createSessionCapabilities("standalone", { edit: () => ({ allowed: false, reason: "locked" }), comment: () => ({ allowed: true }) }));
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enter(), { ok: true });
  t.after(() => {
    writerControls().closeWriter();
    if (sharedSession()) hook.leave();
    adoptReplacement(migrateRows({ schema: 2, title: "Unlocked", paragraphsDecided: true, rows: [{ id: "r1", audioText: "A" }] }),
      createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) }));
  });
  assert.equal(currentCapabilities().edit().allowed, false);
  const input = docTitle();
  input.focus();
  input.setSelectionRange(6, 6);
  assert.equal(beforeInput(input, "insertText", "!"), true);
  assert.equal(hook.read().app.title, "Locked");
  assert.equal(show.mock.callCount(), 1);
  writerControls().openWriter();
  assert.equal(emptyInput().disabled, true);
});
