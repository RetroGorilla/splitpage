import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, send, removeBeat, mark, fragment, page, rows, click } from "./support.ts";
import { agree } from "../../adapters/collab/executor-support.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createRecord, deleteRecord } from "../../adapters/collab/record-support.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";

interface Example {
  readonly kind: string;
  readonly source?: Record<string, unknown>;
  readonly prepare: (handle: SharedDocumentHandle) => void;
  readonly row: { readonly kind: string; readonly label: string; readonly by: string; readonly text: string; readonly actions: readonly string[] };
}

const EXAMPLES: readonly Example[] = [
  { kind: "removed-beat", prepare: handle => send(handle, removeBeat),
    row: { kind: "removed-beat", label: "Removed beat", by: "Removed by Alice", text: "abcd", actions: ["Restore", "Discard"] } },
  { kind: "removed-heading", source: { rows: [{ id: "R1", audioText: "abcd" }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] },
    prepare: handle => send(handle, { kind: "heading-remove", id: "goneH", by: "Alice", heading: "H1",
      observed: [flowBaseReference("H1", "heading", 0, 5)], newBeat: null, nextBeat: null }),
    row: { kind: "removed-heading", label: "Removed heading", by: "Removed by Alice", text: "Scene", actions: ["Restore", "Discard"] } },
  { kind: "scene-with-no-beats", source: { rows: [{ id: "R1", audioText: "abcd" }], sections: [{ id: "H1", name: "Empty scene", firstSceneId: "R1" }] },
    prepare: handle => send(handle, removeBeat), row: { kind: "scene-with-no-beats", label: "Scene without beats", by: "No author recorded", text: "Empty scene", actions: [] } },
  { kind: "deleted-tag", prepare: handle => mark(handle, "lost", 1, 3, "t_missing"),
    row: { kind: "deleted-tag", label: "Deleted tag", by: "No author recorded", text: "t_missing\nbc", actions: ["Discard"] } },
  { kind: "crossing-tag", source: { rows: [{ id: "R1", audioText: "abcd" }], productionTags: [
    { id: "t:prop:Cup", cat: "prop", name: "Cup", status: "needed" }, { id: "t:cast:Ada", cat: "cast", name: "Ada", status: "needed" }] },
    prepare: handle => { mark(handle, "z", 0, 3, "t:prop:Cup"); mark(handle, "a", 2, 4, "t:cast:Ada"); },
    row: { kind: "crossing-tag", label: "Overlapping tag", by: "No author recorded", text: "Ada\ncd", actions: ["Discard"] } },
  { kind: "gallery-overflow", prepare: handle => {
    for (let index = 0; index < 62; index++) send(handle, createRecord("gallery", "G" + index,
      { beat: "R1", rank: String(index).padStart(2, "0"), picture: { name: "Picture " + index }, links: [] }));
  }, row: { kind: "gallery-overflow", label: "Extra picture", by: "No author recorded", text: "Picture 61", actions: ["Discard"] } },
  { kind: "unprojectable-fragment", prepare: fragment,
    row: { kind: "unprojectable-fragment", label: "Unplaced text", by: "No author recorded", text: "abcd", actions: ["Discard"] } },
  { kind: "comment-without-words", source: { rows: [{ id: "R1", audioText: "abcd" }], comments: [
    { id: "C1", anchorId: "C1", rowId: "R1", field: "audioText", author: "Alice", body: "Remember <this>", quotedText: "gone", createdAt: 0,
      replies: [{ id: "r1", author: "Bob", body: "Answer", createdAt: 0 }] }] }, prepare: () => {},
    row: { kind: "comment-without-words", label: "Comment without words", by: "Alice", text: "gone\nRemember <this>\nBob: Answer", actions: ["Discard"] } },
  { kind: "reply-without-comment", prepare: handle => send(handle, createRecord("replies", '["C9","r1"]',
    { id: "r1", commentId: "C9", author: "Bob", createdAt: 0, text: "Keep <this>\nline" }, "Bob")),
    row: { kind: "reply-without-comment", label: "Reply without comment", by: "Bob", text: "Keep <this>\nline", actions: ["Discard"] } },
  { kind: "deleted-person", source: { rows: [{ id: "R1", audioText: "abcd" }], people: [{ id: "P1", name: "Pat" }],
    productionTags: [{ id: "t_1", cat: "prop", name: "Cup", status: "needed", owner: "P1" }] },
    prepare: handle => send(handle, deleteRecord("people", "P1", "Alice")),
    row: { kind: "deleted-person", label: "Deleted person", by: "Alice", text: "Pat", actions: ["Restore", "Discard"] } }
];

for (const example of EXAMPLES) for (const order of ["D1", "rev"] as const) test("C9 literal entry, copyable content and discard undo: " + example.kind + "/" + order, () => {
  const set = fixture(example.source);
  example.prepare(set.a); set.queue.flush(order);
  const one = page(set.a), two = page(set.b);
  try {
    one.open(); two.open();
    for (const mounted of [one, two]) {
      assert.deepEqual(rows(mounted.host).filter(row => row.kind === example.kind), [example.row]);
      const text = mounted.host.querySelector('[data-recovery-kind="' + example.kind + '"] pre'); assert.ok(text);
      const selection = document.getSelection(), range = document.createRange(); range.selectNodeContents(text);
      selection?.removeAllRanges(); selection?.addRange(range); assert.equal(selection?.toString(), example.row.text);
      assert.equal(text.querySelector("script"), null);
    }
    agree("C9 listed " + example.kind, order, [set.a, set.b], projectSharedDocumentWithRecovery);
    agree("C9 listed UI " + example.kind, order, [set.a, set.b], handle => {
      const copy = page(handle);
      try { copy.open(); return rows(copy.host).filter(row => row.kind === example.kind); } finally { copy.close(); }
    }, [example.row]);
    if (example.row.actions.includes("Discard")) {
      click(one.host, example.kind, "Discard"); set.queue.flush(order);
      for (const mounted of [one, two]) assert.deepEqual(rows(mounted.host).filter(row => row.kind === example.kind), []);
      assert.deepEqual(one.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
      agree("C9 discarded " + example.kind, order, [set.a, set.b], projectSharedDocumentWithRecovery);
      const undone = one.undo.undo(); assert.equal(undone.ok && undone.effective, true); set.queue.flush(order);
      for (const mounted of [one, two]) assert.deepEqual(rows(mounted.host).filter(row => row.kind === example.kind), [example.row]);
      agree("C9 discard undone " + example.kind, order, [set.a, set.b], projectSharedDocumentWithRecovery);
      const redone = one.undo.redo(); assert.equal(redone.ok && redone.effective, true); set.queue.flush(order);
      assert.deepEqual(rows(two.host).filter(row => row.kind === example.kind), []);
      agree("C9 discard redone " + example.kind, order, [set.a, set.b], projectSharedDocumentWithRecovery);
    }
    assert.deepEqual(one.notices.shown, []); assert.deepEqual(two.notices.shown, []);
  } finally { one.close(); two.close(); set.close(); }
});

for (const example of EXAMPLES.filter(item => item.row.actions.includes("Restore"))) for (const order of ["D1", "rev"] as const) {
  test("C9 restore, undo and redo keep the content at its original place: " + example.kind + "/" + order, () => {
    const set = fixture(example.source); example.prepare(set.a); set.queue.flush(order);
    const one = page(set.a), two = page(set.b);
    try {
      one.open(); two.open(); click(one.host, example.kind, "Restore"); set.queue.flush(order);
      for (const mounted of [one, two]) assert.deepEqual(rows(mounted.host).filter(row => row.kind === example.kind), []);
      const content = (handle: SharedDocumentHandle) => {
        const { document } = projectSharedDocumentWithRecovery(handle);
        return { rows: document.rows.map(row => [row.id, row.audioText]), people: document.people.map(person => [person.id, person.name]),
          headings: (document.sections ?? []).map(heading => [heading.id, heading.name, heading.firstSceneId]) };
      };
      const expected = example.kind === "removed-beat" ? { rows: [["R1", "abcd"], ["R2", "ef"]], people: [], headings: [] }
        : example.kind === "removed-heading" ? { rows: [["R1", "abcd"]], people: [], headings: [["H1", "Scene", "R1"]] }
          : { rows: [["R1", "abcd"]], people: [["P1", "Pat"]], headings: [] };
      agree("C9 restored content", order, [set.a, set.b], content, expected);
      agree("C9 restored document", order, [set.a, set.b], projectSharedDocumentWithRecovery);
      const undone = one.undo.undo(); assert.equal(undone.ok && undone.effective, true); set.queue.flush(order);
      for (const mounted of [one, two]) assert.equal(rows(mounted.host).filter(row => row.kind === example.kind).length, 1);
      agree("C9 restore undone", order, [set.a, set.b], projectSharedDocumentWithRecovery);
      const redone = one.undo.redo(); assert.equal(redone.ok && redone.effective, true); set.queue.flush(order);
      agree("C9 restore redone content", order, [set.a, set.b], content, expected);
      agree("C9 restore redone document", order, [set.a, set.b], projectSharedDocumentWithRecovery);
      assert.equal(one.undo.skipped(), 0); assert.deepEqual(one.notices.shown, []);
    } finally { one.close(); two.close(); set.close(); }
  });
}
