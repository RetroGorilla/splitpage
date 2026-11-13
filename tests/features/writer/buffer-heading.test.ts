import { test } from "node:test";
import * as Y from "yjs";
import assert from "node:assert/strict";
import { headedWriter, sceneNames } from "./buffer-heading-support.ts";
import type { HeadedPage } from "./buffer-heading-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { registerSplits, sharedCommand } from "../../application/session/shared-session-support.ts";
import { operation, ref } from "../../adapters/collab/executor-support.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { beatPos, headingPos } from "../../../src/core/flow/flow.ts";
import { replaceFlowMatches } from "../../../src/core/flow/find-replace.ts";
import { searchFlow } from "../../../src/features/writer/flow-find.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import type { FlowDoc, FlowRange } from "../../../src/core/flow/flow.ts";
import type { SurfacePorts } from "../../../src/features/writer/flow-surface.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const HEADING = { owner: ref("H1"), segment: ref("h:H1"), field: "heading" as const };
const caret = (offset: number): FlowRange => ({ anchor: headingPos("H1", offset), head: headingPos("H1", offset) });

function remote(page: HeadedPage, at: number, text: string): void {
  const right = createSharedAnchor(page.h.b, HEADING, at, "after"); assert.ok(right);
  page.h.execute("B", [page.h.command("B", { kind: "text-insert", target: HEADING, at: { left: null, right, affinity: "before" }, content: [{ value: text, marks: [] }] })]);
}

function stored(page: HeadedPage): string | undefined {
  return readSharedPaintedText(page.h.a, sharedBufferedTarget(page.h.a, "heading:H1"))?.text;
}

function names(handle: SharedDocumentHandle) {
  return sceneNames(projectSharedDocumentWithRecovery(handle).document);
}

function copies(page: HeadedPage, expected: readonly string[]): void {
  page.h.queue.flush("dup"); page.h.join();
  for (const handle of [page.h.a, page.h.b, page.h.c]) assert.deepEqual(names(handle), expected);
}

function written(page: HeadedPage) {
  return page.a.executed.map(command => command.operations.map(op => op.kind === "text-insert" ? { kind: op.kind, target: op.target, content: op.content }
    : op.kind === "text-delete" ? { kind: op.kind, target: op.target, observed: op.observed.length } : { kind: op.kind }));
}

test("heading typing settles through the buffer as text operations on the heading field, with no beat stamp", () => {
  const page = headedWriter();
  try {
    assert.equal(page.surface.paintedBase("heading:H1")?.text, "Scene");
    assert.equal(page.typeHeading(5, 5, "X"), true);
    assert.equal(page.typeHeading(1, 3, "", "deleteContentBackward"), true);
    assert.deepEqual([page.name(), page.element().textContent, page.reports, page.notices], ["SneX", "SneX", [], []]);
    assert.deepEqual(written(page), [
      [{ kind: "text-insert", target: { owner: "H1", segment: "H1", field: "heading" }, content: [{ value: "X", marks: [] }] }],
      [{ kind: "text-delete", target: { owner: "H1", segment: "H1", field: "heading" }, observed: 2 }]
    ]);
    assert.deepEqual(page.a.executed.map(command => command.base), [1, 2]);
    assert.deepEqual(page.outcomes.map(outcome => outcome.kind === "applied" ? [outcome.changes.cells, outcome.changes.docFields, outcome.changes.derive] : outcome.kind),
      [[[], ["sections"], ["production", "broll"]], [[], ["sections"], ["production", "broll"]]]);
    assert.deepEqual([page.surface.paintedBase("heading:H1")?.text, page.surface.paintedBase("heading:H1")?.revision], ["SneX", 3]);
    assert.deepEqual(page.surface.selection(), caret(1));
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    copies(page, ["SneX"]);
  } finally { page.close(); }
});

test("rule 7: after Enter splits a heading, typing at its end keeps the caret in the heading, not in the beat that now shares its text", () => {
  const holder: { page?: HeadedPage } = {};
  const page = headedWriter("Scene", (name, operation) => {
    const edited = operation(page.a.session.read(doc => { assert.ok(doc); return doc as FlowDoc; }));
    assert.ok(edited && "ops" in edited && edited.ops);
    assert.equal(page.a.session.run(sharedCommand(name, edited.ops)).kind, "applied");
    return null;
  }); holder.page = page;
  registerSplits(page.h.a);
  try {
    page.surface.place(caret(3));
    page.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    page.surface.paint();
    assert.equal(page.name(), "Sce");
    page.typeHeading(3, 3, "Q");
    assert.deepEqual([page.name(), page.element().textContent, page.reports], ["SceQ", "SceQ", []]);
    assert.deepEqual([page.outcomes.at(-1)?.selection, page.surface.selection()], [caret(4), caret(4)]);
  } finally { page.close(); }
});

test("a remote heading change arriving mid-typing is held until the keystroke settles, then both land", () => {
  const page = headedWriter();
  try {
    page.typeHeading(5, 5, "X", "insertText", () => {
      remote(page, 0, "!");
      page.h.queue.deliverFrom("B", "D1");
      assert.deepEqual([page.name(), page.element().textContent], ["Scene", "Scene"]);
    });
    assert.deepEqual([page.name(), page.element().textContent, page.reports], ["!SceneX", "!SceneX", []]);
    assert.deepEqual(page.surface.selection(), caret(7));
    copies(page, ["!SceneX"]);
  } finally { page.close(); }
});

test("a remote heading change arriving mid-composition is held until compositionend, then both land", () => {
  const page = headedWriter();
  try {
    page.startHeading(3);
    page.typeHeading(3, 3, "漢", "insertCompositionText");
    remote(page, 0, "!");
    page.h.queue.flush("dup");
    assert.deepEqual([page.name(), page.element().textContent, page.a.executed.length], ["Scene", "Sce漢ne", 0]);
    page.end("漢");
    assert.deepEqual([page.name(), page.element().textContent, page.reports], ["!Sce漢ne", "!Sce漢ne", []]);
    assert.deepEqual(page.surface.selection(), caret(5));
    copies(page, ["!Sce漢ne"]);
  } finally { page.close(); }
});

test("rule 4: an emptied heading stays held and unsettled, then the next keystroke settles it as one replacement", () => {
  const page = headedWriter();
  try {
    assert.equal(page.typeHeading(0, 5, "", "deleteContentBackward"), true);
    assert.deepEqual([page.name(), page.element().textContent, page.reports, page.a.executed.length], ["Scene", "", [], 0]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
    page.surface.paint();
    assert.equal(page.element().textContent, "");
    page.typeHeading(0, 0, "N");
    assert.deepEqual([page.name(), page.element().textContent, page.reports], ["N", "N", []]);
    assert.deepEqual(written(page), [[
      { kind: "text-insert", target: { owner: "H1", segment: "H1", field: "heading" }, content: [{ value: "N", marks: [] }] },
      { kind: "text-delete", target: { owner: "H1", segment: "H1", field: "heading" }, observed: 5 }
    ]]);
    copies(page, ["N"]);
  } finally { page.close(); }
});

const EMPTY_REPORT = [{ kind: "rejected", reason: "buffer-heading-empty" }];

function emptied(command?: SurfacePorts["commit"]): HeadedPage {
  const page = headedWriter("Scene", command);
  page.typeHeading(0, 5, "", "deleteContentBackward");
  assert.deepEqual([page.name(), page.element().textContent, page.reports, [...collabState(page.h.a).ingress.holds]], ["Scene", "", [], ["buffer"]]);
  return page;
}

function replacedOnce(page: HeadedPage, text: string): void {
  assert.deepEqual([page.name(), page.element().textContent, page.reports, [...collabState(page.h.a).ingress.holds]], [text, text, [], []]);
  assert.equal(page.a.executed.length, 1);
}

function endedOnce(page: HeadedPage): void {
  assert.deepEqual([page.name(), page.element().textContent, page.reports, [...collabState(page.h.a).ingress.holds]], ["Scene", "Scene", EMPTY_REPORT, []]);
}

function commandPort(holder: { page?: HeadedPage }, seen: unknown[]): SurfacePorts["commit"] {
  return (name, operation) => {
    const page = holder.page; assert.ok(page);
    const edited = operation(page.a.session.read(doc => { assert.ok(doc); return doc as FlowDoc; }));
    const outcome = edited && "ops" in edited && edited.ops ? page.a.session.run(sharedCommand(name, edited.ops)) : null;
    seen.push([name, outcome?.kind ?? "nothing"]);
    return outcome?.kind === "rejected" ? { refused: outcome.reason } : null;
  };
}

const HOLDING_KEYS: readonly (readonly [string, (page: HeadedPage) => void, string])[] = [
  ["N", page => { page.typeHeading(0, 0, "N"); }, "N"],
  ["Shift+n", page => {
    assert.equal(page.press({ key: "Shift", shiftKey: true }), true);
    page.typeHeading(0, 0, "N", "insertText", undefined, true, { key: "N", shiftKey: true });
  }, "N"],
  ["a dead key with no modifier, then a letter", page => {
    assert.equal(page.press({ key: "Dead" }), true);
    page.typeHeading(0, 0, "é", "insertText", undefined, true, { key: "é" });
  }, "é"],
  ["a dead key with altKey, then a letter", page => {
    assert.equal(page.press({ key: "Dead", altKey: true }), true);
    page.typeHeading(0, 0, "N", "insertText", undefined, true, { key: "N" });
  }, "N"],
  ["a Control keydown, then a Ctrl+Alt printable key", page => {
    assert.equal(page.press({ key: "Control", ctrlKey: true }), true);
    page.typeHeading(0, 0, "€", "insertText", undefined, true, { key: "€", ctrlKey: true, altKey: true });
  }, "€"],
  ["an AltGraph printable key", page => {
    assert.equal(page.press({ key: "AltGraph", ctrlKey: true, altKey: true }), true);
    page.typeHeading(0, 0, "@", "insertText", undefined, true, { key: "@", ctrlKey: true, altKey: true });
  }, "@"],
  ["Ctrl+B, which runs no command on a heading caret", page => {
    page.press({ key: "b", ctrlKey: true });
    assert.deepEqual([page.reports, [...collabState(page.h.a).ingress.holds]], [[], ["buffer"]]);
    page.typeHeading(0, 0, "N");
  }, "N"],
  ["an arrow that keeps the caret in the heading", page => {
    page.press({ key: "ArrowLeft" });
    page.selectionMoved();
    assert.deepEqual([page.reports, [...collabState(page.h.a).ingress.holds]], [[], ["buffer"]]);
    page.typeHeading(0, 0, "N");
  }, "N"]
];

for (const [label, act, text] of HOLDING_KEYS) {
  test(`rule 4: after emptying a heading, ${label} keeps the hold and the text replaces the name once`, () => {
    const page = emptied();
    try {
      act(page);
      replacedOnce(page, text);
      copies(page, [text]);
    } finally { page.close(); }
  });
}

function clipboard(page: HeadedPage, type: string): boolean {
  page.surface.place(caret(0));
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => "Q", setData: () => {}, types: ["text/plain"] } });
  return page.root.dispatchEvent(event);
}

function heldInput(page: HeadedPage, type: string, reach?: FlowRange): boolean {
  page.surface.place(caret(0));
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type });
  const target = reach ? page.surface.domRange(reach) : null;
  if (target) Object.defineProperty(event, "getTargetRanges", { value: () => [target] });
  return page.root.dispatchEvent(event);
}

const HELD_ENDINGS: readonly (readonly [string, (page: HeadedPage) => boolean])[] = [
  ["Backspace", page => page.typeHeading(0, 0, "", "deleteContentBackward")],
  ["Delete", page => page.typeHeading(0, 0, "", "deleteContentForward")],
  ["Delete with a target range reaching into the next beat", page => heldInput(page, "deleteContentForward", { anchor: headingPos("H1", 0), head: beatPos("R1", 1) })],
  ["paste", page => clipboard(page, "paste")],
  ["cut", page => clipboard(page, "cut")],
  ["drop", page => page.root.dispatchEvent(new window.Event("drop", { bubbles: true, cancelable: true }))],
  ["Enter", page => page.press({ key: "Enter" })],
  ["Ctrl+Z", page => page.press({ key: "z", ctrlKey: true })],
  ["Ctrl+Y", page => page.press({ key: "y", ctrlKey: true })],
  ["historyUndo", page => heldInput(page, "historyUndo")]
];

for (const [label, act] of HELD_ENDINGS) {
  test(`rule 4: after emptying a heading, ${label} only ends the hold: consumed, no command, the name comes back and the person is told once`, () => {
    const seen: unknown[] = [], holder: { page?: HeadedPage } = {};
    const page = emptied(commandPort(holder, seen)); holder.page = page;
    registerSplits(page.h.a); registerSharedRemovalHandlers(page.h.a);
    try {
      assert.equal(act(page), false);
      endedOnce(page);
      assert.deepEqual([stored(page), seen, written(page), page.notices], ["Scene", [], [], []]);
      copies(page, ["Scene"]);
    } finally { page.close(); }
  });
}

test("rule 4: someone else removing a heading while it is held empty lands once the hold ends, and the hold ends as told", () => {
  const page = emptied();
  registerSharedRemovalHandlers(page.h.b);
  try {
    assert.deepEqual(executeSharedOperations(page.h.b, [operation({ kind: "heading-remove", id: "unhead", by: "Bob", heading: "H1",
      observed: [flowBaseReference("H1", "heading", 0, 5)], newBeat: null, nextBeat: null })], { base: readSharedRevision(page.h.b) }), { ok: true });
    page.h.queue.flush("dup");
    assert.deepEqual([page.name(), page.element().textContent, page.reports, [...collabState(page.h.a).ingress.holds]], ["Scene", "", [], ["buffer"]]);
    page.root.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    page.surface.paint();
    assert.deepEqual([page.name(), page.reports, [...collabState(page.h.a).ingress.holds], page.a.executed.length], [undefined, EMPTY_REPORT, [], 0]);
    assert.equal(page.root.querySelector('.wr-heading[data-scene="H1"]'), null);
    copies(page, []);
  } finally { page.close(); }
});

test("rule 4: after emptying a heading, an arrow that takes the caret into the next beat ends the hold once", () => {
  const page = emptied();
  try {
    page.press({ key: "ArrowDown" });
    page.leaveTo(page.beat().firstChild ?? page.beat(), 0);
    endedOnce(page);
    assert.equal(page.a.executed.length, 0);
  } finally { page.close(); }
});

test("rule 4: after emptying a heading, a click in a narration beat of the Writer ends the hold once and keeps the caret there", () => {
  const page = emptied(), proto = window.Range.prototype as unknown as { getBoundingClientRect: () => unknown }, original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
  try {
    assert.equal(page.beat().dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true })), true);
    const text = page.beat().firstChild; assert.ok(text);
    window.getSelection()?.setBaseAndExtent(text, 1, text, 1);
    window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    endedOnce(page);
    assert.deepEqual(page.surface.selection(), { anchor: beatPos("R1", 1), head: beatPos("R1", 1) });
  } finally { proto.getBoundingClientRect = original; page.close(); }
});

test("rule 4: after emptying a heading, a click outside the Writer ends the hold once when the selection leaves", () => {
  const page = emptied(), outside = document.body.appendChild(document.createElement("p"));
  try {
    outside.textContent = "elsewhere";
    const text = outside.firstChild; assert.ok(text);
    page.leaveTo(text, 2);
    endedOnce(page);
    window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    page.root.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    endedOnce(page);
  } finally { outside.remove(); page.close(); }
});

test("rule 4: an emptying change that arrives with no beforeinput is held too, not put back", () => {
  const page = headedWriter();
  try {
    page.element().textContent = "";
    page.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    assert.deepEqual([page.name(), page.element().textContent, page.reports, page.a.executed.length], ["Scene", "", [], 0]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
    page.typeHeading(0, 0, "N");
    assert.deepEqual([page.name(), page.element().textContent, page.reports], ["N", "N", []]);
    assert.deepEqual(written(page), [[
      { kind: "text-insert", target: { owner: "H1", segment: "H1", field: "heading" }, content: [{ value: "N", marks: [] }] },
      { kind: "text-delete", target: { owner: "H1", segment: "H1", field: "heading" }, observed: 5 }
    ]]);
  } finally { page.close(); }
});

test("rule 4: an emptying change first found by a paint is held too", () => {
  const page = headedWriter();
  try {
    page.element().textContent = "";
    page.surface.paint();
    assert.deepEqual([page.name(), page.element().textContent, page.reports, [...collabState(page.h.a).ingress.holds]], ["Scene", "", [], ["buffer"]]);
  } finally { page.close(); }
});

test("rule 4: a composition begun in a heading held empty and cancelled with its text left puts the name back and tells the person once", () => {
  const page = emptied();
  try {
    page.startHeading(0);
    page.typeHeading(0, 0, "x", "insertCompositionText");
    page.end("");
    endedOnce(page);
    assert.equal(page.a.executed.length, 0);
  } finally { page.close(); }
});

test("rule 4: a composition begun in a heading held empty and cancelled with nothing left puts the name back and tells the person once", () => {
  const page = emptied();
  try {
    page.startHeading(0);
    page.typeHeading(0, 0, "x", "insertCompositionText");
    page.typeHeading(0, 1, "", "insertCompositionText");
    page.end("");
    endedOnce(page);
    assert.equal(page.a.executed.length, 0);
  } finally { page.close(); }
});

test("a composition begun over a whole heading name and cancelled with nothing left is a plain cancel: no hold, no report", () => {
  const page = headedWriter();
  try {
    page.startHeading(0, 5);
    page.typeHeading(0, 5, "x", "insertCompositionText");
    page.typeHeading(0, 1, "", "insertCompositionText");
    page.end("");
    assert.deepEqual([page.name(), page.element().textContent, page.reports, [...collabState(page.h.a).ingress.holds], page.a.executed.length],
      ["Scene", "Scene", [], [], 0]);
  } finally { page.close(); }
});

test("rule 8: a typed space at a heading's edge is stored and shown as typed, and typing goes on after it", () => {
  const page = headedWriter();
  try {
    page.typeHeading(5, 5, " ");
    assert.deepEqual([stored(page), page.element().textContent, page.surface.paintedBase("heading:H1")?.text, page.name()], ["Scene ", "Scene ", "Scene ", "Scene "]);
    page.surface.paint();
    assert.equal(page.element().textContent, "Scene ");
    for (const [at, letter] of [[6, "t"], [7, "w"], [8, "o"]] as const) assert.equal(page.typeHeading(at, at, letter), true);
    page.typeHeading(0, 0, " ");
    assert.deepEqual([stored(page), page.element().textContent, page.reports, page.missing], [" Scene two", " Scene two", [], []]);
    assert.deepEqual([page.name(), page.surface.selection()], [" Scene two", caret(1)]);
    copies(page, [" Scene two"]);
  } finally { page.close(); }
});

test("rule 8: a selection reaching a heading's stored edge space survives a repaint", () => {
  const page = headedWriter();
  try {
    page.typeHeading(5, 5, " ");
    const range: FlowRange = { anchor: headingPos("H1", 2), head: headingPos("H1", 6) };
    page.surface.place(range);
    page.surface.repaint();
    assert.deepEqual([page.element().textContent, page.surface.selection()], ["Scene ", range]);
  } finally { page.close(); }
});

const LEADING = " Scene";
const FLOW_PORTS = { cells: (html: string | null | undefined) => fromHtml(html ?? ""), newId: () => "new", hasVisual: () => false,
  operations: { id: "find_command", by: "Alice" } };

function leading(seen: unknown[] = []): HeadedPage {
  const holder: { page?: HeadedPage } = {};
  const page = headedWriter("Scene", commandPort(holder, seen)); holder.page = page;
  registerSplits(page.h.a);
  assert.equal(page.typeHeading(0, 0, " "), true);
  assert.deepEqual([stored(page), page.name(), page.element().textContent], [LEADING, LEADING, LEADING]);
  return page;
}

function held(page: HeadedPage): FlowDoc {
  return page.a.session.read(doc => { assert.ok(doc); return doc as FlowDoc; });
}

test("rule 8: Find in a heading with a leading space highlights exactly the matched characters", () => {
  const page = leading();
  try {
    const { matches } = searchFlow(held(page), "Scene", false, false, FLOW_PORTS);
    const match = matches[0]; assert.ok(match && match.kind !== "visual");
    assert.deepEqual(match.range, { anchor: headingPos("H1", 1), head: headingPos("H1", 6) });
    assert.equal(page.surface.domRange(match.range)?.toString(), "Scene");
  } finally { page.close(); }
});

test("rule 8: Replace in a heading with a leading space writes at the stored offsets", () => {
  const page = leading();
  try {
    const { matches } = searchFlow(held(page), "Scene", false, false, FLOW_PORTS);
    const edited = replaceFlowMatches(held(page), matches.flatMap(match => match.kind === "visual" ? [] : [{ kind: "narration" as const, range: match.range }]), "X", FLOW_PORTS);
    assert.ok(edited && "ops" in edited && edited.ops);
    assert.equal(page.a.session.run(sharedCommand("writer-find-replace", edited.ops)).kind, "applied");
    page.surface.paint();
    assert.deepEqual([stored(page), page.name(), page.element().textContent, page.notices], [" X", " X", " X", []]);
    copies(page, [" X"]);
  } finally { page.close(); }
});

test("rule 8: copying one character of a heading with a leading space copies that character", () => {
  const page = leading();
  try {
    let copied = "";
    page.surface.place({ anchor: headingPos("H1", 1), head: headingPos("H1", 2) });
    const event = new window.Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData: (_type: string, value: string) => { copied = value; }, getData: () => "", types: [] } });
    page.root.dispatchEvent(event);
    assert.deepEqual([copied, stored(page)], ["S", LEADING]);
  } finally { page.close(); }
});

test("rule 8: Enter in the middle of a heading with a leading space splits it at the stored offset", () => {
  const seen: unknown[] = [], page = leading(seen);
  try {
    page.surface.place(caret(3));
    page.press({ key: "Enter" });
    assert.deepEqual([seen, page.notices], [[["enter-heading", "applied"]], []]);
    page.surface.paint();
    assert.deepEqual([stored(page), page.name(), page.element().textContent], [" Sc", " Sc", " Sc"]);
    assert.equal(held(page).rows[0]?.audioText, "ene");
    copies(page, [" Sc"]);
  } finally { page.close(); }
});

test("rule 8: paste into a heading with a leading space lands at the stored offset", () => {
  const seen: unknown[] = [], page = leading(seen);
  try {
    page.surface.place(caret(1));
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "Q", types: ["text/plain"] } }); page.root.dispatchEvent(event);
    assert.deepEqual([seen, page.notices], [[["paste", "applied"]], []]);
    page.surface.paint();
    assert.deepEqual([stored(page), page.name(), page.element().textContent], [" QScene", " QScene", " QScene"]);
    copies(page, [" QScene"]);
  } finally { page.close(); }
});

test("rule 4: someone else's heading change arriving while it is held empty lands after the replacement settles", () => {
  const page = headedWriter();
  try {
    page.typeHeading(0, 5, "", "deleteContentBackward");
    remote(page, 5, "!");
    page.h.queue.flush("dup");
    assert.deepEqual([page.name(), page.element().textContent], ["Scene", ""]);
    page.typeHeading(0, 0, "N");
    assert.deepEqual([page.name(), page.element().textContent, page.reports], ["N!", "N!", []]);
    copies(page, ["N!"]);
  } finally { page.close(); }
});

for (const [label, leave] of [
  ["settlement", (page: HeadedPage) => { assert.equal(page.surface.settle?.(), true); }],
  ["focus loss", (page: HeadedPage) => { page.root.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); }],
  ["a refused command", (page: HeadedPage) => { assert.deepEqual(page.a.session.run(sharedCommand("other", [])), { kind: "noop" }); }]
] as const) {
  test(`rule 4: an edit that ends empty through ${label} puts the stored name back and tells the person once`, () => {
    const page = headedWriter();
    try {
      page.typeHeading(0, 5, "", "deleteContentBackward");
      remote(page, 5, "!");
      page.h.queue.flush("dup");
      leave(page);
      assert.deepEqual([page.name(), page.element().textContent, page.a.executed.length], ["Scene!", "Scene!", 0]);
      assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-heading-empty" }]);
      assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
      copies(page, ["Scene!"]);
    } finally { page.close(); }
  });
}

test("rule 4: unmounting while a heading is held empty puts the stored name back", () => {
  const page = headedWriter();
  try {
    page.typeHeading(0, 5, "", "deleteContentBackward");
    page.surface.dispose();
    assert.deepEqual([page.name(), page.element().textContent, page.reports], ["Scene", "Scene", [{ kind: "rejected", reason: "buffer-heading-empty" }]]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
  } finally { page.close(); }
});

test("rule 5: only the keystroke that passes 200 characters is refused; the settled 200 stay", () => {
  const page = headedWriter("a".repeat(199));
  try {
    page.typeHeading(199, 199, "Y");
    assert.deepEqual([page.name()?.length, page.reports], [200, []]);
    page.typeHeading(200, 200, "Z");
    assert.deepEqual([page.name(), page.element().textContent], ["a".repeat(199) + "Y", "a".repeat(199) + "Y"]);
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-heading-length" }]);
    assert.deepEqual([page.a.executed.length, [...collabState(page.h.a).ingress.holds]], [1, []]);
  } finally { page.close(); }
});

test("rule 6: heading text the document refuses goes to recovery through the existing write, naming the scene", () => {
  const page = headedWriter("Scene", undefined, { author: serial => "r" + (15 + serial) });
  registerSplits(page.h.a); registerSharedRemovalHandlers(page.h.a);
  try {
    page.startHeading(3);
    page.typeHeading(3, 3, "漢", "insertCompositionText");
    const other = collabState(page.h.a).roots.beats.get("R2"); assert.ok(other instanceof Y.Map);
    transactSharedDocument(page.h.a, "local-command", () => { other.set("lengthSeconds", 7); });
    page.end("漢");
    assert.deepEqual([page.recovered, page.reports], [["heading:H1"], []]);
    assert.deepEqual([page.name(), page.element().textContent], ["Scene", "Scene"]);
    assert.deepEqual(page.a.executed[1]?.operations, [
      { kind: "segment-create", id: "r17", by: "Alice", segment: "draft_segment_r17", beat: "draft_r17",
        at: { left: null, right: null, affinity: "after" }, fields: { audioText: "Sce漢ne", bufferSourceOwner: "H1", bufferPaintedBase: 1 } },
      { kind: "remove", id: "r17_remove", by: "Alice", removalKind: "beat", targets: ["draft_r17"], observed: ['["flow-base","draft_r17","audioText",0,6]'],
        boundaries: ["draft_r17"], components: ["structure_1_007200310037_visual_0"], gallery: [], comments: [], at: 2 }
    ]);
    assert.deepEqual(page.surface.selection(), caret(4));
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
  } finally { page.close(); }
});

const COMMANDS: readonly (readonly [string, (page: HeadedPage) => void, string, string])[] = [
  ["Enter", page => { page.surface.place(caret(3)); page.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); },
    "enter-heading", "applied"],
  ["paste", page => {
    page.surface.place(caret(2));
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "Q", types: ["text/plain"] } }); page.root.dispatchEvent(event);
  }, "paste", "applied"],
  ["cut", page => {
    page.surface.place({ anchor: headingPos("H1", 1), head: headingPos("H1", 3) });
    const event = new window.Event("cut", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "", setData: () => {}, types: [] } }); page.root.dispatchEvent(event);
  }, "cut", "applied"],
  ["formatting", page => { page.surface.place({ anchor: headingPos("H1", 1), head: headingPos("H1", 3) }); page.surface.format("b"); }, "format", "nothing"],
  ["Backspace at the heading's start", page => { page.typeHeading(0, 0, "", "deleteContentBackward"); }, "backspace", "applied"]
];

for (const [label, act, command, end] of COMMANDS) {
  test(`rule 3: ${label} in a heading settles typing first, then runs its existing command (${command}: ${end})`, () => {
    const seen: unknown[] = [];
    const holder: { page?: HeadedPage } = {};
    const port: SurfacePorts["commit"] = (name, operation) => {
      const page = holder.page; assert.ok(page);
      seen.push([name, page.name(), collabState(page.h.a).ingress.holds.has("buffer")]);
      const edited = operation(page.a.session.read(doc => { assert.ok(doc); return doc as FlowDoc; }));
      const outcome = edited && "ops" in edited && edited.ops ? page.a.session.run(sharedCommand(name, edited.ops)) : null;
      seen.push(outcome?.kind ?? "nothing");
      return outcome?.kind === "rejected" ? { refused: outcome.reason } : null;
    };
    const page = headedWriter("Scene", port); holder.page = page;
    registerSplits(page.h.a); registerSharedRemovalHandlers(page.h.a);
    try {
      page.typeHeading(5, 5, "X", "insertText", undefined, false);
      act(page);
      assert.deepEqual(seen, [[command, "SceneX", false], end]);
      assert.deepEqual(page.reports, []);
    } finally { page.close(); }
  });
}

test("rule 2: a selection from a heading into a beat settles typing, then goes to the existing command as rule 31 does", () => {
  const commands: string[] = [];
  const page = headedWriter("Scene", name => { commands.push(name + ":" + page.name()); return null; });
  try {
    page.typeHeading(5, 5, "X", "insertText", undefined, false);
    const range: FlowRange = { anchor: headingPos("H1", 2), head: { kind: "beat", rowId: "R1", offset: 1 } };
    page.surface.place(range);
    const target = page.surface.domRange(range); assert.ok(target);
    const input = new window.InputEvent("beforeinput", { inputType: "insertText", data: "Q", bubbles: true, cancelable: true });
    Object.defineProperty(input, "getTargetRanges", { value: () => [target] });
    page.root.dispatchEvent(input);
    assert.deepEqual([commands, page.reports, [...collabState(page.h.a).ingress.holds]], [["replace-selection:SceneX"], [], []]);
  } finally { page.close(); }
});

test("rule 2: composition over a heading and a beat is refused with no write and no hold", () => {
  const page = headedWriter("Scene", () => { assert.fail("A refused composition must not reach a command"); });
  try {
    page.surface.place({ anchor: headingPos("H1", 2), head: { kind: "beat", rowId: "R1", offset: 1 } });
    page.root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    page.end("");
    assert.deepEqual([page.name(), page.a.executed.length, [...collabState(page.h.a).ingress.holds]], ["Scene", 0, []]);
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-unsupported-target" }]);
  } finally { page.close(); }
});

test("an unreported change to a heading is adopted through the same buffer", () => {
  const page = headedWriter();
  try {
    page.element().textContent = "Scenes";
    page.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "s" }));
    assert.deepEqual([page.name(), page.reports, page.a.executed.length], ["Scenes", [], 1]);
  } finally { page.close(); }
});
