import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { MOVE_DESIGNS } from "../../src/native-moves/ranks.ts";
import type { RankDrop } from "../../src/native-moves/ranks.ts";
import { load, seed } from "./e10-run.ts";

const variants = ["fresh", "same", "none"] as const;
type CutVariant = (typeof variants)[number];

const rowAfter = (first: string, target: string): RankDrop => ({ unit: "row", first, target, after: true });
const runAfter = (target: string): RankDrop => ({ unit: "rows", first: "B", last: "C", target, after: true });
const sceneFirst: RankDrop = { unit: "scene", first: "Q", target: "P", after: false };

function race(drop: RankDrop, above: string, variant: CutVariant): string {
  const base = seed("run"), moving = load("run", base, 1), heading = load("run", base, 2);
  try {
    assert.ok(moving.drop(drop));
    const beat = heading.block(above), segment = heading.segments.get(beat.segment);
    assert.ok(segment);
    const initialRank = segment.get("e10Base");
    assert.equal(typeof initialRank, "string");
    heading.transact(() => {
      heading.createHeading(above, "R", "z");
      const cut = segment.get("e10Cut:h:R") as { at: Uint8Array; rank: string } | undefined;
      assert.ok(cut?.at instanceof Uint8Array);
      assert.notEqual(cut.rank, initialRank);
      assert.equal(segment.has(`e10Cut:b:${above}`), false);
      if (variant === "same") segment.set("e10Cut:h:R", { ...cut, rank: initialRank });
      if (variant === "none") segment.delete("e10Cut:h:R");
    });
    const moved = moving.encode(), headed = heading.encode();
    Y.applyUpdate(moving.doc, headed);
    Y.applyUpdate(heading.doc, moved);
    const order = (replica: typeof moving): string => replica.arrangement().order.join(" ").replaceAll("b:", "").replaceAll("h:", "#");
    const merged = order(moving);
    assert.equal(order(heading), merged);
    return merged;
  } finally {
    moving.destroy();
    heading.destroy();
  }
}

test("E10: fresh, same and absent heading cuts racing six drops", t => {
  const cases = [
    [rowAfter("B", "F"), "#P A C D #Q #R E F B G H"],
    [rowAfter("B", "H"), "#P A C D #Q #R E F G H B"],
    [runAfter("F"), "#P A D #Q #R E F B C G H"],
    [runAfter("H"), "#P A D #Q #R E F G H B C"],
    [rowAfter("D", "F"), "#P A B C #Q #R E F D G H"],
    [sceneFirst, "#Q #R E F G H #P A B C D"]
  ] as const;
  for (const variant of variants) {
    const orders = cases.map(([drop]) => race(drop, "E", variant));
    const preferred = cases.filter(([, expected], i) => orders[i] === expected).length;
    t.diagnostic(JSON.stringify({ variant, preferred, orders }));
    assert.equal(preferred, { fresh: 0, same: 5, none: 6 }[variant], variant);
    if (variant !== "none") assert.equal(orders.at(-1), "#Q #P A B C D #R E F G H");
  }
});

test("E10: a heading above C races a move of B or B through C", t => {
  for (const variant of variants) {
    const one = race(rowAfter("B", "F"), "C", variant), pair = race(runAfter("F"), "C", variant);
    t.diagnostic(JSON.stringify({ variant, one, pair }));
    const expected = {
      fresh: ["#P A C #R D #Q E F B G H", "#P A #R C D #Q E F B G H"],
      same: ["#P A #R C D #Q E F B G H", "#P A #R C D #Q E F B G H"],
      none: ["#P A C D #Q E F B #R G H", "#P A D #Q E F B #R C G H"]
    };
    assert.deepEqual([one, pair], expected[variant], variant);
  }
});

test("E10: single-writer deletion after a row or run move", () => {
  for (const design of MOVE_DESIGNS) {
    for (const [drop, deleted, expected] of [[rowAfter("B", "F"), "F", "B"], [runAfter("F"), "B", "C"]] as const) {
      const replica = load(design, seed(design));
      try {
        assert.ok(replica.drop(drop));
        assert.ok(replica.arrangement().order.indexOf(`b:${expected}`) > replica.arrangement().order.indexOf("h:Q"));
        replica.deleteBeat(deleted);
        const order = replica.arrangement().order;
        assert.ok(!order.includes(`b:${deleted}`));
        assert.equal(order.filter(id => id === `b:${expected}`).length, 1);
        assert.equal(order.indexOf(`b:${expected}`) < order.indexOf("h:Q"), design === "placement");
        assert.equal(replica.rows().find(row => row.id === expected)?.audioText, expected === "B" ? "cd" : "ef");
      } finally {
        replica.destroy();
      }
    }
  }
});
