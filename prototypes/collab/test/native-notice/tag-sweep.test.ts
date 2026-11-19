import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { compareNotices, type NoticeBeat } from "../../src/native-notice/compare.ts";
import { observeRemoteRemoval, readNotice } from "../../src/native-notice/yjs.ts";
import { base } from "../native-delete/model.ts";
import { assertConverged, deliver, rankedSeed, replicaFrom, rowText, write } from "./kit.ts";

const tag = "t:TAG";
const removals = ["cut", "same", "all", "first"] as const;
const audioRanges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]] as const;
const tagCases = [...audioRanges.map(range => ({ field: "audio" as const, range })), { field: "visual" as const, range: [0, 1] as const }];

function tagged(beat: NoticeBeat, field: "audio" | "visual"): string {
  return beat[field === "audio" ? "narration" : "visual"].map(run => {
    const text = typeof run.insert === "string" ? run.insert : "\uFFFC";
    return run.marks?.[tag] ? "[" + text + "]" : text;
  }).join("");
}

test("production tags across four removals and an undo, with and without earlier delivery", () => {
  const seed = rankedSeed(base);
  const common = readNotice(seed);
  const results = Object.fromEntries(removals.map(op => [op, { unseenLost: 0, flagged: 0, seenLost: 0, seenFlagged: 0 }]));
  let grows = false;
  try {
    for (const op of removals) for (const { field, range: [from, to] } of tagCases) for (const seen of [false, true]) {
      const writer = replicaFrom(seed.encode(), 101), cutter = replicaFrom(seed.encode(), 102);
      try {
        write(writer, { op: "mark", id: "B", field, from, to, key: tag });
        const mine = readNotice(writer);
        if (seen) deliver(writer, cutter);
        if (op === "cut") write(cutter, { op: "rows", ids: ["B"] });
        else write(cutter, { op: "erase", id: "B", field, from: op === "same" ? from : 0,
          to: op === "same" ? to : op === "first" || field === "visual" ? 1 : 3 });
        write(cutter, { op: "undo" });
        deliver(cutter, writer); deliver(writer, cutter);
        const merged = assertConverged([writer, cutter]);
        const restored = merged.find(beat => beat.id === "B");
        const saved = mine.find(beat => beat.id === "B");
        assert.ok(restored && saved);
        const expected = !seen && (op === "cut" ? field === "visual" || from > 0 : op === "all" && field === "audio" && from > 0);
        const lost = !tagged(restored, field).includes("[");
        assert.equal(lost, expected, [op, field, from, to, seen].join("/"));
        const noticed = compareNotices(common, mine, merged).some(clash => clash.kind === "marks" && clash.id === "B");
        assert.equal(noticed, expected, [op, field, from, to, seen].join("/"));
        const counts = results[op];
        assert.ok(counts);
        if (seen) { counts.seenLost += Number(lost); counts.seenFlagged += Number(noticed); }
        else { counts.unseenLost += Number(lost); counts.flagged += Number(noticed); }
        grows ||= tagged(saved, field) === "[d]ef" && tagged(restored, field) === "[def]";
      } finally { writer.destroy(); cutter.destroy(); }
    }
    assert.deepEqual(results, {
      cut: { unseenLost: 4, flagged: 4, seenLost: 0, seenFlagged: 0 },
      same: { unseenLost: 0, flagged: 0, seenLost: 0, seenFlagged: 0 },
      all: { unseenLost: 3, flagged: 3, seenLost: 0, seenFlagged: 0 },
      first: { unseenLost: 0, flagged: 0, seenLost: 0, seenFlagged: 0 }
    });
    assert.equal(grows, true);
    console.log(JSON.stringify(results));
  } finally { seed.destroy(); }
});

test("cut and undo shifts an unseen inserted narration letter to the end of B", () => {
  const seed = rankedSeed(base), writer = replicaFrom(seed.encode(), 101), cutter = replicaFrom(seed.encode(), 102);
  try {
    write(writer, { op: "type", id: "B", field: "audio", at: 1, value: "Ω" });
    assert.equal(rowText(readNotice(writer), "narration", "B"), "dΩef");
    write(cutter, { op: "rows", ids: ["B"] }); write(cutter, { op: "undo" });
    deliver(cutter, writer); deliver(writer, cutter);
    assert.equal(rowText(assertConverged([writer, cutter]), "narration", "B"), "defΩ");
  } finally { seed.destroy(); writer.destroy(); cutter.destroy(); }
});

test("a received narration cut distinguishes previously seen production tags and bold", () => {
  for (const key of [tag, "b"]) for (const seen of [false, true]) {
    const seed = rankedSeed(base), writer = replicaFrom(seed.encode(), 101), cutter = replicaFrom(seed.encode(), 102);
    try {
      const baseVector = Y.encodeStateVector(writer.doc);
      write(writer, { op: "mark", id: "B", field: "audio", from: 1, to: 2, key });
      const ids = Y.decodeUpdate(Y.encodeStateAsUpdate(writer.doc, baseVector)).structs.flatMap(item =>
        item instanceof Y.Item && item.content instanceof Y.ContentFormat ? [item.id] : []);
      assert.equal(ids.length, 2);
      if (seen) deliver(writer, cutter);
      write(cutter, { op: "rows", ids: ["B"] });
      if (!seen) deliver(writer, cutter);
      const cuts: boolean[][] = [];
      const stop = observeRemoteRemoval(writer, (before, after, transaction) => {
        if (before.some(beat => beat.id === "B") && !after.some(beat => beat.id === "B")) {
          cuts.push(ids.map(id => Y.isDeleted(transaction.deleteSet, id)));
        }
      });
      try { deliver(cutter, writer); } finally { stop(); }
      assert.deepEqual(cuts, [[seen, seen]]);
    } finally { seed.destroy(); writer.destroy(); cutter.destroy(); }
  }
});
