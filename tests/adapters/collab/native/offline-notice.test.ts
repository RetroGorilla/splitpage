import assert from "node:assert/strict";
import test from "node:test";
import type { NativePendingEditsData } from "../../../../src/adapters/collab/native/pending-edits.ts";
import { tagStack } from "../../../../src/core/text/runs.ts";
import { base, sole } from "./notice-histories.ts";
import { noticeCopy, noticeDeliver, noticeRange, noticeSeed } from "./notice-harness.ts";

const text = (beat: { readonly narration: readonly { readonly text: string }[] }) =>
  beat.narration.map(run => run.text).join("");

test("only local written commands enter the journal and only a returning copy gets a notice", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3, true);
  try {
    const before = writer.encodeState(), caret = noticeRange(writer, "B", "narration", 1);
    assert.equal(writer.commands.typeText(caret, "", {}).kind, "unchanged");
    assert.equal(writer.commands.removeRows(["missing"]).kind, "refused");
    assert.deepEqual(writer.encodeState(), before);
    assert.deepEqual(writer.pendingEdits?.data(), { through: 0, entries: [] });

    assert.equal(writer.commands.typeText(caret, "Ω", {}).kind, "written");
    noticeDeliver(writer, cutter);
    assert.deepEqual(cutter.pendingEdits?.data(), { through: 0, entries: [] });
    assert.deepEqual(writer.offlineNotice("returning"), []);
    assert.equal(cutter.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(cutter, writer);
    assert.deepEqual(writer.offlineNotice("online"), []);
    const bytes = writer.encodeState(), journal = writer.pendingEdits?.data();
    const notice = writer.offlineNotice("returning");
    assert.equal(notice.length, 1);
    assert.equal(notice[0]?.id, "B");
    assert.equal(notice[0]?.possibleRemoval, true);
    assert.deepEqual(notice[0]?.kinds, ["narration"]);
    assert.equal(notice[0]?.merged, null);
    assert.ok(notice[0]?.mine);
    assert.equal(text(notice[0].mine), "dΩef");
    assert.deepEqual(writer.encodeState(), bytes);
    assert.deepEqual(writer.pendingEdits?.data(), journal);
  } finally {
    writer.close();
    cutter.close();
  }
});

test("plain data reopens with the saved beat and a receipt clears only acknowledged entries", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3, true);
  try {
    assert.equal(writer.commands.setField({ kind: "beat", id: "B", field: "status" }, "ready").kind, "written");
    const receipt = writer.pendingEdits?.data().through;
    assert.equal(receipt, 1);
    assert.equal(writer.commands.typeText(noticeRange(writer, "B", "visual", 1), "Ψ", {}).kind, "written");
    assert.equal(writer.commands.setField({ kind: "beat", id: "B", field: "notes" }, { text: "details" }).kind, "written");
    assert.equal(writer.commands.formatText(noticeRange(writer, "B", "narration", 1, 2),
      { kind: "tag", id: "t:prop:tag", on: true }).kind, "written");

    const data = writer.pendingEdits?.data();
    assert.ok(data);
    const reloaded = JSON.parse(JSON.stringify(data)) as NativePendingEditsData;
    const restored = noticeCopy(writer.encodeState(), 4, reloaded);
    try {
      assert.deepEqual(restored.pendingEdits?.data(), data);
      restored.pendingEdits?.clearThrough(receipt);
      assert.deepEqual(restored.pendingEdits?.data().entries.map(({ sequence }) => sequence), [2, 3, 4]);
      assert.equal(cutter.commands.removeRows(["B"]).kind, "written");
      noticeDeliver(cutter, restored);
      const [clash] = restored.offlineNotice("returning");
      assert.ok(clash?.mine);
      assert.deepEqual(clash.kinds, ["visual", "marks", "record"]);
      assert.equal(text(clash.mine), "def");
      assert.deepEqual(clash.mine.visual, [{ text: "2Ψ", marks: {} }]);
      assert.deepEqual(clash.mine.fields, { status: "ready", notes: { text: "details" } });
      assert.ok(clash.mine.narration.some(run => tagStack(run.marks).includes("t:prop:tag")));
      assert.deepEqual(clash.mine.placement, { scene: null, left: "A", right: "C", sceneOrder: ["A", "B", "C", "D"] });
      restored.pendingEdits?.clearThrough(4);
      assert.deepEqual(restored.offlineNotice("returning"), []);
      assert.deepEqual(restored.pendingEdits?.data(), { through: 4, entries: [] });
    } finally { restored.close(); }
  } finally {
    writer.close();
    cutter.close();
  }
});

test("a peer change read before the next command does not become a local pending edit", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    assert.equal(peer.commands.typeText(noticeRange(peer, "B", "narration", 1), "Ω", {}).kind, "written");
    noticeDeliver(peer, writer);
    assert.equal(writer.commands.typeText(noticeRange(writer, "C", "visual", 1), "Ψ", {}).kind, "written");
    assert.deepEqual(writer.pendingEdits?.data().entries.map(entry => entry.id), ["C"]);
    assert.equal(peer.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(peer, writer);
    assert.deepEqual(writer.offlineNotice("returning"), []);
  } finally {
    writer.close();
    peer.close();
  }
});

test("a heading rename writes without adding a beat to the journal", () => {
  const copy = noticeCopy(noticeSeed(base), 2, true);
  try {
    assert.equal(copy.commands.renameHeading(noticeRange(copy, "H", "name", 0, 3), "Scene").kind, "written");
    assert.deepEqual(copy.pendingEdits?.data(), { through: 0, entries: [] });
  } finally { copy.close(); }
});

test("a joined member's own field is journaled even when it is absent from the displayed row", () => {
  const initial = structuredClone(base);
  initial.beats.C = { joined: { into: "B", glue: " " } };
  const state = noticeSeed(initial), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.setField({ kind: "beat", id: "C", field: "notes" }, "member only").kind, "written");
    assert.equal(writer.document().rows.find(row => row.id === "B")?.notes, undefined);
    assert.equal(cutter.commands.removeRows(["C"]).kind, "written");
    noticeDeliver(cutter, writer);
    const [clash] = writer.offlineNotice("returning");
    assert.equal(clash?.id, "C");
    assert.ok(clash.mine);
    assert.deepEqual(clash?.kinds, ["record"]);
    assert.equal(clash?.mine?.row, "B");
    assert.equal(clash.mine.fields.notes, "member only");
    assert.equal(text(clash.mine), "ghi");
  } finally {
    writer.close();
    cutter.close();
  }
});

test("a concurrent winning status is shown beside the returning writer's status", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    const target = { kind: "beat", id: "B", field: "status" } as const;
    assert.equal(writer.commands.setField(target, "ready").kind, "written");
    assert.equal(peer.commands.setField(target, "shot").kind, "written");
    noticeDeliver(peer, writer);
    const [notice] = writer.offlineNotice("returning");
    assert.equal(notice?.possibleRemoval, false);
    assert.deepEqual(notice?.kinds, ["record"]);
    assert.equal(notice?.mine?.fields.status, "ready");
    assert.equal(notice?.merged?.fields.status, "shot");
  } finally {
    writer.close();
    peer.close();
  }
});

test("undo and explicit reversals cancel pending text and record changes", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.typeText(noticeRange(writer, "B", "narration", 1), "Ω", {}).kind, "written");
    assert.equal(writer.commands.undo().kind, "written");
    const target = { kind: "beat", id: "B", field: "status" } as const;
    assert.equal(writer.commands.setField(target, "ready").kind, "written");
    assert.equal(writer.commands.setField(target, "todo").kind, "written");
    assert.equal(writer.commands.typeText(noticeRange(writer, "B", "visual", 0), "Ψ", {}).kind, "written");
    assert.equal(writer.commands.deleteText(noticeRange(writer, "B", "visual", 0, 1)).kind, "written");
    assert.equal(cutter.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(cutter, writer);
    assert.deepEqual(writer.offlineNotice("returning"), []);
  } finally {
    writer.close();
    cutter.close();
  }
});

test("undoing a local split does not report a peer's text that lands back in the parent", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    const split = writer.commands.splitRow(noticeRange(writer, "B", "narration", 1));
    assert.equal(split.kind, "written");
    noticeDeliver(writer, peer);
    assert.equal(peer.commands.typeText(noticeRange(peer, split.created, "narration", 2), "Ψ", {}).kind, "written");
    assert.equal(writer.commands.undo().kind, "written");
    noticeDeliver(peer, writer);
    assert.equal(writer.document().rows.find(row => row.id === "B")?.audioText, "defΨ");
    assert.deepEqual(writer.offlineNotice("returning"), []);
  } finally {
    writer.close();
    peer.close();
  }
});

test("a returned marker without its record has no beat in the notice reading", () => {
  const state = noticeSeed(base), splitter = noticeCopy(state, 2), cutter = noticeCopy(state, 3), writer = noticeCopy(state, 4, true);
  try {
    const split = splitter.commands.splitRow(noticeRange(splitter, "B", "narration", 0));
    assert.equal(split.kind, "written");
    const id = split.created;
    noticeDeliver(splitter, cutter);
    noticeDeliver(splitter, writer);
    assert.equal(writer.commands.setField({ kind: "beat", id, field: "status" }, "ready").kind, "written");
    assert.equal(cutter.commands.removeRows([id]).kind, "written");
    noticeDeliver(cutter, splitter);
    assert.equal(splitter.commands.undo().kind, "written");
    noticeDeliver(splitter, cutter);
    assert.equal(cutter.commands.undo().kind, "written");
    assert.equal(cutter.document().rows.find(row => row.id === id), undefined);
    assert.equal(cutter.document().rows.find(row => row.id === "B")?.audioText, "def");
    noticeDeliver(cutter, writer);
    const [clash] = writer.offlineNotice("returning");
    assert.equal(clash?.id, id);
    assert.equal(clash?.possibleRemoval, true);
    assert.deepEqual(clash?.kinds, ["record"]);
    assert.equal(clash?.merged, null);
    assert.equal(clash?.mine?.fields.status, "ready");
  } finally {
    splitter.close();
    cutter.close();
    writer.close();
  }
});

test("the existing split command cannot create a beat after removal of the sole beat", () => {
  const copy = noticeCopy(noticeSeed(sole), 2, true);
  try {
    const at = noticeRange(copy, "A", "narration", 1);
    const before = copy.encodeState();
    assert.deepEqual(copy.ydoc.transact(() => copy.commands.splitRow(at)), { kind: "refused", reason: "busy" });
    assert.deepEqual(copy.encodeState(), before);
    assert.equal(copy.commands.removeRows(["A"]).kind, "written");
    assert.deepEqual(copy.document().rows, []);
    const removed = copy.encodeState(), journal = copy.pendingEdits?.data();
    assert.deepEqual(copy.commands.splitRow(at), { kind: "refused", reason: "missing" });
    assert.deepEqual(copy.encodeState(), removed);
    assert.deepEqual(copy.pendingEdits?.data(), journal);
    const saved = journal?.entries[0]?.before;
    assert.ok(saved);
    const result = copy.commands.putBack(saved);
    assert.equal(result.kind, "written");
    assert.deepEqual(copy.document().rows.map(row => [row.id, row.audioText, row.visualText]), [[result.created, "abc", "1"]]);
    assert.equal(copy.commands.undo().kind, "written");
    assert.deepEqual(copy.document().rows, []);
  } finally { copy.close(); }
});
