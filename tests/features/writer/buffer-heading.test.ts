import { test } from "node:test";
import * as Y from "yjs";
import assert from "node:assert/strict";
import { headedWriter, sceneNames } from "./buffer-heading-support.ts";
import type { HeadedPage } from "./buffer-heading-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { registerSplits, sharedCommand } from "../../application/session/shared-session-support.ts";
import { ref } from "../../adapters/collab/executor-support.ts";
import { headingPos } from "../../../src/core/flow/flow.ts";
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

test("rule 4: a Shift press before the first letter keeps the emptied heading held, so the letter replaces the name once", () => {
  const page = headedWriter();
  try {
    page.typeHeading(0, 5, "", "deleteContentBackward");
    page.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual([page.name(), page.element().textContent, page.reports], ["Scene", "", []]);
    page.typeHeading(0, 0, "N");
    assert.deepEqual([page.name(), page.element().textContent, page.reports, page.a.executed.length], ["N", "N", [], 1]);
  } finally { page.close(); }
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

test("rule 4: a cancelled composition that leaves other text in a heading held empty puts the name back and tells the person once", () => {
  const page = headedWriter();
  try {
    page.typeHeading(0, 5, "", "deleteContentBackward");
    page.startHeading(0);
    page.element().textContent = "x";
    page.end("");
    assert.deepEqual([page.name(), page.element().textContent, page.a.executed.length], ["Scene", "Scene", 0]);
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-heading-empty" }]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
  } finally { page.close(); }
});

test("rule 4: a composition cancelled in a heading held empty keeps the hold; ending it later tells the person once", () => {
  const page = headedWriter();
  try {
    page.typeHeading(0, 5, "", "deleteContentBackward");
    page.startHeading(0);
    page.end("");
    assert.deepEqual([page.name(), page.element().textContent, page.reports, page.a.executed.length], ["Scene", "", [], 0]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
    assert.equal(page.surface.settle?.(), true);
    assert.deepEqual([page.name(), page.element().textContent], ["Scene", "Scene"]);
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-heading-empty" }]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
  } finally { page.close(); }
});

test("rule 8: a typed space at a heading's edge is stored and shown as typed, and typing goes on after it", () => {
  const page = headedWriter();
  try {
    page.typeHeading(5, 5, " ");
    assert.deepEqual([stored(page), page.element().textContent, page.surface.paintedBase("heading:H1")?.text, page.name()], ["Scene ", "Scene ", "Scene ", "Scene"]);
    page.surface.paint();
    assert.equal(page.element().textContent, "Scene ");
    for (const [at, letter] of [[6, "t"], [7, "w"], [8, "o"]] as const) assert.equal(page.typeHeading(at, at, letter), true);
    page.typeHeading(0, 0, " ");
    assert.deepEqual([stored(page), page.element().textContent, page.reports, page.missing], [" Scene two", " Scene two", [], []]);
    assert.deepEqual([page.name(), page.surface.selection()], ["Scene two", caret(1)]);
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

test("rule 8: a command over a heading whose stored text has an edge space is refused and the person is told", () => {
  const holder: { page?: HeadedPage } = {};
  const page = headedWriter("Scene", (name, operation) => {
    const edited = operation(holder.page?.a.session.read(doc => { assert.ok(doc); return doc as FlowDoc; }) as FlowDoc);
    return edited && "refused" in edited ? edited : null;
  }); holder.page = page;
  try {
    page.typeHeading(5, 5, " ");
    page.surface.place(caret(3));
    page.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    assert.deepEqual([stored(page), page.element().textContent, page.reports, page.a.executed.length], ["Scene ", "Scene ", [], 1]);
    assert.deepEqual(page.notices, ["Remove the space at the start or end of this scene name first."]);
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
