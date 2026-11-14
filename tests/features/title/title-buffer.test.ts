import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedTitle } from "./title-buffer-support.ts";
import type { TitlePage } from "./title-buffer-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { TITLE_FIELD_KEY } from "../../../src/application/editing/buffered-field-key.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

function remote(page: TitlePage, at: number, text: string): void {
  const target = sharedBufferedTarget(page.h.b, TITLE_FIELD_KEY), right = createSharedAnchor(page.h.b, target, at, "after"); assert.ok(right);
  page.h.execute("B", [page.h.command("B", { kind: "text-insert", target, at: { left: null, right, affinity: "before" }, content: [{ value: text, marks: [] }] })]);
}

function titles(handle: SharedDocumentHandle): unknown {
  const doc = projectSharedDocumentWithRecovery(handle).document;
  return [doc.title, doc.titleOrigin];
}

function copies(page: TitlePage, expected: readonly unknown[]): void {
  page.h.queue.flush("dup"); page.h.join();
  for (const handle of [page.h.a, page.h.b, page.h.c]) assert.deepEqual(titles(handle), expected);
}

function written(page: TitlePage) {
  return page.a.executed.map(command => command.operations.map(op => op.kind === "text-insert" ? { kind: op.kind, content: op.content }
    : op.kind === "text-delete" ? { kind: op.kind, observed: op.observed.length } : { kind: op.kind }));
}

function targets(page: TitlePage): unknown {
  return page.a.executed.flatMap(command => command.operations.map(op => "target" in op ? op.target : null));
}

const holds = (page: TitlePage) => [...collabState(page.h.a).ingress.holds];
const caret = (input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection];
const inserted = (value: string) => ({ kind: "text-insert", content: [{ value, marks: [] }] });
const UNSUPPORTED = [{ kind: "rejected", reason: "buffer-unsupported-input" }];

for (const clipboard of ["empty paste", "cut without selection"] as const) {
  test(`shared title: ${clipboard} takes no hold and a remote change reaches both inputs and every copy`, () => {
    const page = sharedTitle();
    try {
      page.main.focus(); page.edge.select(2);
      const during: unknown[] = [];
      page.main.addEventListener("beforeinput", () => { during.push(holds(page)); }, { once: true });
      if (clipboard === "empty paste") page.edge.paste(""); else page.edge.cut();
      assert.deepEqual(during, clipboard === "empty paste" ? [[]] : []);
      remote(page, 0, "!"); page.h.queue.flush("dup"); page.paint();
      assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, written(page), holds(page)],
        ["!Draft", "!Draft", "!Draft", [3, 3, "none"], [], [], []]);
      copies(page, ["!Draft", "user"]);
    } finally { page.close(); }
  });
}

for (const [label, act, from, to, noHold] of [
  ["empty paste at a caret", (page: TitlePage) => page.edge.paste(""), 2, 2, true],
  ["paste at a caret", (page: TitlePage) => page.edge.paste("Q"), 2, 2, false],
  ["paste over a selection", (page: TitlePage) => page.edge.paste("raf"), 1, 4, false],
  ["cut over a selection", (page: TitlePage) => page.edge.cut(), 1, 4, false]
] as const) {
  test(`shared title: a cancelled ${label} releases its unchanged pending target at keyup without an edit`, () => {
    const page = sharedTitle();
    try {
      page.main.focus(); page.edge.select(from, to);
      let beforeHold: unknown = null;
      page.main.addEventListener("beforeinput", event => {
        beforeHold = holds(page);
        event.preventDefault();
      }, { once: true });
      assert.equal(act(page), false);
      assert.deepEqual(beforeHold, noHold ? [] : ["buffer"]);
      assert.deepEqual([page.stored(), page.main.value, page.reports, written(page), holds(page)], ["Draft", "Draft", [], [], []]);
      remote(page, 0, "!"); page.h.queue.flush("dup"); page.paint();
      assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, written(page), holds(page)],
        ["!Draft", "!Draft", "!Draft", [from + 1, to + 1, from === to ? "none" : "forward"], [], [], []]);
      copies(page, ["!Draft", "user"]);
    } finally { page.close(); }
  });
}

test("shared title: paint after a cancelled paste releases queued remote text before any keyup", () => {
  const page = sharedTitle();
  try {
    page.main.focus(); page.edge.select(2);
    const snapshots: unknown[] = [];
    page.main.addEventListener("beforeinput", event => {
      event.preventDefault(); remote(page, 0, "!"); page.h.queue.deliverFrom("B", "D1");
      snapshots.push([page.stored(), holds(page)]);
      page.paint();
      snapshots.push([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, written(page), holds(page)]);
    }, { once: true });
    assert.equal(page.edge.paste("Q"), false);
    assert.deepEqual(snapshots, [["Draft", ["buffer"]], ["!Draft", "!Draft", "!Draft", [3, 3, "none"], [], [], []]]);
    copies(page, ["!Draft", "user"]);
  } finally { page.close(); }
});

test("shared title: an empty paste over a selection is the recorded native deletion", () => {
  const page = sharedTitle();
  try {
    page.main.focus(); page.edge.select(1, 4); assert.equal(page.edge.paste(""), true);
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, written(page), holds(page)],
      ["Dt", "Dt", "Dt", [1, 1, "none"], [], [[{ kind: "text-delete", observed: 3 }]], []]);
    copies(page, ["Dt", "user"]);
  } finally { page.close(); }
});

test("shared title: typing settles each keystroke as title text operations on the document, with no set-title command", () => {
  const page = sharedTitle();
  try {
    page.main.focus();
    page.edge.select(5);
    assert.equal(page.edge.type("X"), true);
    page.edge.select(1, 3);
    assert.equal(page.edge.backspace(), true);
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, page.commands],
      ["DftX", "DftX", "DftX", [1, 1, "none"], [], []]);
    assert.deepEqual(written(page), [[inserted("X")], [{ kind: "text-delete", observed: 2 }]]);
    assert.deepEqual(targets(page), [page.target(), page.target()]);
    assert.deepEqual([holds(page), page.shownDepth(), page.pageTitles(), page.repaints()], [[], 0, 2, 0]);
    copies(page, ["DftX", "user"]);
  } finally { page.close(); }
});

test("shared title: typing in the Writer's title settles the same field and shows it in the main title", () => {
  const page = sharedTitle();
  try {
    page.writer.focus();
    page.writerEdge.select(0);
    page.writerEdge.type("A");
    assert.deepEqual([page.stored(), page.writer.value, page.main.value, caret(page.writer), page.reports, page.pageTitles()],
      ["ADraft", "ADraft", "ADraft", [1, 1, "none"], [], 1]);
    assert.deepEqual(written(page), [[inserted("A")]]);
    copies(page, ["ADraft", "user"]);
  } finally { page.close(); }
});

test("shared title: a title the file named keeps its origin; typing writes only the text", () => {
  const page = sharedTitle("Draft", { titleOrigin: "file", titleVersion: "v2" });
  try {
    page.main.focus();
    page.edge.select(5);
    page.edge.type("X");
    assert.deepEqual([page.stored(), page.reports, written(page)], ["DraftX", [], [[inserted("X")]]]);
    copies(page, ["DraftX", "file"]);
  } finally { page.close(); }
});

test("shared title: a remote change arriving mid-keystroke is held until it settles, then both land", () => {
  const page = sharedTitle();
  try {
    page.main.focus();
    page.edge.select(5);
    page.edge.type("X", () => {
      remote(page, 0, "!");
      page.h.queue.deliverFrom("B", "D1");
      assert.equal(page.stored(), "Draft");
    });
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports], ["!DraftX", "!DraftX", "!DraftX", [7, 7, "none"], []]);
    copies(page, ["!DraftX", "user"]);
  } finally { page.close(); }
});

test("shared title: a repaint shows another writer's text in both inputs and keeps the caret and selection on the same letters", () => {
  const page = sharedTitle();
  try {
    page.main.focus();
    page.edge.select(1, 4, "backward");
    remote(page, 0, "!");
    remote(page, 6, "?");
    page.h.queue.flush("dup");
    page.paint();
    assert.deepEqual([page.main.value, page.writer.value, caret(page.main), document.activeElement === page.main, page.stored(), page.reports],
      ["!Draft?", "!Draft?", [2, 5, "backward"], true, "!Draft?", []]);
    page.edge.select(4);
    page.edge.type("Y");
    assert.deepEqual([page.stored(), page.main.value, page.writer.value], ["!DraYft?", "!DraYft?", "!DraYft?"]);
    copies(page, ["!DraYft?", "user"]);
  } finally { page.close(); }
});

test("shared title: an emptied title is written empty at once, with no hold and no report", () => {
  const page = sharedTitle();
  try {
    page.main.focus();
    page.edge.selectAll();
    assert.equal(page.edge.backspace(), true);
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, page.reports, holds(page)], ["", "", "", [], []]);
    assert.deepEqual(written(page), [[{ kind: "text-delete", observed: 5 }]]);
    copies(page, ["", "user"]);
    page.edge.type("N");
    assert.deepEqual([page.stored(), page.main.value, page.reports], ["N", "N", []]);
    copies(page, ["N", "user"]);
  } finally { page.close(); }
});

test("shared title: Enter changes nothing and tells nothing", () => {
  const page = sharedTitle();
  try {
    page.main.focus();
    page.edge.select(5);
    page.edge.type("X");
    page.edge.enter();
    assert.deepEqual([page.stored(), page.main.value, page.reports, written(page)], ["DraftX", "DraftX", [], [[inserted("X")]]]);
  } finally { page.close(); }
});

for (const [label, act] of [
  ["Ctrl+Z", (page: TitlePage) => page.edge.undo("Draft")]
] as const) {
  test(`shared title: ${label} after typing is refused and the person is told; nothing changes`, () => {
    const page = sharedTitle();
    try {
      page.main.focus();
      page.edge.select(5);
      page.edge.type("X");
      assert.equal(act(page), false);
      assert.deepEqual([page.stored(), page.main.value, page.writer.value, page.reports, written(page)], ["DraftX", "DraftX", "DraftX", UNSUPPORTED, [[inserted("X")]]]);
      copies(page, ["DraftX", "user"]);
    } finally { page.close(); }
  });
}

test("shared title rule 84: paste replaces the selection, cut copies before deleting, and the caret follows remote text", () => {
  const page = sharedTitle();
  try {
    page.main.focus(); page.edge.select(1, 4);
    assert.equal(page.edge.paste("XY", () => { remote(page, 0, "!"); page.h.queue.deliverFrom("B", "D1"); }), true);
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports], ["!DXYt", "!DXYt", "!DXYt", [4, 4, "none"], []]);
    assert.deepEqual(written(page), [[inserted("XY"), { kind: "text-delete", observed: 3 }]]);
    copies(page, ["!DXYt", "user"]);
    page.edge.select(2, 4); assert.equal(page.edge.cut(), true);
    assert.deepEqual([page.edge.copied(), page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports], ["XY", "!Dt", "!Dt", "!Dt", [2, 2, "none"], []]);
    assert.deepEqual(written(page), [[inserted("XY"), { kind: "text-delete", observed: 3 }], [{ kind: "text-delete", observed: 2 }]]);
    copies(page, ["!Dt", "user"]);
  } finally { page.close(); }
});

for (const [label, act, expected, offset, operation] of [
  ["Ctrl+V", (page: TitlePage) => page.edge.paste("Q"), "DraftXQ", 7, inserted("Q")],
  ["Ctrl+X over a selection", (page: TitlePage) => { page.edge.select(0, 2); return page.edge.cut(); }, "aftX", 0, { kind: "text-delete", observed: 2 }]
] as const) {
  test(`shared title rule 84: ${label} after typing writes a shared edit without a report`, () => {
    const page = sharedTitle();
    try {
      page.main.focus(); page.edge.select(5); page.edge.type("X");
      assert.equal(act(page), true);
      assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, written(page)],
        [expected, expected, expected, [offset, offset, "none"], [], [[inserted("X")], [operation]]]);
      copies(page, [expected, "user"]);
    } finally { page.close(); }
  });
}

test("shared title rule 84: paste cannot mask a native difference outside its captured selection", () => {
  const page = sharedTitle();
  try {
    page.main.focus(); page.edge.select(2);
    page.edge.paste("Q", () => { page.main.value = "Xraft"; page.main.setSelectionRange(2, 2); });
    assert.deepEqual([page.stored(), page.main.value, caret(page.main), page.reports, written(page), holds(page)],
      ["Draft", "XrQaft", [3, 3, "none"], [{ kind: "rejected", reason: "buffer-native-evidence" }], [], ["buffer"]]);
    copies(page, ["Draft", "user"]);
    page.edge.imeSet("Z"); page.edge.imeCancel();
  } finally { page.close(); }
});

test("shared title rule 84: paste during composition is consumed, and the final composition still commits", () => {
  const page = sharedTitle();
  try {
    page.main.focus(); page.edge.select(5); page.edge.imeSet("漢");
    assert.equal(page.edge.paste("Q"), false);
    assert.deepEqual([page.stored(), page.main.value, page.reports, written(page)], ["Draft", "Draft漢", [{ kind: "rejected", reason: "buffer-composition" }], []]);
    page.edge.imeCommit("漢");
    assert.deepEqual([page.stored(), page.main.value, caret(page.main), written(page)], ["Draft漢", "Draft漢", [6, 6, "none"], [[inserted("漢")]]]);
    copies(page, ["Draft漢", "user"]);
  } finally { page.close(); }
});

test("shared title rule 84: paste keeps its prefix up to 300 UTF-16 units without splitting a pair or deleting the suffix", () => {
  const page = sharedTitle("a".repeat(297) + "Z");
  try {
    page.main.focus(); page.edge.select(297);
    assert.equal(page.edge.paste("X😀Q"), true);
    const expected = "a".repeat(297) + "XZ";
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, written(page)],
      [expected, expected, expected, [298, 298, "none"], [], [[inserted("X")]]]);
    copies(page, [expected, "user"]);
  } finally { page.close(); }
});

test("shared title rule 84: native paste folds line breaks to spaces and retains tabs and control characters", () => {
  const page = sharedTitle();
  try {
    page.main.focus(); page.edge.selectAll(); page.edge.paste("A\r\nB\nC\rD\tE\u0001F\u000bG\u007fH");
    const expected = "A B C D\tE\u0001F\u000bG\u007fH";
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, written(page)],
      [expected, expected, expected, [15, 15, "none"], [], [[inserted(expected), { kind: "text-delete", observed: 5 }]]]);
    copies(page, [expected, "user"]);
  } finally { page.close(); }
});

test("shared title rule 84: cutting everything writes empty immediately and pasting at a full title writes nothing", () => {
  const page = sharedTitle("a".repeat(300));
  try {
    page.main.focus(); page.edge.select(300); page.edge.paste("XYZ");
    assert.deepEqual([page.stored(), page.main.value, caret(page.main), page.reports, written(page), holds(page)],
      ["a".repeat(300), "a".repeat(300), [300, 300, "none"], [], [], []]);
    page.edge.selectAll(); assert.equal(page.edge.cut(), true);
    assert.deepEqual([page.edge.copied(), page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, written(page), holds(page)],
      ["a".repeat(300), "", "", "", [0, 0, "none"], [], [[{ kind: "text-delete", observed: 300 }]], []]);
    copies(page, ["", "user"]);
  } finally { page.close(); }
});

test("shared title rule 84: drop stays refused after paste and preserves the pasted text and caret", () => {
  const page = sharedTitle();
  try {
    page.main.focus(); page.edge.select(2); page.edge.paste("Q"); assert.equal(page.edge.drop("Z"), false);
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, written(page)],
      ["DrQaft", "DrQaft", "DrQaft", [3, 3, "none"], UNSUPPORTED, [[inserted("Q")]]]);
    copies(page, ["DrQaft", "user"]);
  } finally { page.close(); }
});

test("shared title: a composition settles once at compositionend", () => {
  const page = sharedTitle();
  try {
    page.main.focus();
    page.edge.select(5);
    page.edge.imeSet("か");
    page.edge.imeSet("漢");
    assert.deepEqual([page.stored(), page.a.executed.length], ["Draft", 0]);
    page.edge.imeCommit("漢");
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, page.reports, written(page)], ["Draft漢", "Draft漢", "Draft漢", [], [[inserted("漢")]]]);
    copies(page, ["Draft漢", "user"]);
  } finally { page.close(); }
});

const FULL = "a".repeat(300);
const TOO_LONG = [{ kind: "rejected", reason: "buffer-title-length" }];

test("shared title: a letter typed into a full 300-unit title is refused and told once; nothing is written, and the next edits still work", () => {
  const page = sharedTitle(FULL);
  try {
    page.main.focus();
    page.edge.select(300);
    page.edge.type("X");
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, caret(page.main), page.reports, page.a.executed.length, holds(page)],
      [FULL, FULL, FULL, [300, 300, "none"], TOO_LONG, 0, []]);
    copies(page, [FULL, "user"]);
    assert.equal(page.edge.backspace(), true);
    page.edge.type("Y");
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, page.reports, written(page)],
      ["a".repeat(299) + "Y", "a".repeat(299) + "Y", "a".repeat(299) + "Y", TOO_LONG, [[{ kind: "text-delete", observed: 1 }], [inserted("Y")]]]);
    copies(page, ["a".repeat(299) + "Y", "user"]);
  } finally { page.close(); }
});

test("shared title: a composition that would take the title past 300 units is refused and told once at its commit", () => {
  const page = sharedTitle("a".repeat(299));
  try {
    page.main.focus();
    page.edge.select(299);
    page.edge.imeSet("漢字");
    page.edge.imeCommit("漢字");
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, page.reports, page.a.executed.length, holds(page)],
      ["a".repeat(299), "a".repeat(299), "a".repeat(299), TOO_LONG, 0, []]);
    copies(page, ["a".repeat(299), "user"]);
  } finally { page.close(); }
});

test("shared title: two writers each typing the 300th unit leave 301 stored; the inputs and the session view show it in full, growth is refused and a deletion is written", () => {
  const page = sharedTitle("a".repeat(299));
  try {
    page.main.focus();
    page.edge.select(299);
    remote(page, 0, "Y");
    page.edge.type("X");
    page.h.queue.flush("dup");
    page.paint();
    const both = "Y" + "a".repeat(299) + "X";
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, page.viewTitle(), page.reports], [both, both, both, both, []]);
    copies(page, [both, "user"]);
    page.edge.select(301);
    page.edge.type("Z");
    assert.deepEqual([page.stored(), page.main.value, page.reports, page.a.executed.length], [both, both, TOO_LONG, 1]);
    assert.equal(page.edge.backspace(), true);
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, page.reports, page.a.executed.length],
      ["Y" + "a".repeat(299), "Y" + "a".repeat(299), "Y" + "a".repeat(299), TOO_LONG, 2]);
    copies(page, ["Y" + "a".repeat(299), "user"]);
  } finally { page.close(); }
});

test("shared title: two writers each committing two units onto 298 leave 302 stored, the session view shows it in full, and it shortens one deletion at a time", () => {
  const page = sharedTitle("a".repeat(298));
  try {
    page.main.focus();
    page.edge.select(298);
    remote(page, 0, "YZ");
    page.edge.imeSet("漢字");
    page.edge.imeCommit("漢字");
    page.h.queue.flush("dup");
    page.paint();
    const both = "YZ" + "a".repeat(298) + "漢字";
    assert.deepEqual([page.stored(), page.main.value, page.viewTitle(), page.reports], [both, both, both, []]);
    page.edge.select(302);
    assert.equal(page.edge.backspace(), true);
    assert.deepEqual([page.stored(), page.main.value, page.writer.value, page.reports, page.a.executed.length],
      [both.slice(0, 301), both.slice(0, 301), both.slice(0, 301), [], 2]);
    copies(page, [both.slice(0, 301), "user"]);
  } finally { page.close(); }
});

test("shared title: closing the routes after typing leaves what is shared and repaints once", () => {
  const page = sharedTitle();
  try {
    page.main.focus();
    page.edge.select(5);
    page.edge.type("X");
    page.routes.dispose();
    page.routes.dispose();
    assert.deepEqual([page.stored(), page.repaints(), page.reports, page.commands], ["DraftX", 1, [], []]);
    page.edge.type("Y");
    assert.deepEqual([page.stored(), page.a.executed.length], ["DraftX", 1]);
  } finally { page.close(); }
});
