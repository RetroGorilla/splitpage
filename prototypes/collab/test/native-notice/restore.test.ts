import assert, { AssertionError } from "node:assert/strict";
import { test } from "node:test";
import type * as Y from "yjs";
import { compareNotices, reviewStillOpen, type NoticeBeat, type NoticeReading } from "../../src/native-notice/compare.ts";
import { putNoticeBack, readNotice, type RestoreWrite } from "../../src/native-notice/yjs.ts";
import type { MoveReplica } from "../../src/native-moves/ranks.ts";
import { nativeMarkName, type NativeDeltaItem } from "../../src/native/variant.ts";
import { base } from "../native-delete/model.ts";
import { assertConverged, deliver, rankedSeed, replicaFrom, rowText, write } from "./kit.ts";

const narration = [
  { insert: "go", marks: { b: true, "t:TAG": true } },
  { insert: { k: "shot", label: "B-roll" }, marks: { i: true } },
  { insert: " now" }
];
const visual = [{ insert: "frame", marks: { "t:CAM": true } }, { insert: { w: "Crew" } }, { insert: " wide" }];
const fields = { notes: { line: "keep" }, lengthSeconds: 2 };

function withCopies(run: (first: MoveReplica, second: MoveReplica, common: NoticeReading) => void): void {
  const seeded = rankedSeed(base), first = replicaFrom(seeded.encode(), 101), second = replicaFrom(seeded.encode(), 102);
  try { run(first, second, readNotice(seeded)); }
  finally { seeded.destroy(); first.destroy(); second.destroy(); }
}

function richMine(base: NoticeReading): NoticeReading {
  return base.map(beat => beat.id === "B" ? { ...beat, narration, visual, fields, status: "filmed" } : beat);
}

function rawRestore(replica: MoveReplica): unknown {
  const key = "seg-b-saved";
  const segment = replica.segments.get(key), record = replica.beats.get("saved");
  const normalized = (text: Y.Text | undefined) => (text?.toDelta() as NativeDeltaItem[] | undefined)?.map(item => {
    if (!item.attributes) return item;
    const normalizedKey = (key: string) => key.startsWith("t:") && nativeMarkName(key) === key ? "bare-" + key : nativeMarkName(key);
    return { ...item, attributes: Object.fromEntries(Object.entries(item.attributes).map(([key, value]) => [normalizedKey(key), value])) };
  });
  return {
    segment: replica.segments.has(key), ordered: replica.order.toArray().includes(key),
    head: segment?.get("head"), narration: normalized(segment?.get("text") as Y.Text | undefined),
    beat: replica.beats.has("saved"), rank: typeof record?.get("e10Rank") === "string",
    status: record?.get("status"), notes: record?.get("notes"), lengthSeconds: record?.get("lengthSeconds"),
    visual: normalized(replica.visuals.get("saved"))
  };
}

test("each restored tag application uses a fresh writer and clock key", () => {
  withCopies((first, second, common) => {
    const tagged = { "t:TAG": true };
    const mine = common.map(beat => beat.id === "B" ? { ...beat, narration: [
      { insert: "d", marks: tagged }, { insert: "e", marks: { ...tagged, b: true } }, { insert: " " }, { insert: "f", marks: tagged }
    ], visual: [{ insert: "2", marks: tagged }] } : beat);
    for (const copy of [first, second]) {
      write(copy, { op: "rows", ids: ["B"] });
      putNoticeBack(copy, mine, "B", "saved-" + copy.doc.clientID, 1);
    }
    deliver(first, second); deliver(second, first);
    assertConverged([first, second]);
    const taggedKeys = (text: Y.Text | undefined) => (text?.toDelta() as NativeDeltaItem[] | undefined ?? []).flatMap(item =>
      Object.keys(item.attributes ?? {}).filter(key => nativeMarkName(key) === "t:TAG"));
    const all = [101, 102].flatMap(client => {
      const id = "saved-" + client;
      const [left, adjacent, separated] = taggedKeys(first.segments.get("seg-b-" + id)?.get("text") as Y.Text);
      const [visual] = taggedKeys(first.visuals.get(id));
      assert.ok(left && adjacent && separated && visual);
      assert.equal(left, adjacent);
      const pattern = new RegExp(`^t:TAG\u001f${client.toString(36)}\\.[0-9a-z]+$`);
      for (const key of [left, separated, visual]) assert.match(key, pattern);
      return [left, separated, visual];
    });
    assert.equal(new Set(all).size, 6);
  });
});

function checkRichRestore(replica: MoveReplica): void {
  assert.deepEqual(rawRestore(replica), {
    segment: true, ordered: true, head: { b: "saved" },
    narration: [{ insert: "go", attributes: { b: true, "t:TAG": true } },
      { insert: { k: "shot", label: "B-roll" }, attributes: { i: true } }, { insert: " now" }],
    beat: true, rank: true, status: "filmed", notes: { line: "keep" }, lengthSeconds: 2,
    visual: [{ insert: "frame", attributes: { "t:CAM": true } }, { insert: { w: "Crew" } }, { insert: " wide" }]
  }, "stored put-back sub-writes");
}

test("a fresh beat copies marked text, tags, embeds, status and fields in one ordinary undo step", () => {
  withCopies((first, second, common) => {
    write(first, { op: "rows", ids: ["B"] });
    const before = first.undo.undoStack.length;
    assert.throws(() => putNoticeBack(first, richMine(common), "B", "B", 1), /fresh id/);
    putNoticeBack(first, richMine(common), "B", "saved", 1);
    checkRichRestore(first);
    assert.equal(first.undo.undoStack.length, before + 1);
    deliver(first, second);
    assert.deepEqual(assertConverged([first, second]).slice(0, 3).map(beat => beat.id), ["A", "saved", "C"]);
    assert.equal(second.undo.undoStack.length, 0);
    write(first, { op: "undo" });
    deliver(first, second);
    assert.equal(first.undo.undoStack.length, before);
    assert.equal(first.beats.has("B"), false);
    assert.equal(first.beats.has("saved"), false);
    assert.equal(first.visuals.has("saved"), false);
    assert.equal(first.segments.has("seg-b-saved"), false);
    assertConverged([first, second]);
  });
});

test("each silent Yjs call is caught at the put-back command", () => {
  const calls = [
    "head", "narration-cell", "segment", "narration", "narration-embed", "narration", "order",
    "rank", "status", "field", "field", "beat", "visual-cell", "visual", "visual-embed", "visual"
  ] as const satisfies readonly RestoreWrite[];
  const results: Record<string, { used: number; effective: number; failed: number }> = {};
  calls.forEach((omitted, target) => withCopies((first, _second, common) => {
    const count = results[omitted] ??= { used: 0, effective: 0, failed: 0 };
    write(first, { op: "rows", ids: ["B"] });
    const observed: RestoreWrite[] = [];
    try {
      putNoticeBack(first, richMine(common), "B", "saved", 1, (part, write) => {
        const index = observed.push(part) - 1;
        if (index === target) count.used++;
        else write();
      });
    } catch {
      count.failed++;
      return;
    }
    if (observed.length !== calls.length || observed.some((part, index) => part !== calls[index])) {
      count.failed++;
      return;
    }
    try {
      checkRichRestore(first);
      count.failed++;
    } catch (error) {
      if (error instanceof AssertionError) count.effective++;
      else count.failed++;
    }
  }));
  console.log(JSON.stringify(results));
  for (const result of Object.values(results)) {
    assert.equal(result.used, result.effective);
    assert.equal(result.failed, 0);
  }
  assert.equal(Object.values(results).reduce((sum, result) => sum + result.effective, 0), calls.length);
});

test("placement uses old neighbours in the old scene, then scene end or unheaded end", () => {
  withCopies((first, _second, common) => {
    write(first, { op: "rows", ids: ["B"] });
    write(first, { op: "move", id: "A", after: "F" });
    putNoticeBack(first, common, "B", "before-right", 1);
    assert.deepEqual(readNotice(first).slice(0, 3).map(beat => beat.id), ["before-right", "C", "D"]);
  });
  withCopies((first, _second, common) => {
    write(first, { op: "rows", ids: ["A", "B", "C", "D"] });
    assert.equal(first.moveRefs("b:F", "b:F", null), true);
    putNoticeBack(first, common, "B", "at-end", 1);
    assert.deepEqual(readNotice(first).slice(0, 3).map(beat => beat.id), ["F", "at-end", "E"]);
  });
  withCopies((first, _second, common) => {
    write(first, { op: "rows", ids: ["E"] });
    first.removeHeading("H");
    putNoticeBack(first, common, "E", "unheaded", 1);
    const rows = readNotice(first);
    assert.deepEqual(rows.slice(-2).map(beat => [beat.id, beat.scene]), [["unheaded", null], ["F", "I"]]);
    assert.equal(first.headings.get("H")?.get("removed"), true);
  });
});

test("double delete and double undo can leave two stored narrations and a put-back adds a third", () => {
  withCopies((first, second, common) => {
    for (const copy of [first, second]) {
      write(copy, { op: "rows", ids: ["B"] });
      write(copy, { op: "undo" });
      assert.deepEqual(compareNotices(common, readNotice(copy), readNotice(copy)), []);
    }
    const mine = readNotice(first);
    deliver(first, second); deliver(second, first);
    const [clash] = compareNotices(common, mine, readNotice(first));
    assert.ok(clash);
    assert.equal(clash.kind, "double-undo");
    assert.equal(rowText(readNotice(first), "narration", "B"), "");
    assert.equal((first.segments.get("S")?.get("text") as Y.Text).toString(), "abcdefdefghi");
    putNoticeBack(first, mine, "B", "saved", 1);
    assert.equal(rowText(readNotice(first), "narration", "saved"), "def");
    assert.equal((first.segments.get("S")?.get("text") as Y.Text).toString(), "abcdefdefghi");
    write(first, { op: "undo" });
    assert.equal(reviewStillOpen(clash, readNotice(first), "saved"), true);
  });
});

test("narration put-back duplicates the surviving letter and its undo reopens the entry", () => {
  withCopies((typist, remover, common) => {
    write(typist, { op: "type", id: "B", field: "audio", at: 1, value: "Ω" });
    const mine = readNotice(typist);
    write(remover, { op: "rows", ids: ["B"] });
    deliver(remover, typist); deliver(typist, remover);
    const [clash] = compareNotices(common, mine, readNotice(typist));
    assert.ok(clash);
    assert.equal(clash.kind, "narration");
    assert.equal(rowText(readNotice(typist), "narration", "A"), "abcΩ");
    putNoticeBack(typist, mine, "B", "saved", 1);
    assert.equal(rowText(readNotice(typist), "narration", "saved"), "dΩef");
    assert.equal(rowText(readNotice(typist), "narration", "A"), "abcΩ");
    assert.equal(reviewStillOpen(clash, readNotice(typist), "saved"), false);
    write(typist, { op: "undo" });
    assert.equal(reviewStillOpen(clash, readNotice(typist), "saved"), true);
    write(remover, { op: "undo" });
    deliver(remover, typist);
    assert.equal(rowText(readNotice(typist), "narration", "B"), "dΩef");
    assert.equal(reviewStillOpen(clash, readNotice(typist), "saved"), false);
    write(remover, { op: "redo" });
    deliver(remover, typist);
    assert.equal(rowText(readNotice(typist), "narration", "A"), "abcΩ");
    assert.equal(reviewStillOpen(clash, readNotice(typist), "saved"), true);
  });
});

test("undo of the deletion leaves an unseen visual edit missing", () => {
  withCopies((first, second, common) => {
    write(first, { op: "type", id: "B", field: "visual", at: 1, value: "Ω" });
    const mine = readNotice(first);
    write(second, { op: "rows", ids: ["B"] });
    deliver(second, first); deliver(first, second);
    const [clash] = compareNotices(common, mine, readNotice(first));
    assert.ok(clash);
    assert.equal(clash.kind, "visual");
    write(second, { op: "undo" });
    deliver(second, first);
    assert.equal(rowText(readNotice(first), "visual", "B"), "2");
    assert.equal(reviewStillOpen(clash, readNotice(first)), true);
  });
});

test("two people putting back their own copy of the same beat create two beats", () => {
  withCopies((first, second, common) => {
    const remover = replicaFrom(first.encode(), 103);
    try {
      const payloads = [[first, "Ω", "saved-first"], [second, "Ψ", "saved-second"]] as const;
      const saved = payloads.map(([replica, letter, id]) => {
        write(replica, { op: "type", id: "B", field: "visual", at: 1, value: letter });
        return { replica, id, mine: readNotice(replica) };
      });
      write(remover, { op: "rows", ids: ["B"] });
      for (const { replica, id, mine } of saved) {
        deliver(remover, replica);
        const [clash] = compareNotices(common, mine, readNotice(replica));
        assert.ok(clash);
        assert.equal(clash.kind, "visual");
        putNoticeBack(replica, mine, "B", id, 1);
        assert.equal(reviewStillOpen(clash, readNotice(replica), id), false);
      }
      deliver(first, second); deliver(second, first); deliver(second, remover);
      const rows = assertConverged([first, second, remover]);
      assert.deepEqual(rows.filter(beat => beat.id?.startsWith("saved")).map((beat: NoticeBeat) => beat.id),
        ["saved-first", "saved-second"]);
      assert.equal(rowText(rows, "visual", "saved-first"), "2Ω");
      assert.equal(rowText(rows, "visual", "saved-second"), "2Ψ");
      assert.equal(first.beats.has("B"), false);
    } finally { remover.destroy(); }
  });
});
