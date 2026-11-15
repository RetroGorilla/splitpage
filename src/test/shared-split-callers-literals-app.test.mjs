import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { addRow, addRowAndFocus, armDelete, splitRowFieldCore } from "../bootstrap/wiring/rows.ts";
import { cycleRowStatus, setBeatFilmed } from "../bootstrap/wiring/beat-status.ts";
import { promptForTarget, promptForWpm } from "../bootstrap/wiring/title-chrome.ts";
import { sharedStructureCommands, sharedValueCommands } from "../bootstrap/wiring/ports/shared-commands.ts";
import { setBeatLength } from "../features/rows/read-time.ts";
import { setTargetLength } from "../features/rundown/target.ts";
import { deleteSelectedBeats, selectBeats } from "../features/clipboard/beat-select.ts";
import { collabState } from "../adapters/collab/state.ts";
import { ORDERS, SOURCE, START, agree, base, caret, cellOf, clearWarnings, deliverInsideNextPublication, enter, exchange, minted, press, remoteCreate,
  remoteInsert, remoteSplit, row, select, toastHost, type, undoOnce, warnings } from "./_shared-split-callers.mjs";

const served = [
  { name: "Ctrl+Enter adds a beat and focuses the minted beat", act: () => {
    select(cellOf("audioText"), 3);
    assert.equal(press(cellOf("audioText"), "Enter", { ctrlKey: true }), true);
  }, after: id => base([row("r1", "abcdef", "ZWide"), row(id, ""), row("r2", "Other"), row("r3", "Third")]),
  caret: id => [id, "audioText", 0], undone: null },
  { name: "the add bar adds a beat at the end and returns the minted id", act: f => {
    const id = addRow(null);
    assert.match(id, f.beat);
    return id;
  }, after: id => base([...START(), row(id, "")]), undone: null },
  { name: "Alt+Enter splits the narration at the caret and focuses the minted beat", act: () => {
    select(cellOf("audioText"), 3);
    assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
  }, after: id => base([row("r1", "abc", "ZWide"), row(id, "def"), row("r2", "Other"), row("r3", "Third")]),
  caret: id => [id, "audioText", 0], undone: base() },
  { name: "Alt+Enter over selected narration splits and removes the selection in one change", act: () => {
    select(cellOf("audioText"), 2, 4);
    assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
  }, after: id => base([row("r1", "ab", "ZWide"), row(id, "ef"), row("r2", "Other"), row("r3", "Third")]),
  caret: id => [id, "audioText", 0], undone: base() },
  { name: "the split core returns the minted id", act: f => {
    select(cellOf("audioText"), 1);
    const split = splitRowFieldCore(cellOf("audioText"));
    assert.equal(split?.field, "audioText"); assert.match(split?.id, f.beat);
    return split.id;
  }, after: id => base([row("r1", "a", "ZWide"), row(id, "bcdef"), row("r2", "Other"), row("r3", "Third")]), undone: base() },
  { name: "the delete button removes a beat", act: () => {
    const button = document.createElement("button");
    armDelete(button, "r2"); armDelete(button, "r2");
  }, after: () => base([row("r1", "abcdef", "ZWide"), row("r3", "Third")]), undone: base() },
  { name: "deleting selected beats removes them", act: () => {
    selectBeats("r2", "r2"); assert.doesNotThrow(deleteSelectedBeats);
    assert.deepEqual([...toastHost().querySelectorAll(".toast")].map(el => [el.firstChild.textContent, el.querySelector(".toast-action")]),
      [["1 beat deleted.", null]]);
  }, after: () => base([row("r1", "abcdef", "ZWide"), row("r3", "Third")]), undone: base() },
  { name: "cutting selected beats removes them", act: () => {
    selectBeats("r2", "r2");
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const data = new Map(), cut = new window.Event("cut", { bubbles: true, cancelable: true });
    Object.defineProperty(cut, "clipboardData", { value: { setData: (type, value) => { data.set(type, value); }, getData: type => data.get(type) ?? "" } });
    document.body.dispatchEvent(cut);
    assert.equal(cut.defaultPrevented, true); assert.match(data.get("text/plain"), /Other/);
    assert.deepEqual([...toastHost().querySelectorAll(".toast")].map(el => [el.firstChild.textContent, el.querySelector(".toast-action")]),
      [["1 beat cut — paste them with Ctrl+V.", null]]);
  }, after: () => base([row("r1", "abcdef", "ZWide"), row("r3", "Third")]), undone: base() },
  { name: "the scene menu removes a scene header and keeps its beats", act: () => {
    const remove = document.querySelector('.section-header[data-section-id="s1"] [data-section-action="remove"]');
    assert.ok(remove); remove.click();
  }, after: () => ({ ...base(), sections: [] }), undone: base() },
  { name: "the status chip cycles a beat's status", act: () => { cycleRowStatus("r1"); },
    after: () => base(START(row("r1", "abcdef", "ZWide", "ready"))), undone: base() },
  { name: "the Filmed box films a beat", act: () => { setBeatFilmed("r1", true); },
    after: () => base(START(row("r1", "abcdef", "ZWide", "shot"))), undone: base() },
  { name: "the read-time box sets a beat length", act: () => { assert.equal(setBeatLength("r1", 42), true); },
    after: () => base(START(row("r1", "abcdef", "ZWide", "todo", 42))), undone: base() },
  { name: "the rundown sets the target length", act: () => { assert.equal(setTargetLength(90), true); },
    after: () => base(START(), { target: 90 }), undone: base() },
  { name: "the title popover sets the target length", act: () => {
    promptForTarget();
    const input = document.getElementById("target-input"); assert.ok(input);
    input.value = "2:00";
    assert.equal(press(input, "Enter"), true);
  }, after: () => base(START(), { target: 120 }), undone: base() },
  { name: "the title popover sets words per minute", act: () => {
    promptForWpm();
    const input = document.getElementById("wpm-input"); assert.ok(input);
    input.value = "180";
    document.getElementById("wpm-save").click();
  }, after: () => base(START(), { wpm: 180 }), undone: base() }
];

for (const literal of served) for (const order of ORDERS) test(`C7 caller literal: ${literal.name}, ${order}`, async () => {
  const f = await enter();
  try {
    const sizes = f.parts.undo.sizes();
    remoteInsert(f.peer, "r1", "visualText", 0, "Z");
    const returned = literal.act(f);
    exchange(f, order);
    const id = literal.after.length ? minted(f) : null;
    if (returned !== undefined) assert.equal(returned, id);
    agree(f, literal.after(id));
    if (literal.caret) assert.deepEqual(caret(), literal.caret(id));
    assert.deepEqual(warnings(), []);
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 1 });
    if (literal.undone === null) return;
    undoOnce(f, order);
    assert.deepEqual(warnings(), []);
    agree(f, literal.undone);
  } finally { f.close(); }
});

const concurrent = [
  { name: "Ctrl+Enter", peerClient: 1, remote: peer => { remoteCreate(peer, "r1", "r2", "before"); }, act: () => {
    select(cellOf("audioText"), 3);
    assert.equal(press(cellOf("audioText"), "Enter", { ctrlKey: true }), true);
  }, rows: (local, peer) => [row("r1", "abcdef", "Wide"), row(peer, ""), row(local, "x"), row("r2", "Other"), row("r3", "Third")] },
  { name: "Alt+Enter in the narration", peerClient: 1, remote: peer => { remoteSplit(peer, "r1", 3); }, act: () => {
    select(cellOf("audioText"), 3);
    assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
  }, rows: (local, peer) => [row("r1", "abc", "Wide"), row(peer, ""), row(local, "xdef"), row("r2", "Other"), row("r3", "Third")] },
  { name: "the add bar", peerClient: 0xfffffffe, remote: peer => { remoteCreate(peer, "r3", null, "after"); }, act: () => { addRowAndFocus(null, "audioText"); },
    rows: (local, peer) => [row("r1", "abcdef", "Wide"), row("r2", "Other"), row("r3", "Third"), row(local, "x"), row(peer, "")] }
];

for (const literal of concurrent) for (const order of ORDERS) test(`C7 created id: ${literal.name} focuses the beat it created while a peer's beat in the same gap arrives inside the command, ${order}`, async () => {
  const f = await enter();
  try {
    collabState(f.peer).doc.clientID = literal.peerClient;
    literal.remote(f.peer);
    const delivered = deliverInsideNextPublication(f);
    literal.act();
    delivered();
    const created = currentDocument().rows.map(r => r.id).filter(id => !["r1", "r2", "r3"].includes(id));
    const local = created.find(id => f.beat.test(id)), peer = created.find(id => !f.beat.test(id));
    assert.ok(local && peer, created.join(","));
    assert.deepEqual(caret(), [local, "audioText", 0]);
    assert.equal(document.activeElement, cellOf("audioText", local));
    assert.equal(type(cellOf("audioText", local), "x"), true);
    exchange(f, order);
    agree(f, base(literal.rows(local, peer)));
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

const splitR1 = () => {
  select(cellOf("audioText"), 3);
  assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
};
const successive = [
  { name: "two status clicks", first: () => { cycleRowStatus("r1"); }, second: () => { cycleRowStatus("r1"); }, undoes: 2,
    once: () => base(START(row("r1", "abcdef", "ZWide", "ready"))), twice: () => base(START(row("r1", "abcdef", "ZWide", "shot"))) },
  { name: "the add bar twice", first: () => { addRow(null); }, second: () => { addRow(null); }, undoes: 0,
    once: ([a]) => base([...START(), row(a, "")]), twice: ([a, b]) => base([...START(), row(a, ""), row(b, "")]) },
  { name: "the add bar then Alt+Enter", first: () => { addRow(null); }, second: splitR1, undoes: 1,
    once: ([a]) => base([...START(), row(a, "")]),
    twice: ([a, b]) => base([row("r1", "abc", "ZWide"), row(b, "def"), row("r2", "Other"), row("r3", "Third"), row(a, "")]) },
  { name: "a status click then Alt+Enter", first: () => { cycleRowStatus("r1"); }, second: splitR1, undoes: 2,
    once: () => base(START(row("r1", "abcdef", "ZWide", "ready"))),
    twice: ([b]) => base([row("r1", "abc", "ZWide", "ready"), row(b, "def"), row("r2", "Other"), row("r3", "Third")]) }
];

for (const literal of successive) for (const order of ORDERS) test(`C7 successive commands: ${literal.name} send two shared commands with two undo steps, ${order}`, async () => {
  const f = await enter();
  try {
    const sizes = f.parts.undo.sizes();
    const fresh = known => currentDocument().rows.map(r => r.id).filter(id => !["r1", "r2", "r3", ...known].includes(id));
    remoteInsert(f.peer, "r1", "visualText", 0, "Z");
    literal.first(); exchange(f, order);
    const first = fresh([]);
    agree(f, literal.once(first));
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 1 });
    literal.second(); exchange(f, order);
    const both = [...first, ...fresh(first)];
    for (const id of both) assert.match(id, f.beat);
    agree(f, literal.twice(both));
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 2 });
    assert.deepEqual(warnings(), []);
    if (literal.undoes < 1) return;
    undoOnce(f, order);
    agree(f, literal.once(first));
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 1, redo: sizes.redo + 1 });
    if (literal.undoes < 2) return;
    undoOnce(f, order);
    agree(f, base());
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, redo: sizes.redo + 2 });
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

test("C7 callers: the read-time button's own Ctrl+Z steps the shared owner", async () => {
  const f = await enter();
  try {
    assert.equal(setBeatLength("r1", 42), true);
    const button = document.querySelector('#rows .row-read[data-id="r1"]'); assert.ok(button);
    button.focus();
    assert.equal(press(button, "z", { ctrlKey: true }), true);
    exchange(f, "local-first");
    agree(f, base([row("r1", "abcdef", "Wide"), row("r2", "Other"), row("r3", "Third")]));
    assert.deepEqual(f.parts.undo.sizes(), { undo: 0, redo: 1, dropped: 0 });
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

test("C7 standalone: the callers read no shared ports and keep the list-local ids", () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  assert.equal(sharedSession(), false);
  assert.equal(sharedStructureCommands.ports(), null);
  assert.equal(sharedValueCommands.ports(), null);
  clearWarnings();
  select(cellOf("audioText"), 3);
  assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
  const split = currentDocument().rows[1];
  assert.match(split.id, /^r/); assert.doesNotMatch(split.id, /^structure_/);
  assert.deepEqual(currentDocument().rows.map(r => [r.id, r.audioText]), [["r1", "abc"], [split.id, "def"], ["r2", "Other"], ["r3", "Third"]]);
  assert.deepEqual(caret(), [split.id, "audioText", 0]);
  const added = addRow(null);
  assert.equal(currentDocument().rows.at(-1).id, added);
  assert.doesNotMatch(added, /^structure_/);
  select(cellOf("visualText"), 2);
  assert.equal(press(cellOf("visualText"), "Enter", { altKey: true }), true);
  assert.deepEqual(currentDocument().rows.slice(0, 2).map(r => r.visualText), ["Wi", "de"]);
  assert.equal(currentDocument().rows[1].id === split.id, false);
  cycleRowStatus("r1"); setBeatFilmed("r2", true);
  assert.deepEqual(currentDocument().rows.filter(r => r.id === "r1" || r.id === "r2").map(r => r.status), ["ready", "shot"]);
  assert.equal(setBeatLength("r1", 42), true); assert.equal(setTargetLength(90), true);
  assert.deepEqual([currentDocument().rows[0].lengthSeconds, currentDocument().targetSeconds], [42, 90]);
  assert.deepEqual(warnings(), []);
});
