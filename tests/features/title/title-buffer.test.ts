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
  ["Ctrl+V", (page: TitlePage) => page.edge.paste("Q")],
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
