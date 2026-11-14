import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferedSplit } from "./cell-buffer-support.ts";
import { bufferOracles } from "../../collab/oracles/buffer-oracles.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { setCellSelection } from "../../../src/features/common/cell-selection.ts";

const NBSP = "\u00a0";

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
    assert.deepEqual(page.a.described.map(described => [described?.label, described?.typing, described?.selection !== null]), [["typing", "Z", true], ["typing", "Y", true]]);
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

test("9e (supersedes rule 55, R2): native input in the visual column commits through the binding, and an unreported change there is adopted", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    assert.equal(page.key("R1", 0, 0, "insertText", "Z", { field: "visualText" }), true);
    const visual = page.cell("R1", "visualText");
    visual.append("typed");
    visual.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "typed" }));
    assert.deepEqual([page.a.session.read(doc => doc?.rows[0]?.visualText), page.reports, [...collabState(page.h.a).ingress.holds]], ["Ztyped", [], []]);
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

function composing(page: ReturnType<typeof bufferedSplit>, rowId: string, at: number, data: string): HTMLElement {
  const cell = page.cell(rowId); cell.focus(); setCellSelection(cell, at);
  cell.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
  assert.equal(page.key(rowId, at, at, "insertCompositionText", data), true);
  return cell;
}

test("a cell changed outside the binding is checked before a received update paints it: the change is reported and the cell shows the document", () => {
  const page = bufferedSplit([{ id: "R1", text: "abc" }]);
  try {
    page.cell("R1").append("X");
    page.h.execute("B", [page.h.insertion("B", "R1", page.h.point("B", "R1", 0, "after"), "Q")], ["b1"]);
    page.h.queue.deliverFrom("B", "D1");
    assert.deepEqual([page.reports, page.text(), page.cell("R1").textContent], [[{ kind: "rejected", reason: "buffer-unavailable" }], "Qabc", "Qabc"]);
  } finally { page.close(); }
});

test("9e (supersedes rule 55, R2): a visual cell changed with no input event is adopted into its own field at the next native event in a narration cell, and that key works", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    page.cell("R1", "visualText").append("typed");
    assert.equal(page.key("R1", 2, 2, "insertText", "Z"), true);
    assert.deepEqual([page.a.session.read(doc => doc?.rows[0]?.visualText), page.text(), page.reports], ["typed", "abZ", []]);
  } finally { page.close(); }
});

test("9e (supersedes rule 55, R2): a composition in a visual cell commits once when it ends", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    const visual = page.cell("R1", "visualText"); visual.focus(); setCellSelection(visual, 0);
    visual.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    assert.equal(page.key("R1", 0, 0, "insertCompositionText", "x", { field: "visualText" }), true);
    assert.equal(page.key("R1", 0, 1, "insertCompositionText", "xy", { field: "visualText" }), true);
    assert.equal(page.a.executed.length, 0);
    visual.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "xy" }));
    assert.deepEqual([page.a.session.read(doc => doc?.rows[0]?.visualText), page.reports, page.a.executed.length], ["xy", [], 1]);
  } finally { page.close(); }
});

test("a second narration cell changed outside the binding is adopted into its own beat at the next native event", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }, { id: "R2", text: "next" }]);
  try {
    page.cell("R2").append("Z");
    assert.equal(page.key("R1", 2, 2, "insertText", "Y"), true);
    assert.deepEqual([page.text("R2"), page.text("R1"), page.reports], ["nextZ", "abY", []]);
  } finally { page.close(); }
});

test("a second narration cell changed outside the binding is put back while another cell's edit is open", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }, { id: "R2", text: "next" }]);
  try {
    const cell = composing(page, "R1", 2, "x");
    page.cell("R2").append("Z");
    cell.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "y", keyCode: 229, isComposing: true }));
    assert.deepEqual([page.cell("R2").textContent, page.text("R2"), page.reports], ["next", "next", [{ kind: "rejected", reason: "buffer-pending" }]]);
    cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "x" }));
    assert.deepEqual([page.text("R1"), page.text("R2")], ["abx", "next"]);
  } finally { page.close(); }
});

test("with a composition pending, Ctrl+B, Enter, paste, cut and drop each keep the composed text, report the refusal and write nothing", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    const cell = composing(page, "R1", 2, "x");
    const events = [
      new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "formatBold" }),
      new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertParagraph" }),
      ...["paste", "cut", "drop"].map(type => new window.Event(type, { bubbles: true, cancelable: true }))
    ];
    assert.deepEqual(events.map(event => cell.dispatchEvent(event)), [false, false, false, false, false]);
    assert.deepEqual(page.reports, Array.from({ length: 5 }, () => ({ kind: "rejected", reason: "buffer-composition" })));
    assert.deepEqual([cell.textContent, page.text(), page.a.executed.length], ["abx", "ab", 0]);
    cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "x" }));
    assert.deepEqual([page.text(), page.a.executed.length], ["abx", 1]);
  } finally { page.close(); }
});

test("focus leaving a cell during a composition keeps the composition: nothing is settled, written or reported", () => {
  const page = bufferedSplit([{ id: "R1", text: "ab" }]);
  try {
    const cell = composing(page, "R1", 2, "x");
    cell.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    assert.deepEqual([page.reports, page.a.executed.length, [...collabState(page.h.a).ingress.holds], cell.textContent], [[], 0, ["buffer"], "abx"]);
    cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "x" }));
    assert.deepEqual([page.text(), page.reports], ["abx", []]);
  } finally { page.close(); }
});
