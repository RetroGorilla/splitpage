import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { addBeatCommand } from "../../../../src/application/commands/rows.ts";
import { createSessionCapabilities } from "../../../../src/application/session/capabilities.ts";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { sceneForBeat } from "../../../../src/core/document/scenes.ts";
import { beatPos, caretAt, enterAt } from "../../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../../src/core/flow/flow.ts";
import { declareNativeRoots } from "../../../../src/adapters/collab/native/roots.ts";
import { nativeRankBetween } from "../../../../src/adapters/collab/native/rank.ts";
import { convertedScript } from "./helpers.ts";
import { noticeCopy, noticeDeliver, noticeRange } from "./notice-harness.ts";
import { structureScript } from "./structure-harness.ts";

const source = structureScript({ A: "Alpha", B: "Beta", C: "Gamma", D: "Delta" }, { B: "Look" }, [
  { id: "first", name: "First scene", before: "A" },
  { id: "second", name: "Second scene", before: "C" }
]);
const stamp = { by: "Writer", at: "2026-11-20T00:00:00.000Z" };
const seed = convertedScript(source);
const bytes = Y.encodeStateAsUpdate(seed.doc);
seed.doc.destroy();

const ids = (copy: ReturnType<typeof noticeCopy>) => copy.document().rows.map(row => row.id);
const allowed = () => ({ allowed: true } as const);
const capability = createSessionCapabilities("standalone", { edit: allowed, comment: allowed });

for (const [anchor, side, left, right, index] of [
  ["A", "above", "first", "A", 0],
  ["B", "below", "B", "second", 2],
  ["C", "above", "second", "C", 2],
  ["D", "below", "D", null, 4],
] as const) {
  test(`insert ${side} ${anchor}: rank, standalone result, one update and selection-aware undo and redo`, async t => {
    const writer = noticeCopy(bytes, 2), { commands } = writer;
    t.after(writer.close);
    const before = writer.document(), roots = declareNativeRoots(writer.ydoc);
    const rankOf = (id: string | null) => id === null ? null : (roots.beats.get(id) ?? roots.headings.get(id))?.get("rank") as string;
    const expectedRank = nativeRankBetween(rankOf(left), rankOf(right));
    const events: string[] = [];
    writer.subscribe(event => events.push(event.kind));
    let updates = 0;
    writer.ydoc.on("update", () => { updates++; });
    const step = commands.insertAdjacentBeat.withSelection(noticeRange(writer, anchor, "narration", 2), anchor, side, stamp);
    assert.equal(step.result.kind, "written");
    const { created } = step.result, key = "b:" + created;
    step.recordAfter(noticeRange(writer, created, "narration", 0));
    await Promise.resolve();
    assert.equal(updates, 1);
    assert.deepEqual(events, ["changed"]);
    assert.equal(ids(writer)[index], created);
    assert.equal(rankOf(created), expectedRank);
    assert.deepEqual(roots.segments.get(key)?.get("head"), { b: created });
    assert.ok(roots.segments.get(key)?.get("text") instanceof Y.Text);
    assert.ok(roots.visuals.get(created) instanceof Y.Text);
    const after = writer.document();
    assert.equal(sceneForBeat(after, created)?.id, sceneForBeat(before, anchor)?.id);
    const standalone = migrateRows(structuredClone(before));
    if (side === "below") {
      const command = addBeatCommand(anchor, created, { editor: { name: () => stamp.by }, clock: { nowIso: () => stamp.at } });
      const plan = command.plan(standalone, capability);
      assert.ok(plan && "apply" in plan && plan.apply);
      plan.apply(standalone);
      assert.deepEqual(migrateRows(structuredClone(after)), standalone);
    } else {
      const position = caretAt(beatPos(anchor, 0));
      const plan = enterAt(standalone as unknown as FlowDoc, position, {
        cells: text => text ? [{ text, marks: {} }] : [], hasVisual: () => false, newId: () => created
      });
      assert.ok(plan && "rows" in plan);
      assert.deepEqual(migrateRows({ ...standalone, rows: plan.rows.map(row => row.id === created
        ? { ...row, updatedBy: stamp.by, updatedAt: stamp.at } : row), sections: plan.sections }), migrateRows(structuredClone(after)));
    }
    const point = (beat: string, offset: number) => ({ target: { beat, cell: "narration" }, offset });
    const undone = commands.undo();
    assert.equal(undone.kind, "written");
    assert.deepEqual(undone.selection, { anchor: point(anchor, 2), head: point(anchor, 2) });
    assert.deepEqual(writer.document(), before);
    assert.deepEqual(commands.undo(), { kind: "unchanged" });
    const redone = commands.redo();
    assert.equal(redone.kind, "written");
    assert.deepEqual(redone.selection, { anchor: point(created, 0), head: point(created, 0) });
    assert.deepEqual(writer.document(), after);
    assert.deepEqual(commands.redo(), { kind: "unchanged" });
  });
}

for (const side of ["above", "below"] as const) {
  for (const reverse of [false, true]) {
    test(`concurrent ${side} inserts both survive in the same order (reverse delivery: ${reverse})`, t => {
      const writer = noticeCopy(bytes, 2), peer = noticeCopy(bytes, 3);
      const forward = noticeCopy(bytes, 4), backward = noticeCopy(bytes, 5);
      const copies = [writer, peer, forward, backward];
      t.after(() => { for (const copy of copies) copy.close(); });
      const a = writer.commands.insertAdjacentBeat("B", side), b = peer.commands.insertAdjacentBeat("B", side);
      assert.equal(a.kind, "written");
      assert.equal(b.kind, "written");
      const merged = [a.created, b.created];
      assert.equal(new Set(merged).size, 2);
      const [first, second] = reverse ? [peer, writer] : [writer, peer];
      noticeDeliver(first, forward);
      noticeDeliver(second, forward);
      noticeDeliver(second, backward);
      noticeDeliver(first, backward);
      noticeDeliver(forward, first);
      noticeDeliver(backward, second);
      const final = forward.document();
      for (const copy of copies) assert.deepEqual(copy.document(), final);
      const at = side === "above" ? 1 : 2;
      assert.deepEqual(ids(writer).slice(at, at + 2).sort(), merged.sort());
      assert.deepEqual(ids(writer).filter(id => !merged.includes(id)), ["A", "B", "C", "D"]);
      for (const id of merged) assert.equal(sceneForBeat(final, id)?.id, "first");
      assert.equal(writer.commands.undo().kind, "written");
      noticeDeliver(writer, peer);
      assert.deepEqual(ids(peer), ids(writer));
      assert.ok(ids(peer).includes(b.created));
      assert.ok(!ids(peer).includes(a.created));
    });

  }

  test(`insert ${side} refuses a target removed by a peer without publishing`, t => {
    const writer = noticeCopy(bytes, 2), peer = noticeCopy(bytes, 3);
    t.after(() => { writer.close(); peer.close(); });
    assert.equal(peer.commands.removeRows(["B"]).kind, "written");
    noticeDeliver(peer, writer);
    const before = writer.encodeState();
    assert.deepEqual(writer.commands.insertAdjacentBeat("B", side), { kind: "refused", reason: "missing" });
    assert.deepEqual(writer.encodeState(), before);
    assert.deepEqual(writer.commands.undo(), { kind: "unchanged" });
  });
}

test("insert between tied split ranks places the blank at the gap and undo restores the original ranks", t => {
  const writer = noticeCopy(bytes, 2), { commands } = writer;
  t.after(writer.close);
  const split = commands.splitRow(noticeRange(writer, "B", "narration", 2));
  assert.equal(split.kind, "written");
  const roots = declareNativeRoots(writer.ydoc), splitRecord = roots.beats.get(split.created);
  const originalRank = splitRecord?.get("rank");
  assert.equal(originalRank, roots.beats.get("B")?.get("rank"));
  const inserted = commands.insertAdjacentBeat(split.created, "above");
  assert.equal(inserted.kind, "written");
  assert.deepEqual(ids(writer), ["A", "B", inserted.created, split.created, "C", "D"]);
  assert.notEqual(splitRecord?.get("rank"), originalRank);
  assert.equal(commands.undo().kind, "written");
  assert.deepEqual(ids(writer), ["A", "B", split.created, "C", "D"]);
  assert.equal(splitRecord?.get("rank"), originalRank);
});

test("insert below a joined row keeps its members together", t => {
  const writer = noticeCopy(bytes, 2);
  t.after(writer.close);
  assert.equal(writer.commands.joinRow("B", "A", " ").kind, "written");
  const inserted = writer.commands.insertAdjacentBeat("A", "below");
  assert.equal(inserted.kind, "written");
  assert.deepEqual(ids(writer), ["A", inserted.created, "C", "D"]);
  assert.equal(writer.document().rows[0]?.audioText, "Alpha Beta");
});

test("insert beside leading unranked beats preserves the gap and restores their rankless state on undo", t => {
  const writer = noticeCopy(bytes, 2), { commands } = writer;
  t.after(writer.close);
  const roots = declareNativeRoots(writer.ydoc), heading = roots.headings.get("first"), first = roots.beats.get("A");
  writer.ydoc.transact(() => {
    heading?.delete("rank");
    first?.delete("rank");
  }, "peer");
  const inserted = commands.insertAdjacentBeat("A", "above");
  assert.equal(inserted.kind, "written");
  assert.deepEqual(ids(writer), [inserted.created, "A", "B", "C", "D"]);
  assert.equal(sceneForBeat(writer.document(), inserted.created)?.id, "first");
  assert.equal(commands.undo().kind, "written");
  assert.equal(heading?.has("rank"), false);
  assert.equal(first?.has("rank"), false);
  assert.deepEqual(ids(writer), ["A", "B", "C", "D"]);
});
