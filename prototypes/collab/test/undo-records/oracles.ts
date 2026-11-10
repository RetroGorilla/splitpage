import type { ScriptOracle } from "../../src/model.ts";

const removalRows = {
  r1: { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1", "?", {}]] },
  r1Older: { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] },
  r2: { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] },
  r3: { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}], ["b1", "!", {}]] },
  r3Older: { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }
} as const;

export const identicalRemovalOracles: Record<string, ScriptOracle> = {
  removed: { rows: [removalRows.r1, removalRows.r3], carets: {}, recovery: [{ row: removalRows.r2, by: "<either writer>", edited: [] }] },
  restored: { rows: [removalRows.r1, removalRows.r2, removalRows.r3], carets: {}, recovery: [] },
  "Alice older undone": { rows: [removalRows.r1Older, removalRows.r2, removalRows.r3], carets: {}, recovery: [] },
  "Bob older undone": { rows: [removalRows.r1, removalRows.r2, removalRows.r3Older], carets: {}, recovery: [] }
};

export const reRemovalOracles: Record<string, ScriptOracle> = {
  removed: { rows: [removalRows.r1Older, removalRows.r3Older], carets: {}, recovery: [{ row: removalRows.r2, by: "<either writer>", edited: [] }] },
  "removed by Alice": { rows: [removalRows.r1Older, removalRows.r3Older], carets: {}, recovery: [{ row: removalRows.r2, by: "Alice", edited: [] }] },
  restored: { rows: [removalRows.r1Older, removalRows.r2, removalRows.r3Older], carets: {}, recovery: [] }
};

const plainMug = [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5", "r", {}], ["s6", "e", {}], ["s7", "d", {}], ["s8", " ", {}], ["s9", "m", {}], ["s10", "u", {}], ["s11", "g", {}]] as const;
const taggedMug = [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5", "r", { tag: "P" }], ["s6", "e", { tag: "P" }], ["s7", "d", { tag: "P" }], ["s8", " ", { tag: "P" }], ["s9", "m", { tag: "P" }], ["s10", "u", { tag: "P" }], ["s11", "g", { tag: "P" }]] as const;

export const identicalTagOracles: Record<string, ScriptOracle> = {
  tagged: { rows: [{ id: "R1", characters: taggedMug }, { id: "R2", characters: [["b1", "!", {}], ["s12", "o", {}], ["s13", "k", {}], ["a1", "?", {}]] }], carets: {}, recovery: [] },
  untagged: { rows: [{ id: "R1", characters: plainMug }, { id: "R2", characters: [["b1", "!", {}], ["s12", "o", {}], ["s13", "k", {}], ["a1", "?", {}]] }], carets: {}, recovery: [] },
  "Alice older undone": { rows: [{ id: "R1", characters: plainMug }, { id: "R2", characters: [["b1", "!", {}], ["s12", "o", {}], ["s13", "k", {}]] }], carets: {}, recovery: [] },
  "Bob older undone": { rows: [{ id: "R1", characters: plainMug }, { id: "R2", characters: [["s12", "o", {}], ["s13", "k", {}], ["a1", "?", {}]] }], carets: {}, recovery: [] }
};

const joined = { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["[glue]", " ", {}], ["s3", "c", {}], ["s4", "d", {}]] } as const;
const separate = [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }] as const;

export const rejoinOracles: Record<string, ScriptOracle> = {
  joined: { rows: [joined], carets: {}, recovery: [] },
  separate: { rows: [...separate], carets: {}, recovery: [] }
};

export const insideRangeOracles: Record<string, ScriptOracle> = {
  typed: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1", "x", {}], ["b1", "Q", {}], ["a2", "y", {}], ["a3", "z", {}]] }], carets: {}, recovery: [] },
  undone: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "Q", {}]] }], carets: { A: { beat: "R1", offset: 2 } }, recovery: [] }
};

export const doubleDeleteOracles: Record<string, ScriptOracle> = {
  deleted: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s4", "d", {}]] }], carets: {}, recovery: [] },
  "both undone": { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2*", "b", {}], ["s3*", "c", {}], ["s4", "d", {}]] }], carets: {}, recovery: [] }
};

export const redoOracles: Record<string, ScriptOracle> = {
  typed: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1", "x", {}], ["a2", "y", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }], carets: {}, recovery: [] },
  undone: { rows: [...separate], carets: {}, recovery: [] },
  "remote elsewhere": { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["b1", "Z", {}], ["s4", "d", {}]] }], carets: {}, recovery: [] },
  redone: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1*", "x", {}], ["a2*", "y", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["b1", "Z", {}], ["s4", "d", {}]] }], carets: {}, recovery: [] }
};

const chainBase = [["b1", "Q", {}], ["s1", "a", {}], ["s2", "b", {}]] as const;

export const chainOracles: Record<string, ScriptOracle> = {
  commands: { rows: [{ id: "R1", characters: chainBase }], carets: {}, recovery: [] },
  "delete undone": { rows: [{ id: "R1", characters: [...chainBase, ["a1*", "x", { b: true }]] }], carets: {}, recovery: [] },
  "format undone": { rows: [{ id: "R1", characters: [...chainBase, ["a1*", "x", {}]] }], carets: {}, recovery: [] },
  "insert undone": { rows: [{ id: "R1", characters: chainBase }], carets: {}, recovery: [] },
  "insert redone": { rows: [{ id: "R1", characters: [...chainBase, ["a1**", "x", {}]] }], carets: {}, recovery: [] },
  "format redone": { rows: [{ id: "R1", characters: [...chainBase, ["a1**", "x", { b: true }]] }], carets: {}, recovery: [] },
  "delete redone": { rows: [{ id: "R1", characters: chainBase }], carets: {}, recovery: [] }
};

export const statusOracles: Record<string, ScriptOracle> = {
  shot: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "shot" }], carets: {}, recovery: [] },
  ready: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "ready" }], carets: {}, recovery: [] },
  todo: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "todo" }], carets: {}, recovery: [] }
};

export const positionControlOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["b1", "Q", {}], ["s1", "a", {}], ["s2", "b", {}]] }], carets: {}, recovery: []
};
