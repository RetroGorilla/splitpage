import { test } from "node:test";
import assert from "node:assert/strict";
import { writerFor } from "./painted-base-support.ts";

const composingKeys: readonly (readonly [string, KeyboardEventInit])[] = [
  ["Enter", { key: "Enter", isComposing: true, keyCode: 229 }],
  ["Enter without event flags", { key: "Enter" }],
  ["Backspace boundary", { key: "Backspace" }],
  ["Delete boundary", { key: "Delete" }],
  ["Tab", { key: "Tab" }],
  ["undo", { key: "z", ctrlKey: true }],
  ["redo shift", { key: "z", ctrlKey: true, shiftKey: true }],
  ["redo y", { key: "y", ctrlKey: true }],
  ["status", { key: "Enter", ctrlKey: true }],
  ["structure", { key: "ArrowDown", altKey: true }],
  ["join", { key: "Backspace", altKey: true }],
  ["heading", { key: "Enter", ctrlKey: true, shiftKey: true }],
  ["format", { key: "b", ctrlKey: true }]
];

for (const [name, key] of composingKeys) {
  test(`standalone composition still excludes the ${name} command and keeps the final replacement`, () => {
    const page = writerFor();
    try {
      page.writer.repaint(); page.writer.caret("a", 5);
      const beat = page.root.querySelector<HTMLElement>('.wr-beat[data-id="a"]'); assert.ok(beat);
      page.root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
      beat.textContent = "Alphan";
      page.root.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", data: "n", bubbles: true }));
      const text = beat.firstChild; assert.ok(text instanceof window.Text);
      const at = name === "Backspace boundary" ? 0 : 6;
      window.getSelection()?.setBaseAndExtent(text, at, text, at);
      page.root.dispatchEvent(new window.KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
      assert.deepEqual(page.doc.rows.map(row => row.audioText), ["Alpha", "Bravo"]);
      beat.textContent = "Alpha你";
      page.root.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", data: "你", bubbles: true }));
      page.root.dispatchEvent(new window.CompositionEvent("compositionend", { data: "你", bubbles: true }));
      assert.deepEqual(page.doc.rows.map(row => row.audioText), ["Alpha你", "Bravo"]);
    } finally { page.writer.dispose(); }
  });
}
