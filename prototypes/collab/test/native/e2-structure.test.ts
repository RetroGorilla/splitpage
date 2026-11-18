import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { NativeReplica, nativeCopy } from "../../src/native/variant.ts";
import type { NativeDeltaItem } from "../../src/native/variant.ts";
import { joinUp, typeAt } from "../../src/native/rows.ts";
import { measureE2Size } from "./e2-size.ts";
import { closeE2, generateE2, reach, runE2, shownRecovery, shownRows, shrinkE2 } from "./structure-model.ts";
import type { E2Delivery, E2Result, E2Step } from "./structure-model.ts";

const DELIVERIES: readonly E2Delivery[] = ["forward", "reverse", "twice", "shuffled", "state"];
const everyone = (from: number): E2Step[] => [0, 1, 2].filter(to => to !== from).map(to => ({ op: "deliver", from, to }));
const SETTLE: E2Step[] = [...everyone(0), ...everyone(1), ...everyone(2), ...everyone(0), ...everyone(1)];
const UNTOUCHED = ["R3: ghi / qr", "R4: jkl / st"];

interface Case { steps: E2Step[]; rows: string[]; recovery?: string[]; misordered?: boolean }

// why: two insertions at one gap made apart are ordered by the library with the lower client id first (#1 is client 1);
// the model fixes no such order, it holds the first one shown, and these expectations state the library's
const CASES: Record<string, Case> = {
  "a split and typing at the same gap of the narration": {
    steps: [{ op: "split", by: 0, row: "R1", at: 2 }, { op: "type", by: 1, row: "R1", field: "a", at: 2 }],
    rows: ["R1: ab / mn", "S1: Ac", "R2: def / op", ...UNTOUCHED]
  },
  "a split while someone types in the visual cell of the beat being split": {
    steps: [{ op: "split", by: 0, row: "R1", at: 1 }, { op: "type", by: 1, row: "R1", field: "v", at: 1 }],
    rows: ["R1: a / mAn", "S1: bc", "R2: def / op", ...UNTOUCHED]
  },
  "a join while two others type in the narration and visual cells of both beats": {
    steps: [{ op: "join", by: 0, row: "R2" }, { op: "type", by: 1, row: "R2", field: "a", at: 1 }, { op: "type", by: 1, row: "R2", field: "v", at: 1 },
      { op: "type", by: 2, row: "R1", field: "v", at: 2 }],
    rows: ["R1(R1+R2): abc dAef / mnC|oBp", ...UNTOUCHED]
  },
  "two people join the same pair": {
    steps: [{ op: "join", by: 0, row: "R2" }, { op: "join", by: 1, row: "R2" }],
    rows: ["R1(R1+R2): abc def / mn|op", ...UNTOUCHED]
  },
  "a chain: one joins 1+2 while another joins 2+3 and a third 3+4": {
    steps: [{ op: "join", by: 0, row: "R2" }, { op: "join", by: 1, row: "R3" }, { op: "join", by: 2, row: "R4" }],
    rows: ["R1(R1+R2+R3+R4): abc def ghi jkl / mn|op|qr|st"]
  },
  "a loop of two join flags written directly breaks at the beat earliest in order": {
    steps: [{ op: "flag", by: 0, beat: "R1", into: "R2" }, { op: "flag", by: 1, beat: "R2", into: "R1" }],
    rows: ["R1(R1+R2): abc def / mn|op", ...UNTOUCHED], recovery: ["loop R1: "]
  },
  "a loop of three join flags written directly": {
    steps: [{ op: "flag", by: 0, beat: "R1", into: "R3" }, { op: "flag", by: 1, beat: "R2", into: "R1" }, { op: "flag", by: 2, beat: "R3", into: "R2" }],
    rows: ["R1(R1+R2+R3): abc def ghi / mn|op|qr", "R4: jkl / st"], recovery: ["loop R1: "]
  },
  "a split inside a joined row, with typing at the seam before and after the glue": {
    steps: [{ op: "join", by: 0, row: "R2" }, ...everyone(0), { op: "split", by: 1, row: "R1", at: 1 },
      { op: "type", by: 2, row: "R1", field: "a", at: 3 }, { op: "type", by: 2, row: "R1", field: "a", at: 5 }],
    rows: ["R1: a / mn", "S1(S1+R2): bcAB def / op", ...UNTOUCHED]
  },
  "a split at the seam undoes the join while someone types on both sides of it": {
    steps: [{ op: "join", by: 0, row: "R2" }, ...everyone(0), { op: "split", by: 1, row: "R1", at: 4 },
      { op: "type", by: 2, row: "R1", field: "a", at: 3 }, { op: "type", by: 2, row: "R1", field: "a", at: 6 },
      { op: "type", by: 2, row: "R1", field: "v", at: 2 }, { op: "type", by: 2, row: "R1", field: "v", at: 5 }],
    rows: ["R1: abcA / mnC", "R2: dBef / oDp", ...UNTOUCHED]
  },
  "a selection over the seam deleted while the seam is undone": {
    steps: [{ op: "join", by: 0, row: "R2" }, ...everyone(0), { op: "delete", by: 1, row: "R1", field: "a", at: 2, span: 3 },
      { op: "split", by: 2, row: "R1", at: 3 }],
    rows: ["R1: ab / mn", "R2: ef / op", ...UNTOUCHED]
  },
  "finding: a split inside a beat while another person joins the next beat to it": {
    steps: [{ op: "join", by: 0, row: "R2" }, { op: "split", by: 1, row: "R1", at: 1 }],
    rows: ["R1(R1+R2): a def / mn|op", "S1: bc", ...UNTOUCHED], misordered: true
  },
  "a removal while someone splits the same beat": {
    steps: [{ op: "remove", by: 0, row: "R2" }, { op: "split", by: 1, row: "R2", at: 1 }],
    rows: ["R1: abc / mn", "S1: ef", ...UNTOUCHED], recovery: ["removed R2: d / op"]
  },
  "a removal while someone joins the same beat to the row above": {
    steps: [{ op: "remove", by: 0, row: "R2" }, { op: "join", by: 1, row: "R2" }],
    rows: ["R1: abc / mn", ...UNTOUCHED], recovery: ["removed R2: def / op"]
  },
  "a removal of the row another person joins the next beat into, then a restore": {
    steps: [{ op: "remove", by: 0, row: "R1" }, { op: "join", by: 1, row: "R2" }, ...everyone(0), ...everyone(1),
      { op: "restore", by: 2, entry: "R1" }],
    rows: ["R1(R1+R2): abc def / mn|op", ...UNTOUCHED]
  },
  "a removal of the row another person joins the next beat into, without a restore": {
    steps: [{ op: "remove", by: 0, row: "R1" }, { op: "join", by: 1, row: "R2" }],
    rows: UNTOUCHED, recovery: ["removed R1(R1+R2): abc def / mn|op"]
  },
  "a removal of a joined row while someone types in its later beat": {
    steps: [{ op: "join", by: 0, row: "R2" }, ...everyone(0), { op: "remove", by: 1, row: "R1" },
      { op: "type", by: 2, row: "R1", field: "a", at: 5 }, { op: "type", by: 2, row: "R1", field: "v", at: 4 }],
    rows: UNTOUCHED, recovery: ["removed R1(R1+R2): abc dAef / mn|oBp"]
  },
  "a restore after others typed into the removed beat unseen": {
    steps: [{ op: "remove", by: 0, row: "R2" }, { op: "type", by: 1, row: "R2", field: "a", at: 1 }, { op: "type", by: 1, row: "R2", field: "v", at: 0 },
      { op: "deliver", from: 0, to: 2 }, { op: "deliver", from: 1, to: 2 }, { op: "restore", by: 2, entry: "R2" }],
    rows: ["R1: abc / mn", "R2: dAef / Bop", ...UNTOUCHED]
  },
  "two removals at once and a restore that saw the later client's": {
    steps: [{ op: "remove", by: 0, row: "R2" }, { op: "remove", by: 1, row: "R2" }, { op: "deliver", from: 1, to: 2 }, { op: "restore", by: 2, entry: "R2" }],
    rows: ["R1: abc / mn", "R2: def / op", ...UNTOUCHED]
  },
  "two removals at once and a restore that saw the earlier client's": {
    steps: [{ op: "remove", by: 0, row: "R2" }, { op: "remove", by: 1, row: "R2" }, { op: "deliver", from: 0, to: 2 }, { op: "restore", by: 2, entry: "R2" }],
    rows: ["R1: abc / mn", ...UNTOUCHED], recovery: ["removed R2: def / op"]
  },
  "finding: one person removes a beat, joins the next to the row above, then restores": {
    steps: [{ op: "remove", by: 0, row: "R2" }, { op: "join", by: 0, row: "R3" }, { op: "restore", by: 0, entry: "R2" }],
    rows: ["R1(R1+R3): abc ghi / mn|qr", "R2: def / op", "R4: jkl / st"], misordered: true
  },
  "a restore while another person, who still sees the beat removed, joins the next one up": {
    steps: [{ op: "remove", by: 0, row: "R2" }, ...everyone(0), { op: "restore", by: 1, entry: "R2" }, { op: "join", by: 2, row: "R3" }],
    rows: ["R1(R1+R3): abc ghi / mn|qr", "R2: def / op", "R4: jkl / st"], misordered: true
  }
};

for (const [name, item] of Object.entries(CASES)) for (const delivery of DELIVERIES) {
  test(`E2 ${name}, ${delivery} delivery`, () => {
    const result = runE2([...item.steps, ...SETTLE], { delivery });
    try {
      assert.deepEqual(result.problems, []);
      assert.deepEqual(result.rows, item.rows);
      assert.deepEqual(result.recovery, item.recovery ?? []);
      assert.equal(result.misordered, item.misordered ?? false);
    } finally { closeE2(result); }
  });
}

test("E2 generated histories: three writers and a late joiner agree, nothing is missing, doubled or out of reach", t => {
  let histories = 0, executed = 0, misordered = 0;
  for (const delivery of DELIVERIES) for (let seed = 1; seed <= 200; seed++) {
    const steps = generateE2(seed * 7919, 30), result = runE2(steps, { delivery, seed });
    try {
      if (result.problems.length) {
        const short = shrinkE2(steps, candidate => { const again = runE2(candidate, { delivery, seed }); const failed = again.problems.length > 0; closeE2(again); return failed; });
        const again = runE2(short, { delivery, seed });
        assert.fail(`${delivery} seed ${seed}: ${again.labels.join("; ")} => ${again.problems.join(" | ")}`);
      }
      histories++; executed += result.executed; if (result.misordered) misordered++;
    } finally { closeE2(result); }
  }
  t.diagnostic(`${histories} histories, ${executed} commands, ${misordered} with rows out of stored order`);
  assert.equal(histories, 1000);
  assert.ok(misordered > 0, "the follow-the-flag reading shows rows out of stored order in some histories");
});

function tampered(tamper: (replica: NativeReplica, late: boolean) => void): E2Result {
  return runE2([{ op: "join", by: 0, row: "R2" }, { op: "type", by: 1, row: "R2", field: "a", at: 1 }, { op: "remove", by: 2, row: "R3" }, ...SETTLE], { tamper });
}

function remotely(replica: NativeReplica, change: () => void): void {
  replica.doc.transact(change, "remote");
  replica.changes();
}

const NEGATIVE: Record<string, { tamper: (replica: NativeReplica, late: boolean) => void; expect: RegExp }> = {
  "drop a character": { tamper: (replica, late) => { if (!late) remotely(replica, () => { const cell = replica.cell("R2", "audioText"); cell.text.delete(cell.start, 1); }); }, expect: /narration holds/ },
  "misplace a character": {
    tamper: (replica, late) => {
      if (late) return;
      remotely(replica, () => { const from = replica.cell("R2", "audioText"); from.text.delete(from.start, 1); const to = replica.cell("R4", "audioText"); to.text.insert(to.start + 1, "d"); });
    },
    expect: /order .* breaks/
  },
  "misplace a visual character into another beat's cell": {
    tamper: (replica, late) => { if (!late) remotely(replica, () => { replica.visuals.get("R2")?.delete(0, 1); replica.visuals.get("R4")?.insert(0, "o"); }); },
    expect: /visual R2 holds/
  },
  "duplicate a character": { tamper: (replica, late) => { if (!late) remotely(replica, () => { const cell = replica.cell("R1", "audioText"); cell.text.insert(cell.start, "a"); }); }, expect: /twice/ },
  "strand a character in a container no row reads": {
    tamper: (replica, late) => {
      if (late) return;
      remotely(replica, () => {
        const cell = replica.cell("R4", "audioText"); cell.text.delete(cell.start, 1);
        const hidden = new Y.Map<unknown>(), text = new Y.Text("j");
        replica.segments.set("seg-hidden", hidden); hidden.set("head", { b: "R9" }); hidden.set("text", text);
      });
    },
    expect: /j is stored 1 time\(s\) and shown 0/
  }
};

for (const [name, control] of Object.entries(NEGATIVE)) {
  test(`E2 negative control: ${name} fails the checks`, () => {
    const clean = tampered(() => undefined);
    try { assert.deepEqual(clean.problems, []); } finally { closeE2(clean); }
    const result = tampered(control.tamper);
    try {
      assert.ok(result.problems.length > 0, "the check passed a tampered document");
      assert.match(result.problems.join("\n"), control.expect);
    } finally { closeE2(result); }
  });
}

test("E2 negative control: the stranding reach check catches a removed chain read by the spike's earlier rule", () => {
  const result = runE2([{ op: "remove", by: 0, row: "R1" }, { op: "join", by: 1, row: "R2" }, ...SETTLE], {
    tamper: replica => {
      const real = replica.recovery.bind(replica);
      replica.recovery = () => real().map(entry => ({ ...entry, members: [entry.beat], audio: entry.audio.slice(0, 1), visualItems: entry.visualItems.slice(0, 1) }));
    }
  });
  try { assert.match(result.problems.join("\n"), /d is stored 1 time\(s\) and shown 0/); } finally { closeE2(result); }
});

test("E2 negative control: a reader that shows one row's narration under another row fails the checks", () => {
  const result = runE2([{ op: "join", by: 0, row: "R2" }, ...SETTLE], {
    tamper: replica => {
      const real = replica.rows.bind(replica);
      replica.rows = () => { const rows = real(), [first, second] = rows; return first && second ? [{ ...first, audio: second.audio }, { ...second, audio: first.audio }, ...rows.slice(2)] : rows; };
    }
  });
  try {
    assert.match(result.problems.join("\n"), /rows .* the model reads/);
    assert.match(result.problems.join("\n"), /R1 audioText shows ghi; its beats' cells hold abcdef/);
  } finally { closeE2(result); }
});

function three(): NativeReplica[] {
  const seed = new NativeReplica(900);
  seed.hydrate({ rows: [{ id: "R1", audioText: "abc", visualText: "mn" }, { id: "R2", audioText: "def", visualText: "op" }] });
  const copies = [1, 2, 3].map(client => nativeCopy(seed, client));
  seed.destroy();
  return copies;
}

function settle(copies: readonly NativeReplica[]): string[] {
  for (let round = 0; round < 2; round++) for (const from of copies) for (const to of copies) {
    if (from !== to) { Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote"); to.changes(); }
  }
  const late = new NativeReplica(800);
  Y.applyUpdate(late.doc, Y.encodeStateAsUpdate((copies[0] as NativeReplica).doc), "remote");
  late.changes();
  for (const replica of [...copies, late]) {
    assert.deepEqual([shownRows(replica), shownRecovery(replica)], [shownRows(late), shownRecovery(late)]);
    assert.deepEqual(reach(replica), []);
  }
  const reading = [...shownRows(late), ...shownRecovery(late)];
  late.destroy();
  return reading;
}

test("E2 typing on both sides of a seam while it is joined and after the join is undone by the undo manager", () => {
  const [a, b, c] = three() as [NativeReplica, NativeReplica, NativeReplica];
  joinUp(a, "R2"); settle([a, b, c]);
  typeAt(b, "R1", "audioText", 3, "A"); typeAt(c, "R1", "audioText", 5, "B");
  assert.ok(a.undo.undo() !== null); a.changes();
  assert.deepEqual(settle([a, b, c]), ["R1: abcA / mn", "R2: dBef / op"]);
  typeAt(b, "R1", "audioText", 4, "C"); typeAt(c, "R2", "audioText", 0, "D");
  assert.deepEqual(settle([a, b, c]), ["R1: abcAC / mn", "R2: DdBef / op"]);
  for (const replica of [a, b, c]) replica.destroy();
});

function boundary(replica: NativeReplica, beat: string): void {
  const block = replica.block(beat), text = replica.segments.get(block.segment)?.get("text") as Y.Text;
  replica.transact(() => { text.delete(block.start - 1, 1); });
  replica.changes();
}

test("E2 question 4: deleting the boundary between two beats of one container joins the narration without a flag and keeps typing", () => {
  const [a, b, c] = three() as [NativeReplica, NativeReplica, NativeReplica];
  a.split("R1", 1, "S1"); a.changes(); settle([a, b, c]);
  assert.equal(a.block("S1").segment, a.block("R1").segment);
  typeAt(c, "S1", "visualText", 0, "V"); settle([a, b, c]);
  boundary(a, "S1"); typeAt(b, "S1", "audioText", 1, "X"); typeAt(c, "S1", "visualText", 1, "W");
  assert.deepEqual(settle([a, b, c]), ["R1: abXc / mn", "R2: def / op", "unplaced S1:  / VW"],
    "the narration joins with the typing in it; the later beat's visual cell is reachable only through recovery, with no restore");
  assert.deepEqual(a.beats.get("S1")?.toJSON(), {}, "the beat record stays, read by nothing");
  for (const replica of [a, b, c]) replica.destroy();
});

test("E2 question 4: a join flag and a boundary deletion of the same pair made at once", () => {
  const [a, b, c] = three() as [NativeReplica, NativeReplica, NativeReplica];
  a.split("R1", 1, "S1"); a.changes(); typeAt(a, "S1", "visualText", 0, "V"); settle([a, b, c]);
  boundary(a, "S1"); joinUp(b, "S1");
  assert.deepEqual(settle([a, b, c]), ["R1: abc / mn", "R2: def / op", "unplaced S1:  / V"], "the flag on a beat without a boundary is read by nothing");
  for (const replica of [a, b, c]) replica.destroy();
});

test("E2 question 3: what repeated structural commands leave on a copy without undo history", () => {
  const rows = new Map(measureE2Size(100).map(row => [row.schedule.split(",")[0], row]));
  const joined = rows.get("split row R1 inside its longest beat"), split = rows.get("split R1 inside its longest beat"), toggled = rows.get("join R3 to R2");
  const removed = rows.get("remove R2"), unbound = rows.get("split inside R1");
  assert.ok(joined && split && toggled && removed && unbound);
  assert.ok(joined.bytesPerCycle > split.bytesPerCycle, "a join adds a flag that stays for every split it rejoins");
  assert.equal(joined.hiddenRecords, 100, "every rejoined split keeps a record and a visual cell that no row heads");
  assert.ok(toggled.bytesPerCycle < 1 && removed.bytesPerCycle < 1, "a flag set and deleted again leaves almost nothing once undo history is gone");
  assert.ok(toggled.editing > toggled.stored + 1000, "the editing copy's undo history keeps every deleted flag");
  assert.equal(unbound.hiddenRecords, 100, "a deleted boundary leaves its beat record unread");
  assert.equal(unbound.hiddenVisuals, 100, "and its visual cell");
});

test("E2 question 4: a beat that heads its own container has no boundary embed to delete", () => {
  const [a] = three() as [NativeReplica];
  const block = a.block("R2");
  assert.equal(block.start, 0, "R2's boundary is its container's head, not a character of the text");
  assert.deepEqual((a.segments.get(block.segment)?.get("text") as Y.Text).toDelta() as NativeDeltaItem[], [{ insert: "def" }]);
  a.destroy();
});
