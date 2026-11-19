import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { NativeHeadingReplica } from "../../src/native/headings.ts";
import { BlockKeyReplica, BlockListReplica, copyMove, moveSegmentEntry, SegmentKeyReplica } from "../../src/native-moves/candidates.ts";
import { moveBlocks } from "../../src/native-moves/moves.ts";
import { blockRef } from "../../src/native-moves/order.ts";
import { randomFor } from "../native/e5-histories.ts";

const ROWS = ["abcd", "efgh", "ijkl", "mnop", "qrst", "uvwx"].map((text, index) => ({ id: `B${index + 1}`, audioText: text }));
const IDS = ROWS.map(row => row.id);

interface Candidate {
  name: string;
  make: (client: number) => NativeHeadingReplica;
  setup?: (seed: NativeHeadingReplica) => void;
  move: (replica: NativeHeadingReplica, beat: string, before: string, stamp: string) => void;
  split: (replica: NativeHeadingReplica, beat: string, offset: number, created: string) => void;
}

const shown = (replica: NativeHeadingReplica): string[] => replica.blocks().map(block => blockRef(block.kind, block.id));
const pred = (replica: NativeHeadingReplica, ref: string): string | null => { const order = shown(replica); return order[order.indexOf(ref) - 1] ?? null; };
const segmentOf = (replica: NativeHeadingReplica, beat: string): string => replica.block(beat).segment;

const CANDIDATES: Candidate[] = [
  { name: "a: copy and delete", make: client => new NativeHeadingReplica(client, "flag"),
    move: (replica, beat, before, stamp) => { copyMove(replica, beat, before, stamp); }, split: (replica, ...args) => { replica.split(...args); } },
  { name: "b: number per segment", make: client => new SegmentKeyReplica(client, "flag"), setup: seed => { (seed as SegmentKeyReplica).numberSegments(); },
    move: (replica, beat, before) => {
      const keys = replica.naturalBlocks().map(block => block.segment).filter((key, index, all) => all.indexOf(key) === index);
      const at = keys.indexOf(segmentOf(replica, before)), number = (key: string | undefined): number => Number(replica.segments.get(key ?? "")?.get("pos") ?? 0);
      (replica as SegmentKeyReplica).moveSegment(segmentOf(replica, beat), [at > 0 ? number(keys[at - 1]) : 0, number(keys[at])]);
    }, split: (replica, ...args) => { replica.split(...args); } },
  { name: "b: number per block", make: client => new BlockKeyReplica(client, "flag"), setup: seed => { (seed as BlockKeyReplica).numberAll(); },
    move: (replica, beat, before) => { (replica as BlockKeyReplica).moveKeyed(blockRef("b", beat), pred(replica, blockRef("b", before))); },
    split: (replica, ...args) => { (replica as BlockKeyReplica).splitKeyed(...args); } },
  { name: "c: order list of segments", make: client => new NativeHeadingReplica(client, "flag"),
    move: (replica, beat, before) => { moveSegmentEntry(replica, segmentOf(replica, beat), segmentOf(replica, before)); },
    split: (replica, ...args) => { replica.split(...args); } },
  { name: "c: order list of blocks", make: client => new BlockListReplica(client, "flag"), setup: seed => { (seed as BlockListReplica).listAll(); },
    move: (replica, beat, before) => { (replica as BlockListReplica).moveListed(blockRef("b", beat), pred(replica, blockRef("b", before))); },
    split: (replica, ...args) => { (replica as BlockListReplica).splitListed(...args); } },
  { name: "d: placement on the block", make: client => new NativeHeadingReplica(client, "flag"),
    move: (replica, beat, before) => {
      const ref = blockRef("b", beat);
      moveBlocks(replica, ref, ref, pred(replica, blockRef("b", before)));
    }, split: (replica, ...args) => { replica.split(...args); } }
];

function pair(candidate: Candidate, first: number): [NativeHeadingReplica, NativeHeadingReplica] {
  const seed = candidate.make(900);
  seed.hydrate({ rows: ROWS });
  candidate.setup?.(seed);
  const bytes = Y.encodeStateAsUpdate(seed.doc);
  seed.destroy();
  const copies = [candidate.make(first), candidate.make(3 - first)] as const;
  for (const copy of copies) { Y.applyUpdate(copy.doc, bytes, "remote"); copy.changes(); }
  return [copies[0], copies[1]];
}

function exchange(left: NativeHeadingReplica, right: NativeHeadingReplica): void {
  const toRight = Y.encodeStateAsUpdate(left.doc, Y.encodeStateVector(right.doc)), toLeft = Y.encodeStateAsUpdate(right.doc, Y.encodeStateVector(left.doc));
  Y.applyUpdate(right.doc, toRight, "remote");
  Y.applyUpdate(left.doc, toLeft, "remote");
  left.changes(); right.changes();
}

interface Look { rows: { id: string; audio: string }[]; stored: string }
function look(replica: NativeHeadingReplica): Look {
  const rows = replica.rows().map(row => ({ id: row.id, audio: row.audio.map(item => typeof item.insert === "string" ? item.insert : "").join("") }));
  const stored = [...replica.segments.values()].map(segment => ((segment.get("text") as Y.Text).toDelta() as { insert: unknown }[])
    .map(item => typeof item.insert === "string" ? item.insert : "").join("")).join("");
  return { rows, stored };
}

const count = (value: string, char: string): number => value.split(char).length - 1;

interface Tally { runs: number; disagree: number; lostOrDoubled: number; notShown: number; beatNotOnce: number; leftBehind: number; outOfTypedOrder: number; draggedAlong: number }
const empty = (): Tally => ({ runs: 0, disagree: 0, lostOrDoubled: 0, notShown: 0, beatNotOnce: 0, leftBehind: 0, outOfTypedOrder: 0, draggedAlong: 0 });

function settle(tally: Tally, left: NativeHeadingReplica, right: NativeHeadingReplica, letters: string): Look {
  exchange(left, right);
  const one = look(left), two = look(right);
  tally.runs++;
  if (JSON.stringify(one) !== JSON.stringify(two)) tally.disagree++;
  const shownText = one.rows.map(row => row.audio).join("");
  for (const char of letters) {
    if (count(one.stored, char) !== 1) { tally.lostOrDoubled++; break; }
  }
  for (const char of letters) if (count(shownText, char) !== 1) { tally.notShown++; break; }
  return one;
}

type Race = "two moves" | "typing" | "split" | "two splits" | "split then move" | "split then move the new beat";
const RACES: Race[] = ["two moves", "typing", "split", "two splits", "split then move", "split then move the new beat"];
const RUNS = 200;

function race(candidate: Candidate, kind: Race, seed: number): Tally {
  const tally = empty(), random = randomFor(seed), int = (max: number): number => Math.floor(random() * max);
  for (let run = 0; run < RUNS; run++) {
    const [a, b] = pair(candidate, 1 + int(2));
    try {
      const beat = IDS[int(IDS.length)] ?? "B1", others = IDS.filter(id => id !== beat && IDS[IDS.indexOf(beat) + 1] !== id);
      const target = (): string => others[int(others.length)] ?? "B1";
      let letters = ROWS.map(row => row.audioText).join(""), split: string | null = null;
      if (kind === "two moves") { candidate.move(a, beat, target(), "A"); candidate.move(b, beat, target(), "B"); }
      if (kind === "typing") {
        candidate.move(a, beat, target(), "A");
        const at = int(5);
        b.splice(beat, "audioText", at, at, [{ text: "X", marks: {} }]);
        letters += "X";
      }
      if (kind === "split") { candidate.move(a, beat, target(), "A"); candidate.split(b, beat, 1 + int(3), "S1"); split = "S1"; }
      if (kind === "two splits") {
        const near = int(2) === 0;
        candidate.split(a, beat, near ? 1 : 3, "S1");
        candidate.split(b, beat, near ? 3 : 1, "S2");
      }
      if (kind === "split then move" || kind === "split then move the new beat") {
        candidate.split(a, beat, 2, "S1");
        exchange(a, b);
        candidate.move(a, kind === "split then move" ? beat : "S1", target(), "A");
        split = "S1";
      }
      const final = settle(tally, a, b, letters);
      const rows = final.rows.map(row => row.id);
      if (rows.filter(id => id === beat).length !== 1) tally.beatNotOnce++;
      const mine = final.rows.find(row => row.id === beat)?.audio ?? "";
      if (kind === "typing" && !mine.includes("X")) tally.leftBehind++;
      if (kind === "split" && split && rows[rows.indexOf(beat) + 1] !== split) tally.leftBehind++;
      if (kind.startsWith("split then move") && split && rows[rows.indexOf(beat) + 1] === split) tally.draggedAlong++;
      if (kind === "two splits") {
        const original = ROWS.find(row => row.id === beat)?.audioText ?? "";
        const parts = [beat, "S1", "S2"].map(id => final.rows.find(row => row.id === id)?.audio ?? "");
        const shownInOrder = rows.filter(id => [beat, "S1", "S2"].includes(id)).map(id => final.rows.find(row => row.id === id)?.audio ?? "").join("");
        if (parts.join("").length === original.length && shownInOrder !== original) tally.outOfTypedOrder++;
      }
    } finally { a.destroy(); b.destroy(); }
  }
  return tally;
}

const results = new Map<string, Record<Race, Tally>>();
for (const candidate of CANDIDATES) {
  test(`E7 candidate ${candidate.name}`, t => {
    const byRace = Object.fromEntries(RACES.map((kind, index) => [kind, race(candidate, kind, 101 + index)])) as Record<Race, Tally>;
    results.set(candidate.name, byRace);
    t.diagnostic(JSON.stringify(byRace));
    for (const tally of Object.values(byRace)) assert.equal(tally.runs, RUNS);
    for (const tally of Object.values(byRace)) assert.equal(tally.disagree, 0);
  });
}

test("E7 candidates: only the placement keeps every race in the moved beat and in typed order", () => {
  const d = results.get("d: placement on the block");
  assert.ok(d);
  for (const tally of Object.values(d)) {
    assert.deepEqual({ ...tally, runs: 0 }, { ...empty(), runs: 0 });
  }
  const a = results.get("a: copy and delete");
  assert.ok(a && a["two moves"].lostOrDoubled > 0 && a.typing.leftBehind > 0);
  for (const name of ["b: number per segment", "c: order list of segments"]) {
    assert.equal(results.get(name)?.["split then move"].draggedAlong, RUNS);
    assert.equal(results.get(name)?.["split then move the new beat"].draggedAlong, RUNS);
  }
  for (const name of ["b: number per block", "c: order list of blocks"]) {
    const tally = results.get(name);
    assert.ok(tally && tally["two splits"].outOfTypedOrder > 0 && tally.split.leftBehind > 0);
  }
});
