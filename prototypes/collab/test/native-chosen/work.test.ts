import assert from "node:assert/strict";
import test from "node:test";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { deleteIn, joinUp, splitAt, typeAt } from "../../src/native/rows.ts";
import { STRAY_ROW } from "../../src/native/variant.ts";
import { b, base, h, load, outline, seed, sync } from "./kit.ts";
import type { Spec } from "./kit.ts";

type Act = (replica: ChosenReplica) => void;
interface Work { name: string; acts: Act[]; rows: string[]; marks?: boolean }
interface State { name: string; spec: () => Spec; rows: string[]; work: Work[] }

const TAIL = ["D: jkl / 4", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"];
const type = (row: string, at: number, text: string, field: "audioText" | "visualText" = "audioText"): Act => replica => { typeAt(replica, row, field, at, text); };
const erase = (row: string, from: number, to: number): Act => replica => { deleteIn(replica, row, "audioText", from, to); };
const mark = (beat: string, from: number, to: number, key: string): Act => replica => { replica.format(beat, "audioText", from, to, { [key]: true }); };
const split = (row: string, at: number, created = "N"): Act => replica => { splitAt(replica, row, at, created); };
const join = (row: string): Act => replica => { assert.equal(joinUp(replica, row), true); };
const unjoin = (beat: string): Act => replica => { replica.unjoin(beat); };
const move = (row: string, target: string | null, after = true, intoScene?: string): Act => replica => {
  replica.drop({ unit: "row", first: row, target, after, ...intoScene ? { intoScene } : {} });
};
const remove = (row: string): Act => replica => { replica.deleteRows([row]); };

const prefixSpec = (): Spec => {
  const spec = base(); spec.segments.S = { units: ["Ωψ", b("B"), "def", b("C"), "ghi"] };
  delete spec.beats.A; delete spec.visuals.A; return spec;
};
const aboveSpec = (): Spec => { const spec = base(); spec.segments.V = { units: ["Ωψ"] }; delete spec.beats.F; delete spec.visuals.F; return spec; };
const straySpec = (): Spec => ({ order: ["S"], segments: { S: { units: ["Ωψ"] } }, beats: {}, visuals: {}, headings: {} });
const repeatSpec = (): Spec => { const spec = base(); spec.segments.S = { head: b("A"), units: ["abc", b("B"), b("B"), "defdef", b("C"), "ghi"] }; return spec; };
const staleSpec = (): Spec => { const spec = base(); spec.beats.C = { joined: { into: "A", glue: " " } }; return spec; };

// why: each expected outline is written by hand from what a person saw and did; undo must give back the starting rows
const STATES: State[] = [
  {
    name: "rule a, stray text shown at the start of the segment's first beat",
    spec: prefixSpec, rows: ["B: Ωψdef / 2", "C: ghi / 3", ...TAIL],
    work: [
      { name: "type inside the stray text", acts: [type("B", 1, "X")], rows: ["B: ΩXψdef / 2", "C: ghi / 3", ...TAIL] },
      { name: "type in the visual cell", acts: [type("B", 1, "X", "visualText")], rows: ["B: Ωψdef / 2X", "C: ghi / 3", ...TAIL] },
      { name: "delete across the hidden boundary", acts: [erase("B", 1, 3)], rows: ["B: Ωef / 2", "C: ghi / 3", ...TAIL] },
      { name: "bold across the hidden boundary", acts: [mark("B", 0, 3, "b")], marks: true, rows: ["B: [Ωψ|b][d|b]ef / 2", "C: ghi / 3", ...TAIL] },
      { name: "tag across the hidden boundary", acts: [mark("B", 1, 4, "t:T")], marks: true, rows: ["B: Ω[ψ|t:T][de|t:T]f / 2", "C: ghi / 3", ...TAIL] },
      { name: "split inside the stray text: no copy, so the boundary goes where the beat's own text starts", acts: [split("B", 1)], rows: ["B: Ωψ / 2", "N: def / ", "C: ghi / 3", ...TAIL] },
      { name: "split at the hidden boundary", acts: [split("B", 2)], rows: ["B: Ωψ / 2", "N: def / ", "C: ghi / 3", ...TAIL] },
      { name: "split in the beat's own text", acts: [split("B", 3)], rows: ["B: Ωψd / 2", "N: ef / ", "C: ghi / 3", ...TAIL] },
      { name: "join the row below up", acts: [join("C")], rows: ["B(B+C): Ωψdef ghi / 2\n3", ...TAIL] },
      { name: "join then unjoin", acts: [join("C"), unjoin("C")], rows: ["B: Ωψdef / 2", "C: ghi / 3", ...TAIL] },
      { name: "move the row", acts: [move("B", "D")], rows: ["C: ghi / 3", "D: jkl / 4", "B: Ωψdef / 2", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"] },
      { name: "delete the row", acts: [remove("B")], rows: ["C: ghi / 3", ...TAIL] }
    ]
  },
  {
    name: "rule a, a segment with no beat shown at the end of the row above",
    spec: aboveSpec, rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqrΩψ / 5", "#I stu"],
    work: [
      { name: "type inside the stray text", acts: [type("E", 4, "X")], rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqrΩXψ / 5", "#I stu"] },
      { name: "type at the join of the two texts", acts: [type("E", 3, "X")], rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqrXΩψ / 5", "#I stu"] },
      { name: "delete across the two texts", acts: [erase("E", 2, 4)], rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqψ / 5", "#I stu"] },
      { name: "bold across the two texts", acts: [mark("E", 2, 5, "b")], marks: true, rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pq[r|b][Ωψ|b] / 5", "#I stu"] },
      { name: "split inside the stray text: no copy, so the segment's text goes with the new boundary", acts: [split("E", 4)], rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqr / 5", "N: Ωψ / ", "#I stu"] },
      { name: "split where the stray text starts", acts: [split("E", 3)], rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqr / 5", "N: Ωψ / ", "#I stu"] },
      { name: "split in the beat's own text", acts: [split("E", 1)], rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: p / 5", "N: qrΩψ / ", "#I stu"] },
      { name: "split then join back", acts: [split("E", 3), join("N")], rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E(E+N): pqr Ωψ / 5", "#I stu"] },
      { name: "move the row", acts: [move("E", "A")], rows: ["A: abc / 1", "E: pqrΩψ / 5", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "#I stu"] },
      { name: "delete the row", acts: [remove("E")], rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "#I stu"] }
    ]
  },
  {
    name: "rule b, the narration-only row of an empty script",
    spec: straySpec, rows: ["~stray: Ωψ / "],
    work: [
      { name: "type in the narration", acts: [type(STRAY_ROW, 1, "X")], rows: ["~stray: ΩXψ / "] },
      { name: "delete from the narration", acts: [erase(STRAY_ROW, 0, 1)], rows: ["~stray: ψ / "] },
      { name: "bold", acts: [mark(STRAY_ROW, 0, 1, "b")], marks: true, rows: ["~stray: [Ω|b]ψ / "] },
      { name: "tag", acts: [mark(STRAY_ROW, 0, 1, "t:T")], marks: true, rows: ["~stray: [Ω|t:T]ψ / "] },
      { name: "type in the visual cell gives the row a record", acts: [type(STRAY_ROW, 0, "V", "visualText")], rows: ["~stray:1.1: Ωψ / V"] },
      { name: "split", acts: [split(STRAY_ROW, 1)], rows: ["N^: Ω / ", "N: ψ / "] },
      { name: "split then join back", acts: [split(STRAY_ROW, 1), join("N")], rows: ["N^(N^+N): Ω ψ / "] },
      { name: "split, join and unjoin", acts: [split(STRAY_ROW, 1), join("N"), unjoin("N")], rows: ["N^: Ω / ", "N: ψ / "] },
      { name: "a heading above it", acts: [replica => { replica.createHeading(STRAY_ROW, "J", "z"); }], rows: ["#J z", "J^: Ωψ / "] },
      { name: "delete the row", acts: [remove(STRAY_ROW)], rows: [] }
    ]
  },
  {
    name: "rule b, the narration-only row above a heading",
    spec: () => ({ order: ["U", "S"], segments: { U: { head: h("I"), units: ["stu"] }, S: { units: ["Ω"] } }, beats: {}, visuals: {}, headings: { I: {} } }),
    rows: ["~stray: Ω / ", "#I stu"],
    work: [{ name: "move it into the scene", acts: [move(STRAY_ROW, null, false, "I")], rows: ["#I stu", "~stray:1.1: Ω / "] }]
  },
  {
    name: "rule c, narration doubled after two deletes and two undos",
    spec: repeatSpec, rows: ["A: abc / 1", "B: defdef / 2", "C: ghi / 3", ...TAIL],
    work: [
      { name: "type in the second copy", acts: [type("B", 3, "X")], rows: ["A: abc / 1", "B: defXdef / 2", "C: ghi / 3", ...TAIL] },
      { name: "type at the start", acts: [type("B", 0, "X")], rows: ["A: abc / 1", "B: Xdefdef / 2", "C: ghi / 3", ...TAIL] },
      { name: "delete across the copies", acts: [erase("B", 2, 4)], rows: ["A: abc / 1", "B: deef / 2", "C: ghi / 3", ...TAIL] },
      { name: "bold across the copies", acts: [mark("B", 2, 4, "b")], marks: true, rows: ["A: abc / 1", "B: de[fd|b]ef / 2", "C: ghi / 3", ...TAIL] },
      { name: "tag the second copy", acts: [mark("B", 3, 6, "t:T")], marks: true, rows: ["A: abc / 1", "B: def[def|t:T] / 2", "C: ghi / 3", ...TAIL] },
      { name: "split between the copies", acts: [split("B", 3)], rows: ["A: abc / 1", "B: def / 2", "N: def / ", "C: ghi / 3", ...TAIL] },
      { name: "join the row below up", acts: [join("C")], rows: ["A: abc / 1", "B(B+C): defdef ghi / 2\n3", ...TAIL] },
      { name: "move the row", acts: [move("B", "D")], rows: ["A: abc / 1", "C: ghi / 3", "D: jkl / 4", "B: defdef / 2", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"] },
      { name: "delete the row", acts: [remove("B")], rows: ["A: abc / 1", "C: ghi / 3", ...TAIL] }
    ]
  },
  {
    name: "rule d, a join whose target is not directly above",
    spec: staleSpec, rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", ...TAIL],
    work: [
      { name: "type", acts: [type("C", 1, "X")], rows: ["A: abc / 1", "B: def / 2", "C: gXhi / 3", ...TAIL] },
      { name: "bold", acts: [mark("C", 0, 1, "b")], marks: true, rows: ["A: abc / 1", "B: def / 2", "C: [g|b]hi / 3", ...TAIL] },
      { name: "join up names the beat above", acts: [join("C")], rows: ["A: abc / 1", "B(B+C): def ghi / 2\n3", ...TAIL] },
      { name: "unjoin clears the flag and nothing visible changes", acts: [unjoin("C")], rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", ...TAIL] },
      { name: "split", acts: [split("C", 1)], rows: ["A: abc / 1", "B: def / 2", "C: g / 3", "N: hi / ", ...TAIL] },
      { name: "move it under the beat it names, and the old join counts again", acts: [move("C", "A")], rows: ["A(A+C): abc ghi / 1\n3", "B: def / 2", ...TAIL] },
      { name: "delete the row", acts: [remove("C")], rows: ["A: abc / 1", "B: def / 2", ...TAIL] }
    ]
  }
];

test("E11 work in rule rows: each edit lands where the person saw it, copies agree, and undo gives the rows back", () => {
  let checked = 0;
  for (const state of STATES) {
    const bytes = seed(state.spec());
    for (const work of state.work) {
      const label = `${state.name}: ${work.name}`, copies = [1, 2, 3].map(client => load(bytes, client));
      const [first] = copies as [ChosenReplica];
      try {
        assert.deepEqual(outline(first), state.rows, `${label}, before`);
        for (const act of work.acts) act(first);
        assert.deepEqual(outline(first, work.marks), work.rows, label);
        sync(copies);
        const late = load(first.encode(), 44);
        for (const copy of [...copies, late]) assert.deepEqual(outline(copy, work.marks), work.rows, `${label}, copy ${copy.doc.clientID}`);
        late.destroy();
        for (let step = 0; step < work.acts.length; step++) assert.equal(first.undoPress(), true, `${label}, undo ${step + 1}`);
        assert.deepEqual(outline(first, true), outline(load(bytes, 45), true), `${label}, after undo`);
        sync(copies);
        for (const copy of copies) assert.deepEqual(outline(copy), state.rows, `${label}, copy ${copy.doc.clientID} after undo`);
        checked++;
      } finally { for (const copy of copies) copy.destroy(); }
    }
  }
  assert.equal(checked, STATES.reduce((sum, state) => sum + state.work.length, 0));
});
