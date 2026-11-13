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
const TARGET = { owner: "H1", segment: "H1", field: "heading" };

test("Split rename typing settles each keystroke as heading text operations, with no rename command", () => {
  const page = sharedRename();
  try {
    const input = page.open();
    assert.deepEqual([input.value, document.activeElement === input], ["Scene", true]);
    assert.equal(page.typed(5, 5, "X"), true);
    assert.equal(page.edit(1, 3, "", "deleteContentBackward", ["SneX", 1]), true);
    assert.deepEqual([page.stored(), input.value, caret(page), page.reports, page.commands], ["SneX", "SneX", [1, 1], [], []]);
    assert.deepEqual(written(page), [
      [{ kind: "text-insert", target: TARGET, content: [{ value: "X", marks: [] }] }],
      [{ kind: "text-delete", target: TARGET, observed: 2 }]
    ]);
    assert.deepEqual([holds(page), page.shownDepth(), page.repaints()], [[], 0, 0]);
    copies(page, ["SneX"]);
  } finally { page.close(); }
});

test("Split rename: a collapsed Backspace is left to the input and adopted at its input event", () => {
  const page = sharedRename();
  try {
    page.open();
    assert.equal(page.backspace(5), true);
    assert.deepEqual([page.stored(), page.input().value, page.reports], ["Scen", "Scen", []]);
    assert.deepEqual(written(page), [[{ kind: "text-delete", target: TARGET, observed: 1 }]]);
  } finally { page.close(); }
});

test("Split rename: a remote change arriving mid-keystroke is held until it settles, then both land", () => {
  const page = sharedRename();
  try {
    page.open();
    page.typed(5, 5, "X", () => {
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
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "Sce漢ne"; input.setSelectionRange(4, 4);
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "漢", isComposing: true }));
    remote(page, 0, "!");
    page.h.queue.flush("dup");
    assert.deepEqual([page.stored(), input.value, page.a.executed.length], ["Scene", "Sce漢ne", 0]);
    input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "漢" }));
    assert.deepEqual([page.stored(), input.value, caret(page), page.reports], ["!Sce漢ne", "!Sce漢ne", [5, 5], []]);
    copies(page, ["!Sce漢ne"]);
  } finally { page.close(); }
});

test("Split rename: a remote change between keystrokes rebuilds the header; the form moves into it and keeps the caret", () => {
  const page = sharedRename();
  try {
    const input = page.open();
    page.typed(5, 5, "X");
    remote(page, 0, "!");
    page.h.queue.flush("dup");
    page.paint();
    const header = page.rows.querySelector('.section-header[data-section-id="H1"]');
    assert.deepEqual([header?.querySelector(".section-name")?.textContent, header?.contains(input), document.activeElement === input], ["!SceneX", true, true]);
    assert.deepEqual([input.value, caret(page)], ["!SceneX", [7, 7]]);
    page.typed(7, 7, "Y");
    assert.deepEqual([page.stored(), input.value, page.reports], ["!SceneXY", "!SceneXY", []]);
    copies(page, ["!SceneXY"]);
  } finally { page.close(); }
});

test("Split rename rule 4: a name cleared to nothing stays held, a Shift press keeps it, and the next letter replaces it once", () => {
  const page = sharedRename();
  try {
    page.open();
    page.edit(0, 5, "", "deleteContentBackward", ["", 0], undefined, "Backspace");
    page.key("Shift");
    assert.deepEqual([page.stored(), page.input().value, page.reports, page.a.executed.length, holds(page)], ["Scene", "", [], 0, ["buffer"]]);
    page.typed(0, 0, "N");
    assert.deepEqual([page.stored(), page.input().value, page.reports], ["N", "N", []]);
    assert.deepEqual(written(page), [[
      { kind: "text-insert", target: TARGET, content: [{ value: "N", marks: [] }] },
      { kind: "text-delete", target: TARGET, observed: 5 }
    ]]);
    copies(page, ["N"]);
  } finally { page.close(); }
});

test("Split rename rule 4: a Backspace that empties a one-letter name is adopted and held, not put back", () => {
  const page = sharedRename("S");
  try {
    page.open();
    page.backspace(1);
    assert.deepEqual([page.stored(), page.input().value, page.reports, holds(page)], ["S", "", [], ["buffer"]]);
  } finally { page.close(); }
});

test("Split rename rule 4: submitting a held empty name keeps the form open and held; Escape puts the name back and tells once", () => {
  const page = sharedRename();
  try {
    const input = page.open();
    page.edit(0, 5, "", "deleteContentBackward", ["", 0], undefined, "Backspace");
    input.form?.requestSubmit();
    assert.deepEqual([input.isConnected, page.stored(), input.value, page.reports, holds(page)], [true, "Scene", "", [], ["buffer"]]);
    page.key("Escape");
    assert.deepEqual([input.isConnected, page.stored(), page.reports, page.commands], [false, "Scene", [{ kind: "rejected", reason: "buffer-heading-empty" }], []]);
    assert.deepEqual([holds(page), page.rows.querySelector(".section-name")?.textContent], [[], "Scene"]);
  } finally { page.close(); }
});

for (const [label, leave] of [
  ["Enter", (page: RenamePage) => { page.input().form?.requestSubmit(); }],
  ["Escape", (page: RenamePage) => { page.key("Escape"); }],
  ["moving focus away", () => { document.getElementById("away")?.focus(); }]
] as const) {
  test(`Split rename: ${label} closes the form over what is already shared, runs no rename command and repaints once`, () => {
    const page = sharedRename();
    try {
      const input = page.open();
      page.typed(5, 5, "X");
      leave(page);
      assert.deepEqual([input.isConnected, page.stored(), page.commands, page.reports, page.repaints()], [false, "SceneX", [], [], 1]);
      assert.equal(page.rows.querySelector(".section-name")?.textContent, "SceneX");
    } finally { page.close(); }
  });
}

test("Split rename rule 5: only the keystroke that passes 200 characters is refused; the settled 200 stay", () => {
  const page = sharedRename("a".repeat(199));
  try {
    page.open();
    page.typed(199, 199, "Y");
    page.typed(200, 200, "Z");
    assert.deepEqual([page.stored(), page.input().value], ["a".repeat(199) + "Y", "a".repeat(199) + "Y"]);
    assert.deepEqual([page.reports, page.a.executed.length, holds(page)], [[{ kind: "rejected", reason: "buffer-heading-length" }], 1, []]);
  } finally { page.close(); }
});

test("Split rename rule 3: paste settles typing first, then is refused and the person is told", () => {
  const page = sharedRename();
  try {
    const input = page.open();
    input.value = "SceneX"; input.setSelectionRange(6, 6);
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "X" }));
    input.setSelectionRange(2, 2);
    const paste = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: "Q" });
    assert.equal(input.dispatchEvent(paste), false);
    assert.deepEqual([page.stored(), input.value, page.reports], ["SceneX", "SceneX", [{ kind: "rejected", reason: "buffer-unsupported-input" }]]);
  } finally { page.close(); }
});

test("Split rename rule 8: a typed edge space is stored and shown as typed", () => {
  const page = sharedRename();
  try {
    page.open();
    page.typed(5, 5, " ");
    page.typed(6, 6, "2");
    page.typed(0, 0, " ");
    assert.deepEqual([page.stored(), page.input().value, page.reports], [" Scene 2", " Scene 2", []]);
    copies(page, [" Scene 2"]);
    page.key("Escape");
    assert.equal(page.open().value, " Scene 2");
  } finally { page.close(); }
});

function emptied(name = "Scene"): RenamePage {
  const page = sharedRename(name);
  page.open();
  page.edit(0, name.length, "", "deleteContentBackward", ["", 0], undefined, "Backspace");
  assert.deepEqual([page.stored(), page.input().value, page.reports, holds(page)], [name, "", [], ["buffer"]]);
  return page;
}

const EMPTY_REPORT = [{ kind: "rejected", reason: "buffer-heading-empty" }];

test("Split rename rule 4: a paste into a held empty name is refused and keeps the hold; the next letter replaces the name once", () => {
  const page = emptied();
  try {
    const paste = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: "Q" });
    assert.equal(page.input().dispatchEvent(paste), false);
    assert.deepEqual([page.stored(), page.input().value, page.reports, holds(page)], ["Scene", "", [{ kind: "rejected", reason: "buffer-unsupported-input" }], ["buffer"]]);
    page.typed(0, 0, "N");
    assert.deepEqual([page.stored(), page.input().value, page.a.executed.length, holds(page)], ["N", "N", 1, []]);
  } finally { page.close(); }
});

for (const [label, cancel] of [
  ["with its text left", (input: HTMLInputElement) => { input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" })); }],
  ["with nothing left", (input: HTMLInputElement) => {
    input.value = ""; input.setSelectionRange(0, 0);
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "", isComposing: true }));
    input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" }));
  }]
] as const) {
  test(`Split rename rule 4: a composition begun in a held empty name and cancelled ${label} puts the name back and tells the person once`, () => {
    const page = emptied();
    try {
      const input = page.input();
      input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
      input.value = "x"; input.setSelectionRange(1, 1);
      input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "x", isComposing: true }));
      cancel(input);
      assert.deepEqual([page.stored(), input.value, page.reports, holds(page), page.a.executed.length], ["Scene", "Scene", EMPTY_REPORT, [], 0]);
      assert.equal(input.isConnected, true);
    } finally { page.close(); }
  });
}

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

test("Split rename rule 6: name text the document refuses goes to recovery through the existing write, naming the scene", () => {
  const page = sharedRename("Scene", { author: serial => "r" + (15 + serial) });
  registerSplits(page.h.a); registerSharedRemovalHandlers(page.h.a);
  try {
    const input = page.open();
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "Sce漢ne"; input.setSelectionRange(4, 4);
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "漢", isComposing: true }));
    const other = collabState(page.h.a).roots.beats.get("R2"); assert.ok(other instanceof Y.Map);
    transactSharedDocument(page.h.a, "local-command", () => { other.set("lengthSeconds", 7); });
    input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "漢" }));
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
    assert.deepEqual([document.querySelector(".section-rename"), page.commands, page.reports], [null, [], [{ kind: "rejected", reason: "not shared" }]]);
  } finally { page.close(); }
});
