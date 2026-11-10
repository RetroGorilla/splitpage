import type { ScriptOracle } from "../src/model.ts";

export const deletionOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["b1", "X", {}], ["s4", "d", {}]] }],
  carets: { A: { beat: "R1", offset: 1 } },
  recovery: []
};

export const restorationOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] },
    { id: "R2", characters: [["s3", "c", {}], ["b1", "X", {}], ["s4", "d", {}]] },
    { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }
  ],
  carets: { A: { beat: "R2", offset: 0 } },
  recovery: []
};

export const removedOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] },
    { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }
  ],
  carets: { A: { beat: "R3", offset: 0 } },
  recovery: [{ row: { id: "R2", characters: [["s3", "c", {}], ["b1", "X", {}], ["s4", "d", {}]] }, by: "Alice", edited: ["b1"] }]
};

export const joinOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", { b: true }], ["s2", "b", { b: true }], ["[glue]", " ", {}], ["s3", "c", {}], ["s4", "d", {}]] }],
  carets: { A: { beat: "R1", offset: 3 }, B: { beat: "R1", offset: 3 } },
  recovery: []
};

export const commentsOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [
    ["s1", "a", {}], ["s2", "b", { "c:C1": true }],
    ["s3", "c", { "c:C1": true, "c:C2": true }], ["s4", "d", { "c:C2": true }]
  ] }],
  carets: {},
  recovery: []
};

export const lengthOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], lengthSeconds: 12 }],
  carets: {},
  recovery: []
};

export const splitOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] },
    { id: "Ra", characters: [["b1", "X", {}], ["s3", "c", {}], ["s4", "d", {}]] }
  ],
  carets: { A: { beat: "Ra", offset: 0 }, B: { beat: "Ra", offset: 1 } },
  recovery: []
};

export const swappedSplitOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "X", {}]] },
    { id: "Ra", characters: [["s3", "c", {}], ["s4", "d", {}]] }
  ],
  carets: { A: { beat: "Ra", offset: 0 }, B: { beat: "R1", offset: 3 } },
  recovery: []
};

export const splitUndoOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "X", {}], ["s3", "c", {}], ["s4", "d", {}]] }],
  carets: { A: { beat: "R1", offset: 3 }, B: { beat: "R1", offset: 3 } },
  recovery: []
};
