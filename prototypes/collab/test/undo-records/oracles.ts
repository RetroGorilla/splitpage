import type { ScriptOracle } from "../../src/model.ts";

const removalRows = {
  r1: { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1", "?", {}]] },
  r1Older: { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] },
  r2: { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] },
  r3: { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}], ["b1", "!", {}]] },
  r3Older: { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }
} as const;

export const identicalRemovalOracles: Record<string, ScriptOracle> = {
  removed: { rows: [removalRows.r1, removalRows.r3], carets: {}, recovery: [{ row: removalRows.r2, by: "Alice, Bob", edited: [] }] },
  restored: { rows: [removalRows.r1, removalRows.r2, removalRows.r3], carets: {}, recovery: [] },
  "Alice older undone": { rows: [removalRows.r1Older, removalRows.r2, removalRows.r3], carets: {}, recovery: [] },
  "Bob older undone": { rows: [removalRows.r1, removalRows.r2, removalRows.r3Older], carets: {}, recovery: [] }
};

export const reRemovalOracles: Record<string, ScriptOracle> = {
  removed: { rows: [removalRows.r1Older, removalRows.r3Older], carets: {}, recovery: [{ row: removalRows.r2, by: "Alice, Bob", edited: [] }] },
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

export const redoneAtGapOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1*", "x", {}], ["a2*", "y", {}], ["b1", "Z", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }], carets: {}, recovery: []
};

const abcd = [["s1", "a", {}], ["s2", "b", {}], ["s3", "c", {}], ["s4", "d", {}]] as const;

export const fixedReaderOracles: Record<string, ScriptOracle> = {
  "both removed": {
    rows: [{ id: "R2", characters: [["s2", "z", {}]] }], carets: {},
    recovery: [{ row: { id: "R1", characters: [["s1", "a", {}], ["a1", "x", {}]] }, by: "Alice, Bob", edited: ["a1"] }]
  },
  "Ra removed": {
    rows: [{ id: "R1", characters: [["s1", "a", {}]] }], carets: {},
    recovery: [
      { row: { id: "Rb", characters: [["s2", "b", {}]] }, by: "Bob", edited: [] },
      { row: { id: "Ra", characters: [["s3", "c", {}], ["s4", "d", {}]] }, by: "Bob", edited: [], splitBy: "Alice" }
    ]
  },
  "join target removed": {
    rows: [], carets: {},
    recovery: [{ row: { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["[glue]", " ", {}], ["s3", "c", {}], ["s4", "d", {}]] }, by: "Bob", edited: ["s3", "s4"] }]
  }
};

export const endpointOracles: Record<string, ScriptOracle> = {
  "split at end": { rows: [{ id: "R1", characters: abcd }, { id: "Ra", characters: [] }], carets: {}, recovery: [] },
  "split at end undone": { rows: [{ id: "R1", characters: abcd }], carets: { A: { beat: "R1", offset: 4 } }, recovery: [] },
  "empty beat typed": { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["a1", "x", {}]] }], carets: {}, recovery: [] },
  "empty beat undone": { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [] }], carets: { A: { beat: "R2", offset: 0 } }, recovery: [] }
};

export const longChainOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], [`s2${"*".repeat(64)}`, "b", {}]] }], carets: {}, recovery: []
};

export const heldSelectionOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2*", "b", {}], ["s3*", "c", {}], ["s4", "d", {}]] }],
  carets: { A: { beat: "R1", offset: 1, selection: { beat: "R1", from: 1, to: 3 } } }, recovery: []
};

export const redoneRecoveryOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }], carets: {},
  recovery: [{ row: { id: "R2", characters: [["s3", "c", {}], ["a1*", "x", {}], ["s4", "d", {}]] }, by: "Bob", edited: [] }]
};

const joinR3 = [["[glue]", " ", {}], ["s5", "e", {}], ["s6", "f", {}]] as const;

export const joinRedoOracles: Record<string, ScriptOracle> = {
  "into R1": { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ...joinR3] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }], carets: {}, recovery: [] },
  "into R2": { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}], ...joinR3] }], carets: {}, recovery: [] }
};

export const laterFormatOracles: Record<string, ScriptOracle> = {
  "Bob bolded": { rows: [{ id: "R1", characters: [["s1", "a", { b: true }], ["s2", "b", { b: true }], ["s3", "c", { b: true }], ["s4", "d", {}]] }], carets: {}, recovery: [] },
  "Alice undone": { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", { b: true }], ["s3", "c", { b: true }], ["s4", "d", {}]] }], carets: {}, recovery: [] }
};

const chainBase =[["b1", "Q", {}], ["s1", "a", {}], ["s2", "b", {}]] as const;

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

const statusNotices = ["Alice: concurrent status change did not apply", "Bob: concurrent status change did not apply"];

export const statusRedoObserved: Record<string, ScriptOracle> = {
  todo: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "todo" }], carets: {}, recovery: [], notices: statusNotices },
  ready: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "ready" }], carets: {}, recovery: [], notices: statusNotices }
};

export const throwingUndoOracles: Record<string, ScriptOracle> = {
  thrown: { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1", "x", {}]] }], carets: {}, recovery: [] },
  "insert undone": { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] }], carets: {}, recovery: [] }
};

export const redoneMarkOracles: Record<string, ScriptOracle> = {
  tag: { rows: [{ id: "R1", characters: [["s1", "a", { b: true, tag: "P" }], ["s2", "b", { tag: "P" }]] }], carets: {}, recovery: [] },
  comment: { rows: [{ id: "R1", characters: [["s1", "a", { b: true, "c:C1": true }], ["s2", "b", { "c:C1": true }]] }], carets: {}, recovery: [], records: { comments: { C1: { author: "Alice", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: false, replies: [] } }, recoveryReplies: [] } }
};

export const positionControlOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["b1", "Q", {}], ["s1", "a", {}], ["s2", "b", {}]] }], carets: {}, recovery: []
};
