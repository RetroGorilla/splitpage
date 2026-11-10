// why: literal copy of prototypes/collab/test/structure-oracles.ts; Stage 0 rows per export are in ../fixtures.ts.
// tools/test-collab-oracle-copies.mjs pins it; candidate A entries stay because the record is one literal.
import type { ScriptOracle } from "../checker.ts";

export const beatOracles: Record<string, ScriptOracle> = {
  "T05 two splits": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "Ra", characters: [] }, { id: "Rb", characters: [["s3", "c", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "Ra", offset: 0 }, B: { beat: "Rb", offset: 0 } }, recovery: []
  },
  "T05 two splits undo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "Rb", characters: [["s3", "c", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "R1", offset: 2 }, B: { beat: "Rb", offset: 0 } }, recovery: []
  },
  T07: {
    rows: [{ id: "R1", characters: [], visualText: "v<br>wQz", visuals: [{ id: "V1", characters: [["v1", "v", {}]] }, { id: "V2", characters: [["w1", "w", {}], ["b1", "Q", {}], ["w2", "z", {}]] }] }],
    carets: { B: { beat: "R1:visual", offset: 4 } }, recovery: []
  },
  "T07 undo": {
    rows: [{ id: "R1", characters: [], visualText: "v", visuals: [{ id: "V1", characters: [["v1", "v", {}]] }] }, { id: "R2", characters: [], visualText: "wQz", visuals: [{ id: "V2", characters: [["w1", "w", {}], ["b1", "Q", {}], ["w2", "z", {}]] }] }],
    carets: { B: { beat: "R2:visual", offset: 2 } }, recovery: []
  },
  "T08 remove": {
    rows: [{ id: "R0", characters: [["s1", "x", {}]] }, { id: "Rn", characters: [["s2", "I", {}], ["s3", "n", {}], ["b1", "Z", {}]] }, { id: "R1", characters: [["s4", "a", {}], ["s5", "b", {}], ["b2", "Y", {}]], paragraphStart: true }],
    carets: { A: { beat: "Rn", offset: 0 } }, recovery: []
  },
  "T08 remove undo": {
    rows: [{ id: "R0", characters: [["s1", "x", {}]] }, { id: "H1", kind: "heading", characters: [["s2", "I", {}], ["s3", "n", {}], ["b1", "Z", {}]] }, { id: "R1", characters: [["s4", "a", {}], ["s5", "b", {}], ["b2", "Y", {}]] }],
    carets: { A: { beat: "H1", offset: 0 } }, recovery: []
  },
  "T08 create": {
    rows: [{ id: "R1", characters: [["s1", "x", {}]] }, { id: "H2", kind: "heading", characters: [["s4", "A", {}], ["s5", "b", {}], ["b1", "e", {}]] }, { id: "R3", characters: [["b2", "Q", {}], ["s6", "c", {}], ["s7", "d", {}]] }],
    carets: { A: { beat: "R3", offset: 1 } }, recovery: []
  },
  "T08 create undo": {
    rows: [{ id: "R1", characters: [["s1", "x", {}]] }, { id: "R2", characters: [["s2*", "#", {}], ["s3*", " ", {}], ["s4", "A", {}], ["s5", "b", {}], ["b1", "e", {}]], paragraphStart: true }, { id: "R3", characters: [["b2", "Q", {}], ["s6", "c", {}], ["s7", "d", {}]] }],
    carets: {}, recovery: []
  },
  "T08 race": {
    rows: [{ id: "R1", characters: [["s1", "x", {}]] }, { id: "Hb", kind: "heading", characters: [["s4", "A", {}], ["s5", "b", {}]] }, { id: "R2", characters: [["s7", "r", {}], ["s8", "e", {}], ["s9", "s", {}], ["s10", "t", {}]] }],
    carets: {}, recovery: []
  },
  T09: {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["a1", "Z", {}], ["b1", "W", {}]] }, { id: "R3", characters: [["b3", "Y", {}], ["s8", "h", {}]] }],
    carets: { A: { beat: "R1", offset: 2 } }, recovery: [{ row: { id: "R2", characters: [["s4", "d", {}], ["b2", "X", {}], ["s5", "e", {}]] }, by: "Alice", edited: ["b2"] }]
  },
  "T09 undo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2*", "b", {}], ["b1", "W", {}], ["s3*", "c", {}]] }, { id: "R2", characters: [["s4", "d", {}], ["b2", "X", {}], ["s5", "e", {}]] }, { id: "R3", characters: [["s6*", "f", {}], ["s7*", "g", {}], ["b3", "Y", {}], ["s8", "h", {}]] }],
    carets: { A: { beat: "R1", offset: 1, selection: { beat: "R3", from: 1, to: 2 } } }, recovery: []
  },
  "T09 header": {
    rows: [{ id: "R1", characters: [["s1", "a", {}]] }, { id: "H1", kind: "heading", characters: [["s4", "d", {}], ["b1", "Q", {}]] }, { id: "R2", characters: [["s5", "e", {}], ["s6", "f", {}]] }],
    carets: { A: { beat: "R1", offset: 1 } }, recovery: []
  },
  "T09 header undo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2*", "b", {}]] }, { id: "H1", kind: "heading", characters: [["s3*", "C", {}], ["s4", "d", {}], ["b1", "Q", {}]] }, { id: "R2", characters: [["s5", "e", {}], ["s6", "f", {}]] }],
    carets: {}, recovery: []
  },
  "T12 undo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "Y", {}], ["b2", "X", {}], ["s3", "c", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "R1", offset: 4 } }, recovery: []
  },
  "T12 redo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "Y", {}]] }, { id: "Ra", characters: [["b2", "X", {}], ["s3", "c", {}], ["s4", "d", {}]] }],
    carets: {}, recovery: []
  },
  "T12 join": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["[glue]", " ", {}], ["s3", "c", {}], ["b1", "Z", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "R1", offset: 3 }, B: { beat: "R1", offset: 5 } }, recovery: []
  },
  "T12 join undo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["b1", "Z", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "R2", offset: 0 }, B: { beat: "R2", offset: 2 } }, recovery: []
  },
  "MOVE concurrent A": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }, { id: "R3", characters: [["s5", "e", {}], ["b1", "X", {}], ["s6", "f", {}]] }],
    carets: { A: { beat: "R3", offset: 0 }, B: { beat: "R3", offset: 2 } }, recovery: []
  },
  "MOVE concurrent B": {
    rows: [{ id: "R3", characters: [["s5", "e", {}], ["b1", "X", {}], ["s6", "f", {}]] }, { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "R3", offset: 0 }, B: { beat: "R3", offset: 2 } }, recovery: []
  },
  "MOVE concurrent undo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R3", characters: [["s5", "e", {}], ["b1", "X", {}], ["s6", "f", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "R3", offset: 0 }, B: { beat: "R3", offset: 2 } }, recovery: []
  },
  "MOVE destination A": {
    rows: [{ id: "R1", characters: [["b1", "Y", {}], ["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}], ["b2", "W", {}]] }, { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }],
    carets: { A: { beat: "R3", offset: 0 }, B: { beat: "R2", offset: 3 } }, recovery: []
  },
  "MOVE destination B": {
    rows: [{ id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }, { id: "R1", characters: [["b1", "Y", {}], ["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}], ["b2", "W", {}]] }],
    carets: { A: { beat: "R3", offset: 0 }, B: { beat: "R2", offset: 3 } }, recovery: []
  },
  "MOVE delete": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "R1", offset: 0 } }, recovery: [{ row: { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }, by: "Bob", edited: [] }]
  },
  "MOVE delete A": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }],
    carets: {}, recovery: [{ row: { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }, by: "Bob", edited: [] }]
  },
  "MOVE delete undo": {
    rows: [{ id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }, { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "R3", offset: 0 }, B: { beat: "R3", offset: 0 } }, recovery: []
  },
  "MOVE cut-paste": {
    rows: [{ id: "H1", kind: "heading", characters: [["s1", "A", {}]] }, { id: "R1", characters: [["s2", "a", {}], ["s3", "b", {}]] }, { id: "H2", kind: "heading", characters: [["s4", "B", {}]] }, { id: "R2", characters: [["s5", "c", {}], ["s6", "d", {}]] }],
    carets: { A: { beat: "R1", offset: 0, selection: { beat: "R1", from: 0, to: 2 } } }, recovery: []
  }
};
