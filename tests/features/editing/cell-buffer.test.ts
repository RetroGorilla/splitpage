import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferedSplit } from "./cell-buffer-support.ts";
import { bufferOracles } from "../../collab/oracles/buffer-oracles.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";

const NBSP = " ";

function trailingNbsp(cell: HTMLElement): void {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
  assert.ok(last && last.data.endsWith(" "));
  last.data = last.data.slice(0, -1) + NBSP;
}

for (const order of ["D1", "D3"] as const) test(`rule 55, T03 Split native whitespace (${order}): the space the browser shows as U+00A0 beside the Backspace target keeps its identity, the next Backspace deletes it, and someone else's bold survives`, () => {
  const page = bufferedSplit();
  const bold = () => {
    page.h.execute("B", [page.h.mark("B", "R1", page.h.range("B", "R1", 0, 3), { kind: "b", value: true })]);
    page.h.queue.deliverFrom("B", order);
  };
  try {
    assert.equal(page.key("R1", 6, 7, "deleteContentBackward", null), true);
    assert.equal(page.key("R1", 5, 6, "deleteContentBackward", null), true);
    assert.equal(page.key("R1", 4, 5, "deleteContentBackward", null, { shown: trailingNbsp, ...order === "D3" ? { during: bold } : {} }), true);
    assert.equal(page.painted.text("R1"), "the ");
    assert.equal(page.key("R1", 3, 4, "deleteContentBackward", null), true);
    assert.deepEqual(page.caret(), { from: 3, to: 3 });
    if (order === "D1") bold();
    page.h.check(order, { ...bufferOracles.T03.expected, carets: {} });
    assert.deepEqual([page.reports, page.missing, page.recovered], [[], [], []]);
    assert.deepEqual(page.a.executed.map(command => command.base), [1, 2, 3, order === "D3" ? 5 : 4]);
  } finally { page.close(); }
});

test("a commit keeps the focused cell element and refreshes the cell's painted base before the next keystroke", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    const cell = page.cell("R1");
    assert.equal(page.key("R1", 2, 2, "insertText", "Z"), true);
    assert.equal(page.cell("R1"), cell);
    assert.deepEqual([page.painted.base("R1")?.text, page.painted.base("R1")?.revision], ["abZ", 2]);
    assert.equal(page.key("R1", 3, 3, "insertText", "Y"), true);
    assert.deepEqual([page.text(), page.cell("R1"), page.caret(), page.reports], ["abZY", cell, { from: 4, to: 4 }, []]);
  } finally { page.close(); }
});

test("rule 27 in the Split view: a cell without a painted base refuses the native input, counts once and repaints; the next input works", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }], false);
  try {
    page.ready();
    assert.equal(page.key("R1", 2, 2, "insertText", "Z"), false);
    assert.deepEqual([page.missing, page.text(), page.cell("R1").textContent], [["R1"], "ab", "ab"]);
    assert.equal(page.key("R1", 2, 2, "insertText", "Z"), true);
    assert.deepEqual([page.text(), page.missing, page.reports], ["abZ", ["R1"], []]);
  } finally { page.close(); }
});

test("rule 55, R2: native input in the visual column is refused with no write and no hold, and an unreported change there is put back", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    assert.equal(page.key("R1", 0, 0, "insertText", "Z", { field: "visualText" }), false);
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-visual-column" }]);
    const visual = page.cell("R1", "visualText"), before = visual.innerHTML;
    visual.append("typed");
    visual.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "typed" }));
    assert.deepEqual([visual.innerHTML, page.a.executed.length, [...collabState(page.h.a).ingress.holds]], [before, 0, []]);
  } finally { page.close(); }
});

test("rule 55, R5: native formatting in a narration cell is refused after settling, and nothing is written", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "formatBold" });
    assert.equal(page.cell("R1").dispatchEvent(event), false);
    assert.deepEqual([page.reports, page.a.executed.length, page.text()], [[{ kind: "rejected", reason: "buffer-unsupported-input" }], 0, "ab"]);
  } finally { page.close(); }
});

test("a received update is held while a cell is composing and applied when the composition commits", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    const cell = page.cell("R1");
    page.key("R1", 2, 2, "insertText", "c");
    cell.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    assert.equal(page.key("R1", 3, 3, "insertCompositionText", "x", { during: () => {
      page.h.execute("B", [page.h.insertion("B", "R1", page.h.point("B", "R1", 0, "after"), "Q")], ["b1"]);
      page.h.queue.deliverFrom("B", "D3");
    } }), true);
    assert.deepEqual([page.text(), [...collabState(page.h.a).ingress.holds]], ["abc", ["buffer"]]);
    cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "x" }));
    assert.deepEqual([page.text(), page.cell("R1").textContent, page.caret(), page.reports], ["Qabcx", "Qabcx", { from: 5, to: 5 }, []]);
  } finally { page.close(); }
});
