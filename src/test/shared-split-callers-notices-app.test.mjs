import { test } from "node:test";
import assert from "node:assert/strict";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { addRow, armDelete, splitRowFieldCore } from "../bootstrap/wiring/rows.ts";
import { cycleRowStatus, setBeatFilmed } from "../bootstrap/wiring/beat-status.ts";
import { promptForTarget, promptForWpm } from "../bootstrap/wiring/title-chrome.ts";
import { sharedStructureCommands, sharedValueCommands } from "../bootstrap/wiring/ports/shared-commands.ts";
import { setBeatLength } from "../features/rows/read-time.ts";
import { setTargetLength } from "../features/rundown/target.ts";
import { deleteSelectedBeats, pasteBeatsAt, selectBeats } from "../features/clipboard/beat-select.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { encodeSharedState } from "../adapters/collab/document.ts";
import { ORDERS, REFUSED, agree, base, cellOf, clearWarnings, copiedBeat, cutBeat, enter, exchange, noticeCalls, ports, press, remoteInsert, row, select,
  setEditRefusal, warnings } from "./_shared-split-callers.mjs";

for (const order of ORDERS) test(`C7 rule 133: Alt+Enter in the visual box is refused by name, warns once and writes nothing, ${order}`, async () => {
  const f = await enter();
  try {
    remoteInsert(f.peer, "r2", "audioText", 0, "Z");
    const before = encodeSharedState(f.parts.handle), sizes = f.parts.undo.sizes();
    select(cellOf("visualText"), 2);
    assert.equal(press(cellOf("visualText"), "Enter", { altKey: true }), true);
    assert.deepEqual(warnings(), [REFUSED]);
    assert.deepEqual(encodeSharedState(f.parts.handle), before);
    assert.deepEqual(f.parts.undo.sizes(), sizes);
    clearWarnings();
    exchange(f, order);
    agree(f, base([row("r1", "abcdef", "Wide"), row("r2", "ZOther"), row("r3", "Third")]));
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

test("C7 callers: a refused structure command reports its reason once even when the visual split is asked twice", async () => {
  const f = await enter();
  try {
    select(cellOf("visualText"), 1);
    assert.equal(splitRowFieldCore(cellOf("visualText")), null);
    assert.deepEqual(warnings(), [REFUSED]);
    clearWarnings();
    assert.equal(splitRowFieldCore(cellOf("visualText")), null);
    assert.deepEqual(warnings(), [REFUSED]);
  } finally { f.close(); }
});

const REFUSABLE = [
  { name: "Ctrl+Enter", act: () => { select(cellOf("audioText"), 3); press(cellOf("audioText"), "Enter", { ctrlKey: true }); } },
  { name: "the add bar", act: () => { addRow(null); } },
  { name: "Alt+Enter", act: () => { select(cellOf("audioText"), 3); press(cellOf("audioText"), "Enter", { altKey: true }); } },
  { name: "the split core", act: () => { select(cellOf("audioText"), 1); splitRowFieldCore(cellOf("audioText")); } },
  { name: "the armed delete button", arrange: () => { const button = document.createElement("button"); armDelete(button, "r2"); return button; },
    act: button => { armDelete(button, "r2"); } },
  { name: "deleting selected beats", act: () => { selectBeats("r2", "r2"); deleteSelectedBeats(); } },
  { name: "cutting selected beats", act: () => { cutBeat("r2"); } },
  { name: "the scene menu", asksCapability: true, act: () => { document.querySelector('.section-header[data-section-id="s1"] [data-section-action="remove"]').click(); } },
  { name: "the status chip", act: () => { cycleRowStatus("r1"); } },
  { name: "the Filmed box", act: () => { setBeatFilmed("r1", true); } },
  { name: "the read-time box", act: () => { setBeatLength("r1", 42); } },
  { name: "the rundown target", act: () => { setTargetLength(90); } },
  { name: "the title popover target", act: () => {
    promptForTarget();
    const input = document.getElementById("target-input"); input.value = "2:00"; press(input, "Enter");
  } },
  { name: "the title popover words per minute", act: () => {
    promptForWpm();
    document.getElementById("wpm-input").value = "180"; document.getElementById("wpm-save").click();
  } },
  { name: "a visual split", named: true, arrange: () => { select(cellOf("visualText"), 1); }, act: () => { splitRowFieldCore(cellOf("visualText")); } },
  { name: "a beat paste", named: true, arrange: () => copiedBeat("r2"), act: data => { pasteBeatsAt(data, cellOf("audioText", "r3")); } }
];
const LISTENER_NOTICE = "Held by the listener.";
const REFUSAL_SOURCES = [
  { name: "the switch at decide time", capability: true, arm: () => { setEditRefusal("Editing is paused for this test."); return () => { setEditRefusal(null); }; }, notice: REFUSED },
  { name: "a listener that announces its refusal", arm: f => f.parts.session.beforeCommand(() => { notices.show(LISTENER_NOTICE, "warn"); return "announced"; }),
    notice: LISTENER_NOTICE },
  { name: "a listener that refuses silently", arm: f => f.parts.session.beforeCommand(() => false), notice: REFUSED },
  { name: "a session hold", arm: f => f.parts.session.hold("held-for-test"), notice: REFUSED },
  { name: "the command's own name", named: true, arm: () => () => {}, notice: REFUSED }
];

for (const caller of REFUSABLE) for (const source of REFUSAL_SOURCES) if (caller.named || !source.named) {
  const gated = caller.asksCapability && source.capability;
  test(`C7 one refusal, one notice: ${caller.name} ${gated ? "asks the capability itself and stays silent when" : "refused by"} ${source.name}`, async () => {
    const f = await enter();
    let stop = () => {};
    try {
      const data = caller.arrange?.();
      stop = source.arm(f);
      clearWarnings(); noticeCalls.length = 0;
      const before = encodeSharedState(f.parts.handle), sizes = f.parts.undo.sizes(), standalone = undoOwner().sizes();
      caller.act(data);
      assert.deepEqual(noticeCalls, gated ? [] : [[source.notice, "warn"]]);
      assert.deepEqual([encodeSharedState(f.parts.handle), f.parts.undo.sizes(), undoOwner().sizes()], [before, sizes, standalone]);
    } finally { stop(); setEditRefusal(null); clearWarnings(); document.querySelectorAll(".title-popover").forEach(el => el.remove()); f.close(); }
  });
}

test("C7 one refusal, one notice: Ctrl+Enter after a faulted typing buffer announces its own refusal", async () => {
  const f = await enter();
  try {
    const cell = cellOf("audioText");
    select(cell, 3);
    const range = document.getSelection().getRangeAt(0).cloneRange();
    const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertReplacementText", data: "X" });
    Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
    cell.dispatchEvent(before);
    const start = posToDom(cell, 0);
    start.node.parentNode.insertBefore(document.createTextNode("X"), start.offset === 0 ? start.node : start.node.nextSibling);
    clearWarnings(); noticeCalls.length = 0;
    cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: "X" }));
    assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
    noticeCalls.length = 0;
    const encoded = encodeSharedState(f.parts.handle), sizes = f.parts.undo.sizes();
    assert.equal(press(cell, "Enter", { ctrlKey: true }), true);
    assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
    assert.deepEqual([encodeSharedState(f.parts.handle), f.parts.undo.sizes()], [encoded, sizes]);
  } finally { clearWarnings(); ports.bindings.abandon(); f.close(); }
});

test("C7 callers: a refusal the session already announced is not announced again", () => {
  clearWarnings();
  for (const commands of [sharedStructureCommands, sharedValueCommands]) {
    commands.refused({ kind: "rejected", reason: "not shared", notified: true });
    commands.refused({ kind: "noop" });
    assert.deepEqual(warnings(), []);
    commands.refused({ kind: "rejected", reason: "not shared" });
    assert.deepEqual(warnings(), [REFUSED]);
    clearWarnings();
  }
});

for (const order of ORDERS) test(`C7 rule 73: pasting copied beats has no shared port, warns once and writes nothing, ${order}`, async () => {
  const f = await enter();
  try {
    remoteInsert(f.peer, "r1", "visualText", 0, "Z");
    selectBeats("r2", "r2");
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const data = new Map(), copy = new window.Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (type, value) => { data.set(type, value); }, getData: type => data.get(type) ?? "" } });
    document.body.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, true);
    clearWarnings(); noticeCalls.length = 0;
    const before = encodeSharedState(f.parts.handle), sizes = f.parts.undo.sizes(), standalone = undoOwner().sizes();
    assert.doesNotThrow(() => { assert.equal(pasteBeatsAt({ getData: type => data.get(type) ?? "" }, cellOf("audioText", "r3")), true); });
    assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
    assert.deepEqual(warnings(), [REFUSED]);
    assert.deepEqual(encodeSharedState(f.parts.handle), before);
    assert.deepEqual(f.parts.undo.sizes(), sizes);
    assert.deepEqual(undoOwner().sizes(), standalone);
    clearWarnings();
    exchange(f, order);
    agree(f, base());
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});
