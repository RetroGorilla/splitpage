import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { nativeInitialRank } from "../../../../src/adapters/collab/native/convert.ts";
import { nativeRankBetween } from "../../../../src/adapters/collab/native/rank.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";

const VALID_RANK = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

function readerCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function runGeneratedInsertions(
  between: (before: string | null, after: string | null) => string,
  steps: number,
  seed: number
): void {
  const random = mulberry32(seed);
  const expected: string[] = [];
  const ranks = new Map<string, string>();
  for (let i = 0; i < 5; i++) {
    const id = `init-${i}`;
    expected.push(id);
    ranks.set(id, nativeInitialRank(i));
  }
  for (let step = 0; step < steps; step++) {
    const pos = Math.floor(random() * (expected.length + 1));
    const beforeId = pos > 0 ? expected[pos - 1] : undefined;
    const afterId = pos < expected.length ? expected[pos] : undefined;
    const before = beforeId === undefined ? null : ranks.get(beforeId) ?? null;
    const after = afterId === undefined ? null : ranks.get(afterId) ?? null;
    const rank = between(before, after);
    assert.match(rank, VALID_RANK, `step ${step}: invalid rank "${rank}"`);
    if (before !== null) assert.equal(readerCompare(before, rank), -1, `step ${step}: not after before`);
    if (after !== null) assert.equal(readerCompare(rank, after), -1, `step ${step}: not before after`);
    const id = `ins-${step}`;
    expected.splice(pos, 0, id);
    ranks.set(id, rank);
    if ((step + 1) % 250 === 0 || step === steps - 1) {
      const sorted = [...ranks.keys()].sort((leftId, rightId) => {
        const order = readerCompare(ranks.get(leftId) ?? "", ranks.get(rightId) ?? "");
        return order !== 0 ? order : readerCompare(leftId, rightId);
      });
      assert.deepEqual(sorted, expected, `step ${step}: reader order diverged from insertion positions`);
    }
  }
}

test("ranks between adjacent and distant initial ranks from conversion", () => {
  for (const [leftIndex, rightIndex] of [[0, 1], [1, 2], [2, 3], [0, 10], [99, 100], [1000, 1001], [100_000, 100_001]] as const) {
    const before = nativeInitialRank(leftIndex);
    const after = nativeInitialRank(rightIndex);
    const mid = nativeRankBetween(before, after);
    assert.match(mid, VALID_RANK);
    assert.equal(readerCompare(before, mid), -1);
    assert.equal(readerCompare(mid, after), -1);
    assert.equal(nativeRankBetween(before, after), mid);
  }
});

test("ranks before the first, after the last, with both null, and at tight prefixes", () => {
  const only = nativeRankBetween(null, null);
  assert.match(only, VALID_RANK);
  assert.equal(nativeRankBetween(null, null), only);

  const first = nativeInitialRank(0);
  const beforeFirst = nativeRankBetween(null, first);
  assert.match(beforeFirst, VALID_RANK);
  assert.equal(readerCompare(beforeFirst, first), -1);

  const last = nativeInitialRank(500);
  const afterLast = nativeRankBetween(last, null);
  assert.match(afterLast, VALID_RANK);
  assert.equal(readerCompare(last, afterLast), -1);

  for (const [before, after] of [
    [null, "0001"],
    [null, "000001"],
    [null, "0000001"],
    [null, "000000000001"],
    [null, "1"],
    ["zzzz", null],
    ["zzzzzz", null],
    ["zzzzzzV", null],
    ["zzzzzy999", null],
    ["1", "2"],
    ["01", "02"],
    ["1", "11"],
    ["1", "1001"],
    ["1zzz", "2"],
    ["100z", "101"]
  ] as const) {
    const mid = nativeRankBetween(before, after);
    assert.match(mid, VALID_RANK);
    if (before !== null) assert.equal(readerCompare(before, mid), -1);
    if (after !== null) assert.equal(readerCompare(mid, after), -1);
  }
});

test("NativeScriptReader orders blocks using initial and between ranks", () => {
  const script = openNativeScript(new Y.Doc());
  try {
    const r0 = nativeInitialRank(0);
    const r1 = nativeInitialRank(1);
    const r2 = nativeInitialRank(2);
    const entries: readonly (readonly [string, string])[] = [
      ["B1", r0],
      ["B2", r1],
      ["B3", r2],
      ["BEFORE", nativeRankBetween(null, r0)],
      ["MID1", nativeRankBetween(r0, r1)],
      ["MID2", nativeRankBetween(r1, r2)],
      ["AFTER", nativeRankBetween(r2, null)]
    ];
    script.doc.transact(() => {
      const seg = new Y.Map<unknown>();
      const text = new Y.Text();
      seg.set("head", { b: entries[0]?.[0] ?? "B1" });
      seg.set("text", text);
      script.roots.segments.set("s:1", seg);
      script.roots.order.push(["s:1"]);
      entries.forEach(([id, rank], index) => {
        if (index > 0) text.insertEmbed(index - 1, { b: id }, {});
        const record = new Y.Map<unknown>();
        record.set("rank", rank);
        script.roots.beats.set(id, record);
        script.roots.visuals.set(id, new Y.Text());
      });
    });
    assert.deepEqual(
      script.reader.outline().map(entry => entry.id),
      ["BEFORE", "B1", "MID1", "B2", "MID2", "B3", "AFTER"]
    );
  } finally {
    script.close();
  }
});

test("repeated insertion always just after the same block holds for 10,000 steps", t => {
  const anchor = nativeInitialRank(0);
  let after = nativeInitialRank(1);
  let at1000 = 0;
  for (let step = 1; step <= 10_000; step++) {
    const rank = nativeRankBetween(anchor, after);
    assert.match(rank, VALID_RANK);
    assert.equal(readerCompare(anchor, rank), -1);
    assert.equal(readerCompare(rank, after), -1);
    after = rank;
    if (step === 1_000) at1000 = rank.length;
  }
  const at10000 = after.length;
  t.diagnostic(`always-after lengths: 1,000=${at1000}, 10,000=${at10000}`);
  assert.equal(at1000, 206);
  assert.equal(at10000, 2_006);
});

test("repeated insertion always just before the same block holds for 10,000 steps", t => {
  let before = nativeInitialRank(0);
  const anchor = nativeInitialRank(1);
  let at1000 = 0;
  for (let step = 1; step <= 10_000; step++) {
    const rank = nativeRankBetween(before, anchor);
    assert.match(rank, VALID_RANK);
    assert.equal(readerCompare(before, rank), -1);
    assert.equal(readerCompare(rank, anchor), -1);
    before = rank;
    if (step === 1_000) at1000 = rank.length;
  }
  const at10000 = before.length;
  t.diagnostic(`always-before lengths: 1,000=${at1000}, 10,000=${at10000}`);
  assert.equal(at1000, 172);
  assert.equal(at10000, 1_672);
});

test("repeated insertion always in the middle holds for 10,000 steps", t => {
  let before = nativeInitialRank(0);
  let after = nativeInitialRank(1);
  let at1000 = 0;
  let lastLength = 0;
  for (let step = 1; step <= 10_000; step++) {
    const rank = nativeRankBetween(before, after);
    assert.match(rank, VALID_RANK);
    assert.equal(readerCompare(before, rank), -1);
    assert.equal(readerCompare(rank, after), -1);
    if (step % 2 === 1) after = rank;
    else before = rank;
    lastLength = rank.length;
    if (step === 1_000) at1000 = lastLength;
  }
  t.diagnostic(`always-middle lengths: 1,000=${at1000}, 10,000=${lastLength}`);
  assert.equal(at1000, 172);
  assert.equal(lastLength, 1_672);
});

test("10,000 appends and 10,000 prepends keep strict order and compact sizes", t => {
  let last = nativeInitialRank(0);
  let appendBytes = 0;
  let append900Bytes = 0;
  let append900Len = 0;
  for (let step = 1; step <= 10_000; step++) {
    const later = nativeRankBetween(last, null);
    assert.match(later, VALID_RANK);
    assert.equal(readerCompare(last, later), -1);
    last = later;
    appendBytes += later.length;
    if (step === 900) {
      append900Bytes = appendBytes;
      append900Len = later.length;
    }
  }
  t.diagnostic(`appends from initial(0): 900=${append900Bytes}B (final ${append900Len}), 10,000=${appendBytes}B (final ${last.length})`);
  assert.equal(append900Len, 7);
  assert.equal(append900Bytes, 6_300);
  assert.equal(last.length, 7);
  assert.equal(appendBytes, 70_000);

  let first = nativeInitialRank(0);
  let prependBytes = 0;
  for (let step = 1; step <= 10_000; step++) {
    const earlier = nativeRankBetween(null, first);
    assert.match(earlier, VALID_RANK);
    assert.equal(readerCompare(earlier, first), -1);
    first = earlier;
    prependBytes += earlier.length;
  }
  t.diagnostic(`prepends from initial(0): 10,000=${prependBytes}B (final ${first.length})`);
  assert.equal(first.length, 13);
  assert.equal(prependBytes, 129_994);

  let openFirst = nativeRankBetween(null, null);
  let openPrependBytes = 0;
  for (let step = 1; step <= 10_000; step++) {
    const earlier = nativeRankBetween(null, openFirst);
    assert.match(earlier, VALID_RANK);
    assert.equal(readerCompare(earlier, openFirst), -1);
    openFirst = earlier;
    openPrependBytes += earlier.length;
  }
  t.diagnostic(`prepends from open(null,null): 10,000=${openPrependBytes}B (final ${openFirst.length})`);
  assert.equal(openFirst.length, 7);
  assert.equal(openPrependBytes, 70_000);
});

test("seeded mixed appends, prepends and bounded insertions preserve strict order", () => {
  const random = mulberry32(20261120);
  const expected: string[] = [];
  const ranks = new Map<string, string>();
  for (let i = 0; i < 4; i++) {
    const id = `init-${i}`;
    expected.push(id);
    ranks.set(id, nativeInitialRank(i));
  }
  for (let step = 0; step < 3_000; step++) {
    const draw = random();
    const pos = draw < 0.3 ? 0 : draw < 0.6 ? expected.length : Math.floor(random() * (expected.length - 1)) + 1;
    const beforeId = pos > 0 ? expected[pos - 1] : undefined;
    const afterId = pos < expected.length ? expected[pos] : undefined;
    const before = beforeId === undefined ? null : ranks.get(beforeId) ?? null;
    const after = afterId === undefined ? null : ranks.get(afterId) ?? null;
    const rank = nativeRankBetween(before, after);
    assert.match(rank, VALID_RANK, `step ${step}: invalid rank "${rank}"`);
    if (before !== null) assert.equal(readerCompare(before, rank), -1, `step ${step}: not after before`);
    if (after !== null) assert.equal(readerCompare(rank, after), -1, `step ${step}: not before after`);
    const id = `mix-${step}`;
    expected.splice(pos, 0, id);
    ranks.set(id, rank);
  }
  const sorted = [...ranks.keys()].sort((leftId, rightId) => {
    const order = readerCompare(ranks.get(leftId) ?? "", ranks.get(rightId) ?? "");
    return order !== 0 ? order : readerCompare(leftId, rightId);
  });
  assert.deepEqual(sorted, expected);
});

test("seeded generated insertions match chosen positions, and the check catches wrong rank functions", () => {
  runGeneratedInsertions(nativeRankBetween, 3_000, 20261119);

  assert.throws(
    () => { runGeneratedInsertions((before, after) => before ?? after ?? "V", 50, 20261119); },
    assert.AssertionError
  );
  assert.throws(
    () => { runGeneratedInsertions(() => "z", 50, 20261119); },
    assert.AssertionError
  );
  assert.throws(
    () => { runGeneratedInsertions((before, after) => nativeRankBetween(before, after) + "0", 50, 20261119); },
    assert.AssertionError
  );
});

test("invalid inputs throw RangeError", () => {
  const r0 = nativeInitialRank(0);
  const r1 = nativeInitialRank(1);
  const invalidFormat: readonly unknown[] = [
    "",
    "0",
    "00",
    "a0",
    "00000W0",
    "00000W!",
    "00000W-",
    "00000W_",
    " 1",
    "1 ",
    "1\n",
    "é",
    "\uD800",
    undefined,
    123,
    {}
  ];
  for (const bad of invalidFormat) {
    assert.throws(() => nativeRankBetween(bad as string, null), RangeError);
    assert.throws(() => nativeRankBetween(null, bad as string), RangeError);
    assert.throws(() => nativeRankBetween(bad as string, r1), RangeError);
    assert.throws(() => nativeRankBetween(r0, bad as string), RangeError);
  }
  for (const [before, after] of [
    [r0, r0],
    [r1, r0],
    ["V", "V"],
    ["2", "1"],
    ["11", "1"],
    ["000012V", "00000WV"]
  ] as const) {
    assert.throws(() => nativeRankBetween(before, after), RangeError);
  }
});
