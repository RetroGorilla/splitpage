import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { compareLocalChanges, compareNotices, remoteRemoved, type NoticeBeat, type NoticeReading } from "../../src/native-notice/compare.ts";
import { inSyncNow, observeRemoteBeatIds, observeRemoteRemoval, readNotice } from "../../src/native-notice/yjs.ts";
import { adaptNoticeReview } from "../../src/native-notice/review.ts";
import { base, sole } from "../native-delete/model.ts";
import { deliver, rankedSeed, replicaFrom, rowText, write } from "./kit.ts";

function beat(id: string | null, text: string, fields: Partial<NoticeBeat> = {}): NoticeBeat {
  return { id, scene: null, row: id, narration: text ? [{ insert: text }] : [], visual: [], status: null, fields: {}, ...fields };
}

const kindKeys = (base: NoticeReading, mine: NoticeReading, merged: NoticeReading) =>
  compareNotices(base, mine, merged).map(entry => [entry.kind, entry.id]);

test("the four chosen reading rules work from hand-written plain rows", () => {
  const a = beat("A", "abc"), b = beat("B", "def"), c = beat("C", "ghi");
  const typedHead = beat("A", "aΩbc");
  assert.deepEqual(kindKeys([a, b], [typedHead, b], [beat("B", "Ωdef")]), [["narration", "A"]]);
  assert.deepEqual(kindKeys([a, b], [b], [beat("B", "Ωdef")]), []);
  assert.deepEqual(kindKeys([a, b], [a, beat("B", "dΩef")], [beat("A", "abcΩ")]), [["narration", "B"]]);
  assert.deepEqual(kindKeys([a, b], [a], [beat("A", "abcΩ")]), [["displaced", "B"]]);
  const soloSegment = beat("F", "vwx", { scene: "I" });
  assert.deepEqual(kindKeys([a, soloSegment], [a], [beat("A", "abcΩ")]), [["displaced", "F"]]);
  assert.deepEqual(kindKeys([a], [typedHead], [beat(null, "Ω")]), [["narration", "A"]]);
  assert.deepEqual(kindKeys([a], [], [beat(null, "Ω")]), []);
  assert.deepEqual(kindKeys([a, b, c], [a, b, c], [a, beat("B", "defdef"), c]), [["double-undo", "B"]]);
  const joined = beat("C", "ghi", { row: "B", fields: { joined: { into: "B", glue: " " } } });
  assert.deepEqual(kindKeys([a, b, c], [a, b, joined], [a, { ...joined, row: "C" }]), [["join", "C"]]);
  assert.deepEqual(kindKeys([a, b, joined], [a, b, joined], [a, { ...joined, row: "C" }]), [["join", "C"]]);
});

test("seen and unseen edits inside deleted containers give the same catch-up evidence", () => {
  const cases = [
    ["visual", { op: "type", id: "B", field: "visual", at: 1, value: "Ω" }],
    ["marks", { op: "mark", id: "B", field: "visual", from: 0, to: 1, key: "t:TAG" }],
    ["record", { op: "field", id: "B", value: "ready" }],
    ["record", { op: "detail", id: "B", key: "notes", value: "changed" }]
  ] as const;
  function sample(seen: boolean, [kind, command]: typeof cases[number]) {
    const start = rankedSeed(base);
    const typist = replicaFrom(start.encode(), 101), remover = replicaFrom(start.encode(), 102);
    const common = inSyncNow(typist).base;
    const transitions: unknown[] = [], removed: string[] = [];
    const stopIds = observeRemoteBeatIds(typist, ids => removed.push(...ids));
    const stopReads = observeRemoteRemoval(typist, (before, after, transaction) => {
      if (remoteRemoved(before, after, new Set(["B"])).length) {
        transitions.push({ before, after, local: transaction.local, origin: transaction.origin,
          vector: Y.encodeStateVector(typist.doc), snapshot: Y.encodeSnapshot(Y.snapshot(typist.doc)),
          snapshotV2: Y.encodeSnapshotV2(Y.snapshot(typist.doc)),
          deletes: Y.encodeSnapshot(Y.createSnapshot(transaction.deleteSet, new Map())) });
      }
    });
    try {
      write(typist, command);
      const mine = readNotice(typist), beforeVector = Y.encodeStateVector(typist.doc);
      if (seen) deliver(typist, remover);
      assert.deepEqual(readNotice(remover), seen ? mine : common);
      write(remover, { op: "rows", ids: ["B"] });
      if (!seen) deliver(typist, remover);
      const packet = Y.encodeStateAsUpdate(remover.doc, beforeVector);
      const packetV2 = Y.encodeStateAsUpdateV2(remover.doc, beforeVector);
      const senderVector = Y.encodeStateVector(remover.doc);
      deliver(remover, typist);
      const final = readNotice(typist);
      assert.deepEqual(removed, ["B"]);
      assert.deepEqual(Y.encodeStateVector(typist.doc), beforeVector, "deleting allocates no items here");
      assert.deepEqual(kindKeys(common, mine, final), [[kind, "B"]]);
      return { common, mine, final, transitions, packet, packetV2, senderVector };
    } finally {
      stopReads(); stopIds(); start.destroy(); typist.destroy(); remover.destroy();
    }
  }
  for (const example of cases) assert.deepEqual(sample(true, example), sample(false, example));
});

test("a visible unseen narration letter survives the cut, and a seen letter is removed", () => {
  for (const seen of [false, true]) {
    const seed = rankedSeed(base), writer = replicaFrom(seed.encode(), 101), cutter = replicaFrom(seed.encode(), 102);
    try {
      write(writer, { op: "type", id: "B", field: "audio", at: 1, value: "Ω" });
      if (seen) deliver(writer, cutter);
      write(cutter, { op: "rows", ids: ["B"] });
      if (!seen) deliver(writer, cutter);
      deliver(cutter, writer);
      assert.equal(rowText(readNotice(writer), "narration", "A"), seen ? "abc" : "abcΩ");
    } finally { seed.destroy(); writer.destroy(); cutter.destroy(); }
  }
});

test("a stale base includes someone else's work and an advanced base erases unacknowledged work", () => {
  const a = beat("A", "abc"), newBeat = beat("N", "someone else's starting text");
  assert.deepEqual(kindKeys([a], [a, newBeat], [a]), [["narration", "N"]]);
  assert.deepEqual(compareLocalChanges([a, newBeat], [a], []), []);
  const old = beat("B", "def", { visual: [{ insert: "2" }] });
  const mine = { ...old, visual: [{ insert: "2Ω" }] };
  assert.deepEqual(kindKeys([a, old], [a, mine], [a]), [["visual", "B"]]);
  assert.deepEqual(kindKeys([a, mine], [a, mine], [a]), []);
  assert.deepEqual(compareLocalChanges([a, mine], [a], [{ id: "B", kind: "visual", text: "Ω" }]).map(clash => clash.kind), ["visual"]);
});

test("an append in A and a surviving insert from B give the same reverse reading", () => {
  function sample(typed: "A" | "B") {
    const start = rankedSeed(base);
    const remover = replicaFrom(start.encode(), 101), typist = replicaFrom(start.encode(), 102);
    try {
      const common = inSyncNow(remover).base;
      write(remover, { op: "rows", ids: ["B"] });
      const mine = readNotice(remover);
      write(typist, { op: "type", id: typed, field: "audio", at: typed === "A" ? 3 : 1, value: "Ω" });
      deliver(typist, remover);
      const final = readNotice(remover);
      assert.equal(rowText(final, "narration", "A"), "abcΩ");
      assert.deepEqual(kindKeys(common, mine, final), [["displaced", "B"]]);
      return { common, mine, final };
    } finally {
      start.destroy(); remover.destroy(); typist.destroy();
    }
  }
  assert.deepEqual(sample("A"), sample("B"));
});

test("base survives unsent typing and a close while offline, and is replaced only after the merge is read", () => {
  const start = rankedSeed(base), peer = replicaFrom(start.encode(), 102);
  let local = replicaFrom(start.encode(), 101);
  try {
    const saved = JSON.stringify(inSyncNow(local));
    write(local, { op: "type", id: "B", field: "visual", at: 1, value: "Ω" });
    const unsent = local.encode();
    local.destroy();
    local = replicaFrom(unsent, 103);
    write(peer, { op: "rows", ids: ["B"] });
    const mine = readNotice(local);
    deliver(peer, local);
    const persisted = JSON.parse(saved) as { base: NoticeReading };
    assert.deepEqual(kindKeys(persisted.base, mine, readNotice(local)), [["visual", "B"]]);
    deliver(local, peer);
    const next = inSyncNow(local).base;
    write(local, { op: "type", id: "F", field: "audio", at: 1, value: "Ω" });
    const secondMine = readNotice(local);
    deliver(peer, local);
    assert.deepEqual(kindKeys(next, secondMine, readNotice(local)), []);
    deliver(local, peer);
    assert.deepEqual(inSyncNow(local).base, inSyncNow(peer).base);
  } finally {
    start.destroy(); peer.destroy(); local.destroy();
  }
});

test("the small Yjs snapshot needs the historical document with garbage collection disabled", () => {
  const start = rankedSeed(sole);
  const source = new Y.Doc({ gc: false });
  const collected = replicaFrom(start.encode(), 102);
  try {
    Y.applyUpdate(source, start.encode());
    const snapshot = Y.decodeSnapshot(Y.encodeSnapshot(Y.snapshot(source)));
    const saved = Y.encodeStateAsUpdate(source);
    source.getMap("beats").delete("A");
    collected.beats.delete("A");
    assert.throws(() => Y.createDocFromSnapshot(collected.doc, snapshot), /garbage-collection/i);
    const original = Y.createDocFromSnapshot(source, snapshot);
    const reopened = replicaFrom(saved, 103);
    try {
      assert.equal(original.getMap("beats").has("A"), true);
      assert.deepEqual(readNotice(reopened), readNotice(start));
    } finally {
      original.destroy(); reopened.destroy();
    }
  } finally {
    start.destroy(); source.destroy(); collected.destroy();
  }
});

test("app review helpers format differences but file-merge fate and moved placement need different copy", () => {
  const a = beat("A", "<tag>"), b = beat("B", "def"), c = beat("C", "end");
  const changed = beat("B", "def", { visual: [{ insert: "<visual>" }] });
  const saved = [a, changed, c], merged = [a, c];
  const [group] = adaptNoticeReview(compareNotices([a, b, c], saved, merged), [a, b, c], saved, merged);
  assert.ok(group);
  const [review] = group.details;
  assert.ok(review);
  assert.match(review.diff.mine, /&lt;visual&gt;/);
  assert.equal(review.list[0]?.outcome, "both");
  assert.match(review.fate ?? "", /your version stays/);
  assert.equal(group.canPutBack, true);
  const split = beat("N", "ef"), first = beat("B", "d");
  const before = [a, first, split, c], after = [a, split, c, first];
  const [moveGroup] = adaptNoticeReview(compareNotices([a, b, c], before, after), [a, b, c], before, after);
  const [moved] = moveGroup?.details ?? [];
  assert.ok(moved);
  assert.equal(moved.fate, null);
  assert.deepEqual(moved.list, []);
  assert.match(moved.line, /apart/);
  const [reverse] = adaptNoticeReview(compareNotices([a, b], [a], [beat("A", "<tag>Ω")]), [a, b], [a], [beat("A", "<tag>Ω")]);
  assert.ok(reverse);
  assert.equal(reverse.canPutBack, false);
  assert.match(reverse.details[0]?.line ?? "", /may have left/);
});
