import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedRename } from "./scene-name-support.ts";
import type { RenamePage } from "./scene-name-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { ref } from "../../adapters/collab/executor-support.ts";
import * as Y from "yjs";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSplits, sharedCommand } from "../../application/session/shared-session-support.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { edgeInput } from "../edge-input.ts";
import type { EdgeInput } from "../edge-input.ts";

const HEADING = { owner: ref("H1"), segment: ref("h:H1"), field: "heading" as const };

function remote(page: RenamePage, at: number, text: string): void {
  const right = createSharedAnchor(page.h.b, HEADING, at, "after"); assert.ok(right);
  page.h.execute("B", [page.h.command("B", { kind: "text-insert", target: HEADING, at: { left: null, right, affinity: "before" }, content: [{ value: text, marks: [] }] })]);
}

function names(handle: SharedDocumentHandle): unknown {
  const sections = projectSharedDocumentWithRecovery(handle).document.sections;
  return Array.isArray(sections) ? sections.map((scene: { readonly name: string }) => scene.name) : [];
}

function copies(page: RenamePage, expected: readonly string[]): void {
  page.h.queue.flush("dup"); page.h.join();
  for (const handle of [page.h.a, page.h.b, page.h.c]) assert.deepEqual(names(handle), expected);
}

function written(page: RenamePage) {
  return page.a.executed.map(command => command.operations.map(op => op.kind === "text-insert" ? { kind: op.kind, target: op.target, content: op.content }
    : op.kind === "text-delete" ? { kind: op.kind, target: op.target, observed: op.observed.length } : { kind: op.kind }));
}

const holds = (page: RenamePage) => [...collabState(page.h.a).ingress.holds];
const caret = (page: RenamePage) => [page.input().selectionStart, page.input().selectionEnd];
const selected = (page: RenamePage) => [page.input().selectionStart, page.input().selectionEnd, page.input().selectionDirection];
const TARGET = { owner: "H1", segment: "H1", field: "heading" };
const inserted = (value: string) => ({ kind: "text-insert", target: TARGET, content: [{ value, marks: [] }] });
const UNSUPPORTED = [{ kind: "rejected", reason: "buffer-unsupported-input" }];

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

test("Split rename typing settles each keystroke as heading text operations, with no rename command", () => {
  const page = sharedRename();
  try {
    const input = page.open();
    assert.deepEqual([input.value, document.activeElement === input], ["Scene", true]);
    page.edge.select(5);
    assert.equal(page.edge.type("X"), true);
    page.edge.select(1, 3);
    assert.equal(page.edge.backspace(), true);
    assert.deepEqual([page.stored(), input.value, caret(page), page.reports, page.commands], ["SneX", "SneX", [1, 1], [], []]);
    assert.deepEqual(written(page), [[inserted("X")], [{ kind: "text-delete", target: TARGET, observed: 2 }]]);
    assert.deepEqual(page.a.described.map(described => [described?.label, described?.typing, described?.selection !== null]), [["typing", "X", true], ["typing", "", true]]);
    assert.deepEqual([holds(page), page.shownDepth(), page.repaints()], [[], 0, 0]);
    copies(page, ["SneX"]);
  } finally { page.close(); }
});

test("Split rename: a collapsed Backspace is left to the input and adopted at its input event", () => {
  const page = sharedRename();
  try {
    page.open();
    page.edge.select(5);
    assert.equal(page.edge.backspace(), true);
    assert.deepEqual([page.stored(), page.input().value, page.reports], ["Scen", "Scen", []]);
    assert.deepEqual(written(page), [[{ kind: "text-delete", target: TARGET, observed: 1 }]]);
  } finally { page.close(); }
});

test("Split rename: a remote change arriving mid-keystroke is held until it settles, then both land", () => {
  const page = sharedRename();
  try {
    page.open();
    page.edge.select(5);
    page.edge.type("X", () => {
      remote(page, 0, "!");
      page.h.queue.deliverFrom("B", "D1");
      assert.equal(page.stored(), "Scene");
    });
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports], ["!SceneX", "!SceneX", [7, 7], []]);
    copies(page, ["!SceneX"]);
  } finally { page.close(); }
});

test("Split rename: a remote change arriving mid-composition is held until compositionend, then both land", () => {
  const page = sharedRename();
  try {
    const input = page.open();
    page.edge.select(3);
    page.edge.imeSet("漢");
    remote(page, 0, "!");
    page.h.queue.flush("dup");
    assert.deepEqual([page.stored(), input.value, page.a.executed.length], ["Scene", "Sce漢ne", 0]);
    page.edge.imeCommit("漢");
    assert.deepEqual([page.stored(), input.value, caret(page), page.reports], ["!Sce漢ne", "!Sce漢ne", [5, 5], []]);
    copies(page, ["!Sce漢ne"]);
  } finally { page.close(); }
});

test("Split rename: a remote change between keystrokes rebuilds the header; the form moves into it and keeps the caret", () => {
  const page = sharedRename();
  try {
    const input = page.open();
    page.edge.select(5);
    page.edge.type("X");
    remote(page, 0, "!");
    page.h.queue.flush("dup");
    page.paint();
    const header = page.rows.querySelector('.section-header[data-section-id="H1"]');
    assert.deepEqual([header?.querySelector(".section-name")?.textContent, header?.contains(input), document.activeElement === input], ["!SceneX", true, true]);
    assert.deepEqual([input.value, caret(page)], ["!SceneX", [7, 7]]);
    page.edge.type("Y");
    assert.deepEqual([page.stored(), input.value, page.reports], ["!SceneXY", "!SceneXY", []]);
    copies(page, ["!SceneXY"]);
  } finally { page.close(); }
});

test("Split rename: a repaint keeps the caret after the same letter when another writer inserts that letter before it", () => {
  const page = sharedRename("aaaa");
  try {
    page.open();
    page.edge.select(2);
    remote(page, 0, "a");
    page.h.queue.flush("dup");
    page.paint();
    assert.deepEqual([page.input().value, caret(page), page.stored(), page.reports], ["aaaaa", [3, 3], "aaaaa", []]);
    copies(page, ["aaaaa"]);
  } finally { page.close(); }
});

test("Split rename: a repaint keeps the caret between the same letters when another writer adds at both ends", () => {
  const page = sharedRename();
  try {
    page.open();
    page.edge.select(3);
    remote(page, 0, "!");
    remote(page, 6, "?");
    page.h.queue.flush("dup");
    page.paint();
    assert.deepEqual([page.input().value, caret(page), page.stored(), page.reports], ["!Scene?", [4, 4], "!Scene?", []]);
    copies(page, ["!Scene?"]);
  } finally { page.close(); }
});

test("Split rename: a repaint keeps a backward selection backward over the same letters", () => {
  const page = sharedRename();
  try {
    page.open();
    page.edge.select(1, 4, "backward");
    remote(page, 0, "!");
    page.h.queue.flush("dup");
    page.paint();
    assert.deepEqual([page.input().value, selected(page), page.reports], ["!Scene", [2, 5, "backward"], []]);
  } finally { page.close(); }
});

test("Split rename rule 4: a name cleared to nothing stays held, a Shift press keeps it, and the next letter replaces it once", () => {
  const page = sharedRename();
  try {
    page.open();
    page.edge.selectAll();
    assert.equal(page.edge.backspace(), true);
    page.edge.press("Shift");
    assert.deepEqual([page.stored(), page.input().value, page.reports, page.a.executed.length, holds(page)], ["Scene", "", [], 0, ["buffer"]]);
    page.edge.type("N");
    assert.deepEqual([page.stored(), page.input().value, page.reports], ["N", "N", []]);
    assert.deepEqual(written(page), [[inserted("N"), { kind: "text-delete", target: TARGET, observed: 5 }]]);
    copies(page, ["N"]);
  } finally { page.close(); }
});

test("Split rename rule 4: a Backspace that empties a one-letter name is adopted and held, not put back", () => {
  const page = sharedRename("S");
  try {
    page.open();
    page.edge.select(1);
    page.edge.backspace();
    assert.deepEqual([page.stored(), page.input().value, page.reports, holds(page)], ["S", "", [], ["buffer"]]);
  } finally { page.close(); }
});

function emptied(name = "Scene"): RenamePage {
  const page = sharedRename(name);
  page.open();
  page.edge.selectAll();
  page.edge.backspace();
  assert.deepEqual([page.stored(), page.input().value, page.reports, holds(page)], [name, "", [], ["buffer"]]);
  return page;
}

const EMPTY_REPORT = [{ kind: "rejected", reason: "buffer-heading-empty" }];

test("Split rename: a cancelled paste on an already empty held name ends only the existing hold at keyup", () => {
  const page = emptied();
  try {
    page.input().addEventListener("beforeinput", event => { event.preventDefault(); }, { once: true });
    assert.equal(page.edge.paste("Q"), false);
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, written(page), holds(page)],
      ["Scene", "Scene", [0, 0], EMPTY_REPORT, [], []]);
    copies(page, ["Scene"]);
  } finally { page.close(); }
});

test("Split rename rule 4: Enter on a held empty name only ends the hold: the form stays open on the stored name and tells once; Escape then closes it", () => {
  const page = emptied();
  try {
    const input = page.input();
    assert.equal(page.edge.enter(), false);
    assert.deepEqual([input.isConnected, page.stored(), input.value, page.reports, holds(page), page.a.executed.length],
      [true, "Scene", "Scene", EMPTY_REPORT, [], 0]);
    page.edge.press("Escape");
    assert.deepEqual([input.isConnected, page.stored(), page.reports, page.commands], [false, "Scene", EMPTY_REPORT, []]);
    assert.deepEqual([holds(page), page.rows.querySelector(".section-name")?.textContent], [[], "Scene"]);
  } finally { page.close(); }
});

for (const [label, leave] of [
  ["Enter", (page: RenamePage) => { assert.equal(page.edge.enter(), true); }],
  ["Escape", (page: RenamePage) => { page.edge.escape(); }],
  ["moving focus away", () => { document.getElementById("away")?.focus(); }]
] as const) {
  test(label === "Escape" ? "Split rename rule 85: Escape closes the form and restores its opening name as one shared edit"
    : `Split rename: ${label} closes the form over what is already shared, runs no rename command and repaints once`, () => {
    const page = sharedRename();
    try {
      const input = page.open();
      page.edge.select(5);
      page.edge.type("X");
      leave(page);
      const escaped = label === "Escape";
      assert.deepEqual([input.isConnected, page.stored(), page.commands, page.reports, page.repaints()], [false, escaped ? "Scene" : "SceneX", [], [], escaped ? 2 : 1]);
      assert.deepEqual([written(page), page.rows.querySelector(".section-name")?.textContent],
        [escaped ? [[inserted("X")], [inserted("Scene"), { kind: "text-delete", target: TARGET, observed: 6 }]] : [[inserted("X")]], escaped ? "Scene" : "SceneX"]);
      copies(page, [escaped ? "Scene" : "SceneX"]);
    } finally { page.close(); }
  });
}

test("Split rename rule 5: only the keystroke that passes 200 characters is refused; the settled 200 stay", () => {
  const page = sharedRename("a".repeat(199));
  try {
    page.open();
    page.edge.select(199);
    page.edge.type("Y");
    page.edge.type("Z");
    assert.deepEqual([page.stored(), page.input().value], ["a".repeat(199) + "Y", "a".repeat(199) + "Y"]);
    assert.deepEqual([page.reports, page.a.executed.length, holds(page)], [[{ kind: "rejected", reason: "buffer-heading-length" }], 1, []]);
  } finally { page.close(); }
});

test("Split rename rule 5: a letter typed into a full 200-character name is refused, told once, and Enter then closes the form", () => {
  const page = sharedRename("a".repeat(200));
  try {
    const input = page.open();
    assert.equal(input.maxLength, -1);
    page.edge.select(200);
    page.edge.type("Z");
    assert.deepEqual([page.stored(), input.value, caret(page), page.reports, page.a.executed.length, holds(page)],
      ["a".repeat(200), "a".repeat(200), [200, 200], [{ kind: "rejected", reason: "buffer-heading-length" }], 0, []]);
    assert.equal(page.edge.enter(), true);
    assert.deepEqual([input.isConnected, page.reports, page.commands, page.repaints()], [false, [{ kind: "rejected", reason: "buffer-heading-length" }], [], 1]);
    remote(page, 0, "!");
    page.h.queue.flush("dup");
    assert.equal(page.stored(), "!" + "a".repeat(200));
    copies(page, ["!" + "a".repeat(200)]);
  } finally { page.close(); }
});

test("Split rename rule 84: paste after typing inserts at the caret without a refusal", () => {
  const page = sharedRename();
  try {
    const input = page.open();
    page.edge.select(5);
    page.edge.type("X");
    page.edge.select(2);
    assert.equal(page.edge.paste("Q"), true);
    assert.deepEqual([page.stored(), input.value, caret(page), page.reports, written(page)], ["ScQeneX", "ScQeneX", [3, 3], [], [[inserted("X")], [inserted("Q")]]]);
    copies(page, ["ScQeneX"]);
  } finally { page.close(); }
});

test("Split rename rule 85: Ctrl+Z after settled typing uses shared undo and restores the name", () => {
  const page = sharedRename();
  try {
    const input = page.open();
    page.edge.select(5);
    page.edge.type("X");
    assert.equal(page.edge.undo("Scene"), false);
    assert.deepEqual([page.stored(), input.value, caret(page), page.reports, written(page)], ["Scene", "Scene", [5, 5], [], [[inserted("X")]]]);
    copies(page, ["Scene"]);
  } finally { page.close(); }
});

test("Split rename rule 84: paste replaces a selection and its caret follows the pasted letters through another writer's change", () => {
  const page = sharedRename();
  try {
    page.open(); page.edge.select(1, 4);
    page.edge.paste("XY", () => { remote(page, 0, "!"); page.h.queue.deliverFrom("B", "D1"); });
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, written(page)],
      ["!SXYe", "!SXYe", [4, 4], [], [[inserted("XY"), { kind: "text-delete", target: TARGET, observed: 3 }]]]);
    copies(page, ["!SXYe"]);
    page.edge.select(2, 4); assert.equal(page.edge.cut(), true);
    assert.deepEqual([page.edge.copied(), page.stored(), page.input().value, caret(page), page.reports, written(page)],
      ["XY", "!Se", "!Se", [2, 2], [], [[inserted("XY"), { kind: "text-delete", target: TARGET, observed: 3 }], [{ kind: "text-delete", target: TARGET, observed: 2 }]]]);
    copies(page, ["!Se"]);
  } finally { page.close(); }
});

test("Split rename rule 84: cutting the whole name copies it and holds empty; paste writes a new name once without a report", () => {
  const page = sharedRename();
  try {
    page.open(); page.edge.selectAll(); assert.equal(page.edge.cut(), true);
    assert.deepEqual([page.edge.copied(), page.stored(), page.input().value, caret(page), page.reports, written(page), holds(page)],
      ["Scene", "Scene", "", [0, 0], [], [], ["buffer"]]);
    remote(page, 0, "!"); page.h.queue.deliverFrom("B", "D1");
    assert.equal(page.edge.paste("New"), true);
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, written(page), holds(page)],
      ["New!", "New!", [3, 3], [], [[inserted("New"), { kind: "text-delete", target: TARGET, observed: 5 }]], []]);
    copies(page, ["New!"]);
  } finally { page.close(); }
});

test("Split rename rule 84: paste into a held emptied name replaces it instead of consuming the paste", () => {
  const page = emptied();
  try {
    assert.equal(page.edge.paste("Q"), true);
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, written(page), holds(page)],
      ["Q", "Q", [1, 1], [], [[inserted("Q"), { kind: "text-delete", target: TARGET, observed: 5 }]], []]);
    copies(page, ["Q"]);
  } finally { page.close(); }
});

test("Split rename rule 84: paste fits its prefix in 200 UTF-16 units, preserving the suffix and a whole surrogate pair", () => {
  const page = sharedRename("a".repeat(196) + "END");
  try {
    page.open(); page.edge.select(196, 198); page.edge.paste("X😀YZ");
    const expected = "a".repeat(196) + "X😀D";
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, written(page)],
      [expected, expected, [199, 199], [], [[inserted("X😀"), { kind: "text-delete", target: TARGET, observed: 2 }]]]);
    copies(page, [expected]);
  } finally { page.close(); }
});

test("Split rename rule 84: native paste folds line breaks to spaces and retains tabs and control characters", () => {
  const page = sharedRename();
  try {
    page.open(); page.edge.paste("A\r\nB\nC\rD\tE\u0001F\u000bG\u007fH");
    const expected = "A B C D\tE\u0001F\u000bG\u007fH";
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, written(page)],
      [expected, expected, [15, 15], [], [[inserted(expected), { kind: "text-delete", target: TARGET, observed: 5 }]]]);
    copies(page, [expected]);
  } finally { page.close(); }
});

test("Split rename rule 84: paste at a full name writes nothing; drop stays refused", () => {
  const page = sharedRename("a".repeat(200));
  try {
    page.open(); page.edge.select(200); page.edge.paste("XYZ");
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, written(page), holds(page)],
      ["a".repeat(200), "a".repeat(200), [200, 200], [], [], []]);
    assert.equal(page.edge.drop("Z"), false);
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, written(page)],
      ["a".repeat(200), "a".repeat(200), [200, 200], UNSUPPORTED, []]);
    copies(page, ["a".repeat(200)]);
  } finally { page.close(); }
});

test("Split rename rule 8: a typed edge space is stored and shown as typed", () => {
  const page = sharedRename();
  try {
    page.open();
    page.edge.select(5);
    page.edge.type(" ");
    page.edge.type("2");
    page.edge.select(0);
    page.edge.type(" ");
    assert.deepEqual([page.stored(), page.input().value, page.reports], [" Scene 2", " Scene 2", []]);
    copies(page, [" Scene 2"]);
    page.edge.press("Escape");
    assert.equal(page.open().value, "Scene");
  } finally { page.close(); }
});

const HELD_ENDINGS: readonly (readonly [string, (page: RenamePage) => boolean])[] = [
  ["Backspace", page => page.edge.backspace()],
  ["Delete", page => page.edge.delete()],
  ["Enter", page => page.edge.enter()],
  ["Ctrl+X with nothing selected", page => page.edge.cut()],
  ["a drop", page => page.edge.drop("Q")],
  ["Ctrl+Z", page => page.edge.undo("Scene")],
  ["Ctrl+Z with nothing to undo", page => page.edge.undo(null)],
  ["Ctrl+Y with nothing to redo", page => page.edge.redo(null)],
  ["ArrowLeft", page => page.edge.press("ArrowLeft")]
];

for (const [label, act] of HELD_ENDINGS) {
  test(`Split rename rule 4: after emptying a name, ${label} only ends the hold: consumed, the form stays open on the stored name, told once`, () => {
    const page = emptied();
    try {
      assert.equal(act(page), false);
      assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, holds(page), page.a.executed.length, page.commands, page.input().isConnected],
        ["Scene", "Scene", [0, 0], EMPTY_REPORT, [], 0, [], true]);
      copies(page, ["Scene"]);
    } finally { page.close(); }
  });
}

for (const [label, act] of [
  ["Shift alone", (page: RenamePage) => page.edge.press("Shift")],
  ["Control alone", (page: RenamePage) => page.edge.press("Control")]
] as const) {
  test(`Split rename rule 4: ${label} keeps a held empty name held, with no report`, () => {
    const page = emptied();
    try {
      assert.equal(act(page), false);
      assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, holds(page), page.a.executed.length], ["Scene", "", [0, 0], [], ["buffer"], 0]);
    } finally { page.close(); }
  });
}

for (const [label, act, typed] of [
  ["Shift then a letter", (page: RenamePage) => page.edge.shiftType("N"), "N"],
  ["a dead key then a letter", (page: RenamePage) => page.edge.deadType("é"), "é"]
] as const) {
  test(`Split rename rule 4: in a held empty name, ${label} replaces the name once, with no report`, () => {
    const page = emptied();
    try {
      assert.equal(act(page), true);
      assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, holds(page)], [typed, typed, [1, 1], [], []]);
      assert.deepEqual(written(page), [[inserted(typed), { kind: "text-delete", target: TARGET, observed: 5 }]]);
      copies(page, [typed]);
    } finally { page.close(); }
  });
}

test("Split rename rule 4: Backspace held down until the name is gone keeps it held: the repeats change nothing and tell nothing, and the next letter replaces it once", () => {
  const page = sharedRename();
  try {
    page.open();
    page.edge.select(5);
    assert.equal(page.edge.hold("Backspace", 8), 5);
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, holds(page), page.a.executed.length], ["S", "", [0, 0], [], ["buffer"], 4]);
    page.edge.type("N");
    assert.deepEqual([page.stored(), page.input().value, page.reports, holds(page)], ["N", "N", [], []]);
    copies(page, ["N"]);
  } finally { page.close(); }
});

for (const name of ["Backspace", "Delete"] as const) {
  test(`Split rename rule 4: ${name} held down over a selected name keeps it held through the repeats; a fresh ${name} then ends the hold once`, () => {
    const page = sharedRename();
    try {
      page.open();
      page.edge.selectAll();
      assert.equal(page.edge.hold(name, 3), 1);
      assert.deepEqual([page.stored(), page.input().value, page.reports, holds(page), page.a.executed.length], ["Scene", "", [], ["buffer"], 0]);
      assert.equal(name === "Backspace" ? page.edge.backspace() : page.edge.delete(), false);
      assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, holds(page), page.a.executed.length], ["Scene", "Scene", [0, 0], EMPTY_REPORT, [], 0]);
      copies(page, ["Scene"]);
    } finally { page.close(); }
  });
}

test("Split rename rule 4: Backspace held down on a name already held ends the hold once, at its release", () => {
  const page = emptied();
  try {
    assert.equal(page.edge.hold("Backspace", 3), 0);
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, holds(page), page.a.executed.length], ["Scene", "Scene", [0, 0], EMPTY_REPORT, [], 0]);
    copies(page, ["Scene"]);
  } finally { page.close(); }
});

test("Split rename rule 4: a composition begun in a held empty name and committed replaces the name once, with no report", () => {
  const page = emptied();
  try {
    page.edge.imeSet("漢");
    page.edge.imeCommit("漢");
    assert.deepEqual([page.stored(), page.input().value, caret(page), page.reports, holds(page)], ["漢", "漢", [1, 1], [], []]);
    assert.deepEqual(written(page), [[inserted("漢"), { kind: "text-delete", target: TARGET, observed: 5 }]]);
    copies(page, ["漢"]);
  } finally { page.close(); }
});

test("Split rename rule 4: a composition begun in a held empty name and cancelled puts the name back and tells the person once", () => {
  const page = emptied();
  try {
    const input = page.input();
    page.edge.imeSet("x");
    page.edge.imeCancel();
    assert.deepEqual([page.stored(), input.value, page.reports, holds(page), page.a.executed.length, input.isConnected], ["Scene", "Scene", EMPTY_REPORT, [], 0, true]);
    copies(page, ["Scene"]);
  } finally { page.close(); }
});

test("Split rename rule 4: a submit from elsewhere while the name is held empty ends the hold once and closes the form on the stored name", () => {
  const page = emptied();
  try {
    const input = page.input();
    input.form?.requestSubmit();
    assert.deepEqual([input.isConnected, page.stored(), page.reports, holds(page), page.a.executed.length, page.commands], [false, "Scene", EMPTY_REPORT, [], 0, []]);
    assert.equal(page.rows.querySelector(".section-name")?.textContent, "Scene");
  } finally { page.close(); }
});

test("Split rename rule 4: a command admitted while the name is held empty ends the hold once, and the form stays open on the stored name", () => {
  const page = emptied();
  try {
    assert.deepEqual(page.a.session.run(sharedCommand("other", [])), { kind: "noop" });
    assert.deepEqual([page.stored(), page.input().value, page.reports, holds(page), page.input().isConnected], ["Scene", "Scene", EMPTY_REPORT, [], true]);
  } finally { page.close(); }
});

test("Split rename rule 4: moving focus away from a held empty name closes the form, puts the name back and tells once", () => {
  const page = emptied();
  try {
    const input = page.input();
    document.getElementById("away")?.focus();
    assert.deepEqual([input.isConnected, page.stored(), page.reports, holds(page), page.commands], [false, "Scene", EMPTY_REPORT, [], []]);
    assert.equal(page.rows.querySelector(".section-name")?.textContent, "Scene");
  } finally { page.close(); }
});

test("Split rename rule 4: a blur with nowhere to go ends a held empty name's hold: the name is back, told once, and the form stays", async () => {
  const page = emptied();
  try {
    const input = page.input();
    page.edge.blur();
    await Promise.resolve();
    assert.deepEqual([input.isConnected, page.stored(), input.value, page.reports, holds(page), page.a.executed.length, page.commands],
      [true, "Scene", "Scene", EMPTY_REPORT, [], 0, []]);
    copies(page, ["Scene"]);
  } finally { page.close(); }
});

test("Split rename rule 4: a blur the form is refocused from in the same task, as a repaint re-homing it does, keeps the hold", async () => {
  const page = emptied();
  try {
    const input = page.input();
    page.edge.blur();
    input.focus();
    await Promise.resolve();
    assert.deepEqual([page.stored(), input.value, page.reports, holds(page)], ["Scene", "", [], ["buffer"]]);
  } finally { page.close(); }
});

test("Split rename rule 4: the selection leaving the form ends a held empty name's hold: the name is back and told once", () => {
  const page = emptied();
  try {
    const input = page.input(), away = document.getElementById("away"); assert.ok(away);
    page.edge.selectNode(away);
    assert.deepEqual([input.isConnected, page.stored(), input.value, page.reports, holds(page), page.a.executed.length],
      [true, "Scene", "Scene", EMPTY_REPORT, [], 0]);
  } finally { page.close(); }
});

test("Split rename rule 4: a selection change inside the form keeps a held empty name held", () => {
  const page = emptied();
  try {
    const input = page.input(); assert.ok(input.form);
    page.edge.selectNode(input.form);
    assert.deepEqual([page.stored(), input.value, page.reports, holds(page)], ["Scene", "", [], ["buffer"]]);
  } finally { page.close(); }
});

test("Split rename rule 6: name text the document refuses goes to recovery through the existing write, naming the scene", () => {
  const page = sharedRename("Scene", { author: serial => "r" + (15 + serial) });
  registerSplits(page.h.a); registerSharedRemovalHandlers(page.h.a);
  try {
    const input = page.open();
    page.edge.select(3);
    page.edge.imeSet("漢");
    const other = collabState(page.h.a).roots.beats.get("R2"); assert.ok(other instanceof Y.Map);
    transactSharedDocument(page.h.a, "local-command", () => { other.set("lengthSeconds", 7); });
    page.edge.imeCommit("漢");
    assert.deepEqual([page.recovered, page.reports, page.stored(), input.value], [["heading:H1"], [], "Scene", "Scene"]);
    assert.deepEqual(page.a.executed[1]?.operations[0], { kind: "segment-create", id: "r17", by: "Alice", segment: "draft_segment_r17", beat: "draft_r17",
      at: { left: null, right: null, affinity: "after" }, fields: { audioText: "Sce漢ne", bufferSourceOwner: "H1", bufferPaintedBase: 1 } });
    assert.deepEqual(holds(page), []);
  } finally { page.close(); }
});

test("Split rename: a new scene's name form is not opened in a shared session, and the person is told", () => {
  const page = sharedRename();
  try {
    const row = page.rows.querySelector('.row[data-id="R2"]'); assert.ok(row);
    const add = row.appendChild(document.createElement("button")); add.setAttribute("data-action", "add-section"); add.setAttribute("data-id", "R2");
    add.click();
    assert.deepEqual([document.querySelector(".section-rename") !== null, page.commands, page.reports], [false, [], [{ kind: "rejected", reason: "not shared" }]]);
  } finally { page.close(); }
});
