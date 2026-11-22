import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeInput } from "./edge-input.ts";
import type { EdgeInput } from "./edge-input.ts";

type Recorded = readonly [string, string | null, boolean];

const EDGE_SEQUENCES: readonly {
  readonly label: string;
  readonly value: string;
  readonly max?: number;
  readonly act: (edge: EdgeInput) => unknown;
  readonly events: readonly Recorded[];
  readonly after: readonly [string, number, number];
}[] = [
  { label: "a letter", value: "", act: edge => edge.type("Z"), after: ["Z", 1, 1],
    events: [["keydown", "Z", true], ["keypress", "Z", true], ["beforeinput", "insertText", true], ["input", "insertText", false], ["keyup", "Z", true]] },
  { label: "a letter into a full maxlength", value: "a".repeat(200), max: 200, act: edge => edge.type("Z"), after: ["a".repeat(200), 200, 200],
    events: [["keydown", "Z", true], ["keypress", "Z", true], ["beforeinput", "insertText", true], ["keyup", "Z", true]] },
  { label: "Enter in a form", value: "", act: edge => edge.enter(), after: ["", 0, 0],
    events: [["keydown", "Enter", true], ["keypress", "Enter", true], ["beforeinput", "insertLineBreak", true], ["submit", null, true], ["keyup", "Enter", true]] },
  { label: "Backspace in an empty input", value: "", act: edge => edge.backspace(), after: ["", 0, 0],
    events: [["keydown", "Backspace", true], ["beforeinput", "deleteContentBackward", true], ["keyup", "Backspace", true]] },
  { label: "Delete in an empty input", value: "", act: edge => edge.delete(), after: ["", 0, 0],
    events: [["keydown", "Delete", true], ["beforeinput", "deleteContentForward", true], ["keyup", "Delete", true]] },
  { label: "Backspace held down past the start", value: "ab", act: edge => edge.hold("Backspace", 3), after: ["", 0, 0],
    events: [["keydown", "Backspace", true], ["beforeinput", "deleteContentBackward", true], ["input", "deleteContentBackward", false],
      ["keydown", "Backspace repeat", true], ["beforeinput", "deleteContentBackward", true], ["input", "deleteContentBackward", false],
      ["keydown", "Backspace repeat", true], ["beforeinput", "deleteContentBackward", true],
      ["keydown", "Backspace repeat", true], ["beforeinput", "deleteContentBackward", true], ["keyup", "Backspace", true]] },
  { label: "Ctrl+X with nothing selected", value: "", act: edge => edge.cut(), after: ["", 0, 0],
    events: [["keydown", "x", true], ["cut", null, true], ["keyup", "x", true]] },
  { label: "Ctrl+V", value: "", act: edge => edge.paste("Q"), after: ["Q", 1, 1],
    events: [["keydown", "v", true], ["paste", null, true], ["beforeinput", "insertFromPaste", true], ["input", "insertFromPaste", false], ["keyup", "v", true]] },
  { label: "empty Ctrl+V at a caret", value: "Draft", act: edge => { edge.select(2); edge.paste(""); }, after: ["Draft", 2, 2],
    events: [["keydown", "v", true], ["paste", null, true], ["beforeinput", "insertFromPaste", true], ["input", "insertFromPaste", false], ["keyup", "v", true]] },
  { label: "empty Ctrl+V over a selection", value: "Draft", act: edge => { edge.select(1, 4); edge.paste(""); }, after: ["Dt", 1, 1],
    events: [["keydown", "v", true], ["paste", null, true], ["beforeinput", "insertFromPaste", true], ["input", "insertFromPaste", false], ["keyup", "v", true]] },
  { label: "Ctrl+V at a surrogate boundary with maxlength", value: "aaaaaaaZ", max: 10,
    act: edge => { edge.select(7); edge.paste("X😀Q"); }, after: ["aaaaaaaXZ", 8, 8],
    events: [["keydown", "v", true], ["paste", null, true], ["beforeinput", "insertFromPaste", true], ["input", "insertFromPaste", false], ["keyup", "v", true]] },
  { label: "Ctrl+X over a selection", value: "abcdef", act: edge => { edge.select(1, 4); edge.cut(); }, after: ["aef", 1, 1],
    events: [["keydown", "x", true], ["cut", null, true], ["beforeinput", "deleteByCut", true], ["input", "deleteByCut", false], ["keyup", "x", true]] },
  { label: "Ctrl+Z with native history", value: "aef", act: edge => edge.undo("aXYef", [1, 3]), after: ["aXYef", 1, 3],
    events: [["keydown", "z", true], ["beforeinput", "historyUndo", true], ["input", "historyUndo", false], ["keyup", "z", true]] },
  { label: "Ctrl+Y with native history", value: "aXYef", act: edge => edge.redo("aef", [1, 1]), after: ["aef", 1, 1],
    events: [["keydown", "y", true], ["beforeinput", "historyRedo", true], ["input", "historyRedo", false], ["keyup", "y", true]] },
  { label: "Escape", value: "Scene", act: edge => edge.press("Escape"), after: ["Scene", 5, 5],
    events: [["keydown", "Escape", true], ["keyup", "Escape", true]] },
  { label: "a drop", value: "", act: edge => edge.drop("Q"), after: ["Q", 0, 1],
    events: [["drop", null, true], ["beforeinput", "insertFromDrop", true], ["input", "insertFromDrop", false]] },
  { label: "Ctrl+Y with nothing to redo", value: "", act: edge => edge.redo(null), after: ["", 0, 0],
    events: [["keydown", "y", true], ["keyup", "y", true]] },
  { label: "a composition committed", value: "", act: edge => { edge.imeSet("漢"); edge.imeCommit("漢"); }, after: ["漢", 1, 1],
    events: [["compositionstart", "", true], ["compositionupdate", "漢", true], ["beforeinput", "insertCompositionText", false], ["input", "insertCompositionText", false],
      ["compositionupdate", "漢", true], ["beforeinput", "insertCompositionText", false], ["input", "insertCompositionText", false], ["compositionend", "漢", true]] },
  { label: "a composition cancelled", value: "", act: edge => { edge.imeSet("漢"); edge.imeCancel(); }, after: ["", 0, 0],
    events: [["compositionstart", "", true], ["compositionupdate", "漢", true], ["beforeinput", "insertCompositionText", false], ["input", "insertCompositionText", false],
      ["compositionupdate", "", true], ["beforeinput", "insertCompositionText", false], ["input", "insertCompositionText", false], ["compositionend", "", true]] }
];

const RECORDED_TYPES = ["keydown", "keypress", "beforeinput", "input", "keyup", "cut", "paste", "drop", "submit", "compositionstart", "compositionupdate", "compositionend"];

for (const sequence of EDGE_SEQUENCES) {
  test(`Edge input helpers: ${sequence.label} dispatches the sequence Edge sends to a plain input`, () => {
    document.body.innerHTML = '<form><input></form>';
    const input = document.querySelector("input"); assert.ok(input);
    input.value = sequence.value;
    if (sequence.max !== undefined) input.maxLength = sequence.max;
    input.form?.addEventListener("submit", event => { event.preventDefault(); });
    input.focus(); input.setSelectionRange(sequence.value.length, sequence.value.length);
    const events: Recorded[] = [];
    for (const type of RECORDED_TYPES) {
      (type === "submit" ? input.form : input)?.addEventListener(type, event => {
        const detail = event instanceof window.KeyboardEvent ? event.key + (event.repeat ? " repeat" : "") : event instanceof window.InputEvent ? event.inputType
          : event instanceof window.CompositionEvent ? event.data : null;
        events.push([event.type, detail, event.cancelable]);
      });
    }
    try {
      sequence.act(edgeInput(() => input));
      assert.deepEqual(events, sequence.events);
      assert.deepEqual([input.value, input.selectionStart, input.selectionEnd], sequence.after);
    } finally { document.body.innerHTML = ""; }
  });
}
