import assert from "node:assert/strict";
import test from "node:test";
import type { NativePendingEditsData } from "../../../../src/adapters/collab/native/pending-edits.ts";
import { NativeScriptReader, readNativeOnce } from "../../../../src/adapters/collab/native/reader.ts";
import { declareNativeRoots } from "../../../../src/adapters/collab/native/roots.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { tagStack } from "../../../../src/core/text/runs.ts";
import { base, sole } from "./notice-histories.ts";
import { noticeCopy, noticeDeliver, noticeRange, noticeSeed } from "./notice-harness.ts";
import { measureNoticeGrowth } from "./notice-growth.ts";
import { largeState } from "./structural.ts";

const text = (beat: { readonly narration: readonly { readonly text: string }[] }) =>
  beat.narration.map(run => run.text).join("");

test("the journal is bounded by beats touched across 10,000 keystrokes and 900 beats", t => {
  const state = largeState();
  for (const across of [false, true]) t.diagnostic(JSON.stringify(measureNoticeGrowth(state, across)));
});

test("only local written commands enter the journal and only a returning copy gets a notice", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3, true);
  try {
    const before = writer.encodeState(), caret = noticeRange(writer, "B", "narration", 1);
    assert.equal(writer.commands.typeText(caret, "", {}).kind, "unchanged");
    assert.equal(writer.commands.removeRows(["missing"]).kind, "refused");
    assert.deepEqual(writer.encodeState(), before);
    assert.deepEqual(writer.pendingEdits?.data(), { through: 0, entries: [] });

    assert.equal(writer.commands.typeText(caret, "Ω", {}).kind, "written");
    assert.equal(writer.pendingEdits?.data().entries[0]?.landing, null);
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

test("a command with selection is journaled once and recording the after selection does not write", () => {
  const writer = noticeCopy(noticeSeed(base), 2, true);
  try {
    const journal = writer.pendingEdits;
    assert.ok(journal);
    const before = noticeRange(writer, "B", "narration", 1);
    const step = writer.commands.typeText.withSelection(before, before, "x", {});
    assert.equal(step.result.kind, "written");
    const data = journal.data(), bytes = writer.encodeState();
    assert.equal(data.through, 1);
    assert.deepEqual(data.entries.map(entry => [entry.id, entry.first, entry.last, entry.after && text(entry.after)]),
      [["B", 1, 1, "dxef"]]);

    step.recordAfter(noticeRange(writer, "B", "narration", 0));
    assert.deepEqual(journal.data(), data);
    assert.deepEqual(writer.encodeState(), bytes);
    assert.equal(writer.commands.undo().kind, "written");
    const redo = writer.commands.redo();
    assert.equal(redo.kind, "written");
    const point = { target: before.target, offset: 0 };
    assert.deepEqual(redo.selection, { anchor: point, head: point });
    assert.equal(journal.data().through, 3);
  } finally { writer.close(); }
});

test("a full session refuses a field write and put-back without changing its bytes or journal", () => {
  const state = noticeSeed(base);
  const copy = openNativeSession({ kind: "state", state }, {
    actor: "writer", sanitize: html => String(html), noticeJournal: true,
    sizeLimit: state.byteLength, sizeCeilingRatio: 2
  });
  try {
    assert.equal(copy.size, "full");
    const bytes = copy.encodeState(), before = copy.pendingEdits?.data();
    assert.deepEqual(copy.commands.setField({ kind: "beat", id: "B", field: "notes" }, "new"), { kind: "refused", reason: "full" });
    assert.deepEqual(copy.commands.putBack({
      id: "B", narration: [{ text: "new", marks: {} }], visual: [], fields: {},
      placement: { scene: null, left: "A", right: "C", sceneOrder: ["A", "B", "C"] }
    }), { kind: "refused", reason: "full" });
    assert.deepEqual(copy.encodeState(), bytes);
    assert.deepEqual(copy.pendingEdits?.data(), before);
  } finally { copy.close(); }
});

function reopenNoticeCopy(copy: ReturnType<typeof noticeCopy>, client: number) {
  const data = copy.pendingEdits?.data();
  assert.ok(data);
  const reloaded = JSON.parse(JSON.stringify(data)) as NativePendingEditsData;
  const opened = noticeCopy(copy.encodeState(), client, reloaded);
  assert.deepEqual(opened.pendingEdits?.data(), reloaded);
  assert.deepEqual(opened.offlineNotice("returning"), copy.offlineNotice("returning"));
  copy.close();
  return opened;
}

test("a peer's winning status remains a clash after a later local visual edit and reopen", () => {
  const state = noticeSeed(base);
  for (const peerFirst of [false, true]) {
    let client = 2, writer = noticeCopy(state, client, true);
    const peer = noticeCopy(state, 101);
    const status = { kind: "beat", id: "B", field: "status" } as const;
    const reload = () => { writer = reopenNoticeCopy(writer, ++client); };
    const verify = () => {
      const [clash] = writer.offlineNotice("returning");
      assert.equal(clash?.id, "B");
      assert.deepEqual(clash?.kinds, ["record"]);
      assert.equal(clash?.mine?.fields.status, "ready");
      assert.equal(clash?.merged?.fields.status, "shot");
    };
    try {
      assert.equal(writer.commands.setField(status, "ready").kind, "written");
      reload();
      assert.equal(peer.commands.setField(status, "shot").kind, "written");
      if (peerFirst) {
        noticeDeliver(peer, writer);
        reload();
        verify();
        assert.equal(peer.commands.setField({ ...status, id: "E" }, "ready").kind, "written");
        noticeDeliver(peer, writer);
        reload();
        verify();
      }
      assert.equal(writer.commands.typeText(noticeRange(writer, "B", "visual", 1), "L", {}).kind, "written");
      reload();
      if (!peerFirst) {
        assert.deepEqual(writer.offlineNotice("returning"), []);
        noticeDeliver(peer, writer);
        reload();
      }
      verify();
      assert.equal(peer.commands.setField({ ...status, id: "F" }, "ready").kind, "written");
      noticeDeliver(peer, writer);
      reload();
      verify();
      assert.equal(writer.offlineNotice("returning")[0]?.mine?.visual[0]?.text, "2L");
    } finally { writer.close(); peer.close(); }
  }
});

test("a canceled local status does not claim peer narration lost in a cut, in either delivery order", () => {
  const state = noticeSeed(base);
  for (const peerFirst of [false, true]) {
    let client = 2, writer = noticeCopy(state, client, true);
    const peer = noticeCopy(state, 101), cutter = noticeCopy(state, 102);
    const status = { kind: "beat", id: "B", field: "status" } as const;
    const reload = () => { writer = reopenNoticeCopy(writer, ++client); };
    try {
      assert.equal(writer.commands.setField(status, "ready").kind, "written");
      reload();
      assert.equal(peer.commands.typeText(noticeRange(peer, "B", "narration", 1), "P", {}).kind, "written");
      if (peerFirst) {
        noticeDeliver(peer, writer);
        reload();
        assert.equal(writer.document().rows.find(row => row.id === "B")?.audioText, "dPef");
      }
      assert.equal(writer.commands.setField(status, "todo").kind, "written");
      reload();
      assert.deepEqual(writer.offlineNotice("returning"), []);
      assert.equal(cutter.commands.removeRows(["B"]).kind, "written");
      noticeDeliver(cutter, writer);
      reload();
      assert.deepEqual(writer.offlineNotice("returning"), []);
      if (!peerFirst) {
        noticeDeliver(peer, writer);
        reload();
      }
      assert.deepEqual(writer.offlineNotice("returning"), []);
    } finally { writer.close(); peer.close(); cutter.close(); }
  }
});

test("confirming a held status leaves the visual edit pending without attributing the older status", () => {
  const state = noticeSeed(base), peer = noticeCopy(state, 101);
  let writer = noticeCopy(state, 2, true);
  const status = { kind: "beat", id: "B", field: "status" } as const;
  try {
    assert.equal(writer.commands.setField(status, "ready").kind, "written");
    const receipt = writer.pendingEdits?.confirmationPoint();
    assert.equal(receipt, 1);
    assert.equal(peer.commands.setField(status, "shot").kind, "written");
    noticeDeliver(peer, writer);
    assert.equal(writer.commands.typeText(noticeRange(writer, "B", "visual", 1), "L", {}).kind, "written");
    writer = reopenNoticeCopy(writer, 3);
    assert.deepEqual(writer.offlineNotice("returning").map(clash => clash.kinds), [["record"]]);
    writer.pendingEdits?.clearThrough(receipt);
    assert.deepEqual(writer.offlineNotice("returning"), []);
    assert.deepEqual(writer.pendingEdits?.data().entries.map(entry => [entry.id, entry.first, entry.last]), [["B", 2, 2]]);
    assert.equal(peer.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(peer, writer);
    assert.deepEqual(writer.offlineNotice("returning").map(clash => clash.kinds), [["visual"]]);
  } finally { writer.close(); peer.close(); }
});

test("canceling local text on a cell with peer text does not attribute the peer text to the local writer", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3), cutter = noticeCopy(state, 4);
  try {
    assert.equal(writer.commands.typeText(noticeRange(writer, "B", "narration", 1), "L", {}).kind, "written");
    assert.equal(peer.commands.typeText(noticeRange(peer, "B", "narration", 3), "P", {}).kind, "written");
    noticeDeliver(peer, writer);
    assert.equal(writer.commands.deleteText(noticeRange(writer, "B", "narration", 1, 2)).kind, "written");
    assert.equal(writer.document().rows.find(row => row.id === "B")?.audioText, "defP");
    assert.equal(cutter.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(cutter, writer);
    assert.deepEqual(writer.offlineNotice("returning"), []);
  } finally { writer.close(); peer.close(); cutter.close(); }
});

test("a peer cut reports reordered narration even when the same letters remain", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.replaceText(noticeRange(writer, "B", "narration", 0, 3), [{ text: "fed", marks: {} }]).kind, "written");
    assert.equal(peer.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(peer, writer);
    const [clash] = writer.offlineNotice("returning");
    assert.deepEqual([clash?.id, clash?.kinds, clash?.mine && text(clash.mine)], ["B", ["narration"], "fed"]);
  } finally { writer.close(); peer.close(); }
});

test("a peer cut reports marks moved between identical letters", () => {
  const initial = structuredClone(base);
  initial.visuals.B = "22";
  const state = noticeSeed(initial), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.formatText(noticeRange(writer, "B", "visual", 0, 1), { kind: "plain", mark: "b", on: true }).kind, "written");
    noticeDeliver(writer, peer);
    writer.pendingEdits?.clearThrough(1);
    assert.equal(writer.commands.replaceText(noticeRange(writer, "B", "visual", 0, 2),
      [{ text: "2", marks: {} }, { text: "2", marks: { b: true } }]).kind, "written");
    assert.equal(peer.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(peer, writer);
    assert.deepEqual(writer.offlineNotice("returning").map(clash => [clash.id, clash.kinds]), [["B", ["marks"]]]);
  } finally { writer.close(); peer.close(); }
});

test("serialized notice data shares equal scene orders across unrelated moves", t => {
  const state = largeState(), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    for (let index = 0; index < 24; index++) {
      assert.equal(writer.commands.typeText(noticeRange(writer, "B" + index, "narration", 60), "x", {}).kind, "written");
      assert.equal(peer.commands.moveBlocks([{ kind: "beat", id: "B899" }],
        index % 2 === 0 ? { kind: "beat", id: "B898" } : null).kind, "written");
      noticeDeliver(peer, writer);
    }
    const data = writer.pendingEdits?.data();
    assert.ok(data);
    assert.equal(data.entries.length, 24);
    assert.equal(data.orders?.length, 1);
    const orderBytes = Buffer.byteLength(JSON.stringify(data.orders)), totalBytes = Buffer.byteLength(JSON.stringify(data));
    assert.ok(orderBytes < 600);
    assert.ok(totalBytes < 23_000);
    t.diagnostic(JSON.stringify({ orderBytes, totalBytes }));
  } finally { writer.close(); peer.close(); }
});

test("plain data reopens with the saved beat and a receipt clears only acknowledged entries", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3, true);
  try {
    assert.equal(writer.commands.setField({ kind: "beat", id: "B", field: "status" }, "ready").kind, "written");
    const receipt = writer.pendingEdits?.confirmationPoint();
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
      assert.deepEqual(restored.pendingEdits?.data().entries.map(({ first, last }) => [first, last]), [[2, 4]]);
      assert.equal(restored.pendingEdits?.data().entries[0]?.before?.fields.status, "ready");
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

test("a fresh Yjs tag application with the same visible reading adds no pending edit", () => {
  const copy = noticeCopy(noticeSeed(base), 2, true);
  const tag = { kind: "tag", id: "t:prop:lamp", on: true } as const;
  try {
    const range = noticeRange(copy, "B", "visual", 0, 1);
    assert.equal(copy.commands.formatText(range, tag).kind, "written");
    copy.pendingEdits?.clearThrough(1);
    const before = copy.encodeState();
    assert.equal(copy.commands.formatText(range, tag).kind, "written");
    assert.notDeepEqual(copy.encodeState(), before);
    assert.deepEqual(copy.pendingEdits?.data(), { through: 1, entries: [] });
  } finally { copy.close(); }
});

test("a heading cut at the start of the script has no displaced-text predecessor", () => {
  const copy = noticeCopy(noticeSeed(base), 2, true);
  try {
    assert.equal(copy.commands.createHeading(noticeRange(copy, "A", "narration", 0), "start", "Start").kind, "written");
    const before = copy.pendingEdits?.data();
    assert.equal(copy.commands.removeHeading("start").kind, "written");
    assert.deepEqual(copy.pendingEdits?.data(), before);
  } finally { copy.close(); }
});

test("a restored heading is not a displaced-text source", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.removeHeading("H").kind, "written");
    noticeDeliver(writer, peer);
    assert.equal(peer.commands.restoreHeading("H").kind, "written");
    assert.equal(peer.commands.typeText(noticeRange(peer, "D", "narration", 3), "P", {}).kind, "written");
    noticeDeliver(peer, writer);
    assert.equal(writer.document().rows.find(row => row.id === "D")?.audioText, "jklP");
    const { sections } = writer.document();
    assert.ok(Array.isArray(sections));
    assert.equal(sections.some((section: { readonly id: string }) => section.id === "H"), true);
    assert.deepEqual(writer.offlineNotice("returning"), []);
  } finally { writer.close(); peer.close(); }
});

test("ordinary cell and field writes do not ask the reader to rebuild journal placement", t => {
  const copy = noticeCopy(noticeSeed(base), 2, true);
  const outline = t.mock.method(NativeScriptReader.prototype, "outline");
  try {
    assert.equal(copy.commands.setField({ kind: "beat", id: "B", field: "notes" }, "new").kind, "written");
    assert.equal(copy.commands.typeText(noticeRange(copy, "B", "visual", 1), "x", {}).kind, "written");
    assert.equal(outline.mock.callCount(), 0);
    assert.equal(copy.commands.removeHeading("H").kind, "written");
    assert.ok(outline.mock.callCount() > 0);
  } finally { outline.mock.restore(); copy.close(); }
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

test("cutting a joined member updates placement while its visible row stays", () => {
  const initial = structuredClone(base);
  initial.beats.C = { joined: { into: "B", glue: " " } };
  const copy = noticeCopy(noticeSeed(initial), 2, true);
  try {
    const rows = copy.document().rows.map(row => row.id);
    assert.equal(copy.commands.removeRows(["C"]).kind, "written");
    assert.deepEqual(copy.document().rows.map(row => row.id), rows);
    assert.equal(copy.commands.setField({ kind: "beat", id: "B", field: "notes" }, "kept").kind, "written");
    const data = copy.pendingEdits?.data(), saved = data?.entries.find(entry => entry.id === "B")?.after;
    assert.equal(data?.entries.find(entry => entry.id === "C")?.after, null);
    assert.ok(saved);
    assert.deepEqual(data?.orders?.[saved.placement.order], ["A", "B", "D"]);
  } finally { copy.close(); }
});

test("undo of a cut tracks a newly visible empty joined member", () => {
  const initial = structuredClone(base);
  initial.beats.C = { joined: { into: "B", glue: " " } };
  const script = initial.segments.S;
  assert.ok(script);
  script.units.splice(-3);
  initial.visuals.C = "";
  const copy = noticeCopy(noticeSeed(initial), 2, true);
  try {
    assert.equal(copy.commands.removeRows(["C"]).kind, "written");
    assert.equal(copy.commands.undo().kind, "written");
    const caught = copy.pendingEdits?.data().entries.find(entry => entry.id === "C");
    assert.equal(caught?.restored, caught?.last);
    assert.equal(caught?.after?.row, "B");
  } finally { copy.close(); }
});

test("a split child records its initial cells and redo of an existing beat does not record a creation", () => {
  const copy = noticeCopy(noticeSeed(base), 2, true);
  try {
    const split = copy.commands.splitRow(noticeRange(copy, "B", "narration", 1));
    assert.equal(split.kind, "written");
    const journal = copy.pendingEdits;
    assert.ok(journal);
    const child = journal.data().entries.find(entry => entry.id === split.created);
    assert.equal(child?.before && text(child.before), "ef");
    assert.deepEqual(child?.before?.visual, []);
    assert.equal(copy.commands.setField({ kind: "beat", id: "B", field: "notes" }, "redo").kind, "written");
    assert.equal(copy.commands.undo().kind, "written");
    assert.equal(copy.commands.redo().kind, "written");
    const existing = journal.data().entries.find(entry => entry.id === "B");
    assert.equal(existing?.after?.fields.notes, "redo");
    assert.equal(existing?.created, undefined);
  } finally { copy.close(); }
});

test("an acknowledged split, insertion or restoration loses its marker while later work stays pending", () => {
  const state = noticeSeed(base);
  for (const kind of ["split", "created", "restored"] as const) {
    const copy = noticeCopy(state, 2, true);
    try {
      let id = "B";
      if (kind === "split") {
        const split = copy.commands.splitRow(noticeRange(copy, "B", "narration", 1));
        assert.equal(split.kind, "written");
        id = split.created;
      } else if (kind === "created") {
        const inserted = copy.commands.putBack({
          id, narration: [{ text: "words", marks: {} }], visual: [], fields: {},
          placement: { scene: null, left: "A", right: "C", sceneOrder: ["A", "B", "C"] }
        });
        assert.equal(inserted.kind, "written");
        id = inserted.created;
      } else {
        assert.equal(copy.commands.removeRows([id]).kind, "written");
        assert.equal(copy.commands.undo().kind, "written");
      }
      const journal = copy.pendingEdits;
      assert.ok(journal);
      assert.notEqual(journal.data().entries.find(entry => entry.id === id)?.[kind], undefined);
      const receipt = journal.confirmationPoint();
      assert.equal(copy.commands.setField({ kind: "beat", id, field: "notes" }, "later").kind, "written");
      journal.clearThrough(receipt);
      const [remaining] = journal.data().entries;
      assert.equal(remaining?.id, id);
      assert.equal(remaining?.first, receipt + 1);
      assert.equal(remaining?.[kind], undefined);
      assert.equal(remaining?.after?.fields.notes, "later");
    } finally { copy.close(); }
  }
});

test("the first in-flight receipt stays until its threshold and later records keep their start", () => {
  const copy = noticeCopy(noticeSeed(base), 2, true);
  try {
    const journal = copy.pendingEdits;
    assert.ok(journal);
    assert.equal(journal.confirmationPoint(), 0);
    assert.deepEqual(journal.data(), { through: 0, entries: [] });
    assert.equal(copy.commands.setField({ kind: "beat", id: "B", field: "status" }, "ready").kind, "written");
    assert.equal(copy.commands.setField({ kind: "beat", id: "A", field: "notes" }, "first point").kind, "written");
    const receipt = journal.confirmationPoint();
    assert.equal(receipt, 2);
    assert.equal(copy.commands.typeText(noticeRange(copy, "B", "visual", 1), "L", {}).kind, "written");
    assert.equal(copy.commands.setField({ kind: "beat", id: "C", field: "notes" }, "later").kind, "written");
    assert.equal(journal.confirmationPoint(), receipt);
    journal.clearThrough(receipt - 1);
    const interim = journal.data();
    assert.equal(interim.checkpoint?.through, receipt);
    assert.equal(interim.entries.find(entry => entry.id === "B")?.before?.fields.status, "todo");
    assert.equal(interim.entries.find(entry => entry.id === "C")?.first, 4);
    journal.clearThrough(receipt);
    const final = journal.data();
    assert.equal(final.checkpoint, undefined);
    assert.equal(final.entries.find(entry => entry.id === "B")?.before?.fields.status, "ready");
    assert.deepEqual(final.entries.map(entry => [entry.id, entry.first, entry.last]), [["B", 3, 3], ["C", 4, 4]]);
  } finally { copy.close(); }
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

test("local split, move, join, edit, cut and undo produce no clash on their own", () => {
  const state = noticeSeed(base), copy = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    const split = copy.commands.splitRow(noticeRange(copy, "B", "narration", 1));
    assert.equal(split.kind, "written");
    assert.equal(copy.commands.moveBlocks([{ kind: "beat", id: "B" }], { kind: "beat", id: "D" }).kind, "written");
    assert.equal(copy.commands.joinRow("C", split.created, " ").kind, "written");
    assert.equal(copy.commands.typeText(noticeRange(copy, "A", "visual", 1), "Ω", {}).kind, "written");
    assert.equal(copy.commands.setField({ kind: "beat", id: "A", field: "notes" }, "local").kind, "written");
    assert.equal(copy.commands.removeRows(["D"]).kind, "written");
    assert.equal(copy.commands.undo().kind, "written");
    assert.deepEqual(copy.offlineNotice("returning"), []);
    assert.equal(peer.commands.setField({ kind: "beat", id: "F", field: "notes" }, "peer").kind, "written");
    noticeDeliver(peer, copy);
    assert.deepEqual(copy.offlineNotice("returning"), []);
  } finally { copy.close(); peer.close(); }
});

test("a restored creation stays pending past a receipt through its undo", () => {
  const state = noticeSeed(sole), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.removeRows(["A"]).kind, "written");
    const journal = writer.pendingEdits;
    assert.ok(journal);
    const removed = journal.data().entries[0]?.before;
    assert.ok(removed);
    const { result, recordAfter } = writer.commands.putBack.withSelection(null,
      { ...removed, placement: { scene: null, left: null, right: null, sceneOrder: ["A"] } });
    assert.equal(result.kind, "written");
    assert.equal(journal.data().entries.find(entry => entry.id === result.created)?.created, 2);
    recordAfter(noticeRange(writer, result.created, "narration", 0));
    assert.equal(writer.commands.undo().kind, "written");
    const throughUndo = journal.confirmationPoint();
    assert.equal(writer.commands.redo().kind, "written");
    journal.clearThrough(throughUndo);
    assert.deepEqual(journal.data().entries.map(entry => [entry.id, entry.first, entry.created]),
      [[result.created, throughUndo + 1, throughUndo + 1]]);
    noticeDeliver(writer, peer);
    assert.equal(peer.commands.removeRows([result.created]).kind, "written");
    noticeDeliver(peer, writer);
    assert.deepEqual(writer.offlineNotice("returning").map(clash => [clash.id, clash.kinds]), [[result.created, ["narration"]]]);
  } finally { writer.close(); peer.close(); }
});

test("a scene cut reports each displaced transfer once and a beat with no same-scene predecessor stays silent", () => {
  const state = noticeSeed(base);
  for (const scene of [false, true]) {
    const cutter = noticeCopy(state, 2, true), writer = noticeCopy(state, 3);
    try {
      if (scene) assert.equal(cutter.commands.removeHeading("I").kind, "written");
      assert.equal(cutter.commands.removeRows(["F"]).kind, "written");
      assert.equal(cutter.pendingEdits?.data().entries.find(entry => entry.id === "F")?.landingId, scene ? "E" : undefined);
      assert.equal(writer.commands.typeText(noticeRange(writer, "F", "narration", 1), "Ω", {}).kind, "written");
      noticeDeliver(writer, cutter);
      assert.deepEqual(cutter.offlineNotice("returning").map(clash => [clash.id, clash.near, clash.kinds]),
        scene ? [["F", "E", ["displaced"]]] : []);
    } finally { cutter.close(); writer.close(); }
  }
});

test("a cut compares the current local landing text and requires the source to stay absent", () => {
  const state = noticeSeed(base), cutter = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  const secondCutter = noticeCopy(state, 4, true), restorer = noticeCopy(state, 5);
  try {
    assert.equal(cutter.commands.removeRows(["B"]).kind, "written");
    assert.equal(cutter.commands.typeText(noticeRange(cutter, "A", "narration", 3), "L", {}).kind, "written");
    assert.equal(peer.commands.setField({ kind: "beat", id: "C", field: "notes" }, "peer").kind, "written");
    noticeDeliver(peer, cutter);
    assert.deepEqual(cutter.offlineNotice("returning"), []);
    assert.equal(secondCutter.commands.removeRows(["B"]).kind, "written");
    assert.equal(restorer.commands.removeRows(["B"]).kind, "written");
    assert.equal(restorer.commands.undo().kind, "written");
    assert.equal(restorer.commands.typeText(noticeRange(restorer, "A", "narration", 3), "P", {}).kind, "written");
    noticeDeliver(restorer, secondCutter);
    assert.equal(secondCutter.document().rows.find(row => row.id === "B")?.audioText, "def");
    assert.equal(secondCutter.document().rows.find(row => row.id === "A")?.audioText, "abcP");
    assert.deepEqual(secondCutter.offlineNotice("returning"), []);
  } finally { cutter.close(); peer.close(); secondCutter.close(); restorer.close(); }
});

test("a text overwrite can remove a pending insertion but does not diagnose double undo", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.typeText(noticeRange(writer, "B", "narration", 1), "Ω", {}).kind, "written");
    noticeDeliver(writer, peer);
    assert.equal(peer.commands.deleteText(noticeRange(peer, "B", "narration", 0, 4)).kind, "written");
    noticeDeliver(peer, writer);
    assert.deepEqual(writer.offlineNotice("returning").map(clash => clash.kinds), [["narration"]]);
  } finally { writer.close(); peer.close(); }
});

test("edit stamps alone do not turn a reverted edit into a removal clash", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    const stamp = { at: "2030-01-01T00:00:00Z", by: "writer" };
    assert.equal(writer.commands.typeText(noticeRange(writer, "B", "narration", 1), "Ω", {}, stamp).kind, "written");
    assert.equal(writer.commands.deleteText(noticeRange(writer, "B", "narration", 1, 2), stamp).kind, "written");
    assert.equal(peer.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(peer, writer);
    assert.deepEqual(writer.offlineNotice("returning"), []);
  } finally { writer.close(); peer.close(); }
});

test("join cards require a pending join mismatch in the merged reading", () => {
  const initial = structuredClone(base);
  initial.beats.C = { joined: { into: "B", glue: " " } };
  const cases = [
    { state: noticeSeed(initial), local: "visual", remote: "cut", kinds: [] },
    { state: noticeSeed(base), local: "join", remote: "unrelated", kinds: [] },
    { state: noticeSeed(base), local: "join", remote: "cut", kinds: [["join"]] },
    { state: noticeSeed(base), local: "cancel", remote: "join", kinds: [] }
  ];
  for (const { state, local, remote, kinds } of cases) {
    const writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
    try {
      if (local === "visual") assert.equal(writer.commands.typeText(noticeRange(writer, "C", "visual", 1), "Ω", {}).kind, "written");
      else assert.equal(writer.commands.joinRow("C", "B", " ").kind, "written");
      if (local === "cancel") assert.equal(writer.commands.unjoinRow("C").kind, "written");
      if (remote === "cut") assert.equal(peer.commands.removeRows(["B"]).kind, "written");
      if (remote === "join") assert.equal(peer.commands.joinRow("C", "B", " ").kind, "written");
      if (remote === "unrelated") assert.equal(peer.commands.setField({ kind: "beat", id: "F", field: "notes" }, "peer").kind, "written");
      noticeDeliver(peer, writer);
      assert.deepEqual(writer.offlineNotice("returning").map(clash => clash.kinds), kinds, JSON.stringify({ local, remote }));
    } finally { writer.close(); peer.close(); }
  }
});

test("the split origin belongs only to the new beat and a removed parent is not a move", () => {
  const state = noticeSeed(base);
  for (const removeParent of [false, true]) {
    const writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
    try {
      const split = writer.commands.splitRow(noticeRange(writer, "B", "narration", 1));
      assert.equal(split.kind, "written");
      noticeDeliver(writer, peer);
      if (removeParent) assert.equal(peer.commands.removeRows(["B"]).kind, "written");
      else assert.equal(peer.commands.moveBlocks([{ kind: "beat", id: "A" }], { kind: "beat", id: "D" }).kind, "written");
      noticeDeliver(peer, writer);
      assert.deepEqual(writer.offlineNotice("returning").map(clash => [clash.id, clash.kinds]),
        removeParent ? [["B", ["narration"]]] : []);
    } finally { writer.close(); peer.close(); }
  }
});

test("a peer undo returning erased visual text is reported as a visual clash", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.deleteText(noticeRange(writer, "B", "visual", 0, 1)).kind, "written");
    assert.equal(peer.commands.deleteText(noticeRange(peer, "B", "visual", 0, 1)).kind, "written");
    assert.equal(peer.commands.undo().kind, "written");
    noticeDeliver(peer, writer);
    const [clash] = writer.offlineNotice("returning");
    assert.equal(clash?.merged?.visual[0]?.text, "2");
    assert.deepEqual(clash?.kinds, ["visual"]);
  } finally { writer.close(); peer.close(); }
});

test("an empty beat stays silent after its removal and undo alongside a peer update", () => {
  const initial = structuredClone(sole);
  initial.segments.S = { head: { kind: "b", id: "A" }, units: [] };
  const state = noticeSeed(initial), copy = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    assert.equal(copy.commands.removeRows(["A"]).kind, "written");
    assert.equal(copy.commands.undo().kind, "written");
    assert.equal(peer.commands.setField({ kind: "beat", id: "A", field: "notes" }, "peer").kind, "written");
    noticeDeliver(peer, copy);
    assert.equal(copy.document().rows[0]?.audioText, "");
    assert.deepEqual(copy.offlineNotice("returning"), []);
  } finally { copy.close(); peer.close(); }
});

test("undo on an already visible beat does not diagnose double undo when a peer erases it", () => {
  const state = noticeSeed(base), writer = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.typeText(noticeRange(writer, "B", "narration", 1), "Ω", {}).kind, "written");
    assert.equal(writer.commands.undo().kind, "written");
    assert.equal(peer.commands.deleteText(noticeRange(peer, "B", "narration", 0, 3)).kind, "written");
    noticeDeliver(peer, writer);
    assert.equal(writer.document().rows.find(row => row.id === "B")?.audioText, "");
    assert.deepEqual(writer.offlineNotice("returning"), []);
  } finally { writer.close(); peer.close(); }
});

test("a local transaction alone does not mark pending edits as having a peer update", () => {
  const copy = noticeCopy(noticeSeed(base), 2, true);
  try {
    assert.equal(copy.commands.setField({ kind: "beat", id: "B", field: "status" }, "ready").kind, "written");
    declareNativeRoots(copy.ydoc).beats.get("B")?.set("status", '"shot"');
    assert.equal(copy.document().rows.find(row => row.id === "B")?.status, "shot");
    assert.deepEqual(copy.offlineNotice("returning"), []);
  } finally { copy.close(); }
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

test("the reader's narration-only fallback is not a physical notice beat", () => {
  const state = noticeSeed(sole), writer = noticeCopy(state, 2, true), cutter = noticeCopy(state, 3);
  try {
    assert.equal(writer.commands.typeText(noticeRange(writer, "A", "narration", 1), "Ω", {}).kind, "written");
    assert.equal(cutter.commands.removeRows(["A"]).kind, "written");
    noticeDeliver(cutter, writer);
    const visible = writer.document().rows[0];
    assert.equal(visible?.audioText, "Ω");
    assert.ok(visible);
    assert.equal(readNativeOnce(declareNativeRoots(writer.ydoc), reader => reader.noticeBeat(visible.id)), null);
    assert.deepEqual(writer.offlineNotice("returning").map(clash => clash.id), ["A"]);
  } finally { writer.close(); cutter.close(); }
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
    const result = copy.commands.putBack({ ...saved, placement: { scene: null, left: null, right: null, sceneOrder: ["A"] } });
    assert.equal(result.kind, "written");
    assert.deepEqual(copy.document().rows.map(row => [row.id, row.audioText, row.visualText]), [[result.created, "abc", "1"]]);
    assert.equal(copy.commands.undo().kind, "written");
    assert.deepEqual(copy.document().rows, []);
  } finally { copy.close(); }
});
