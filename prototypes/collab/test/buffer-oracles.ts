import type { DeliveryOrder } from "../src/delivery.ts";
import type { ScriptOracle } from "../src/model.ts";
import type { SeedBeat } from "../src/schema.ts";

export const bufferTraceOrder = ["T04", "T04 removed", "T01", "T01 composition", "T02", "T02 boundary", "T03", "T03 replace"] as const;
export type BufferTrace = typeof bufferTraceOrder[number];

export interface BufferTraceOracle {
  seed: SeedBeat[];
  beat: string;
  from: number;
  to: number;
  orders: DeliveryOrder[];
  expected: ScriptOracle;
  undo: ScriptOracle;
}

export const bufferOracles: Record<BufferTrace, BufferTraceOracle> = {
  T04: {
    seed: [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], beat: "R1", from: 2, to: 2,
    orders: ["D3", "dup", "late-C"],
    expected: {
      rows: [
        { id: "R1", characters: [["b1", "Z", {}], ["s1", "a", {}], ["s2", "b", {}], ["a1", "x", {}], ["a2", "y", {}], ["s3", "c", {}]] },
        { id: "R2", characters: [["s5", "e", {}], ["s6", "f", {}]] }
      ], carets: { A: { beat: "R1", offset: 5 } }, recovery: []
    },
    undo: {
      rows: [
        { id: "R1", characters: [["b1", "Z", {}], ["s1", "a", {}], ["s2", "b", {}], ["s3", "c", {}]] },
        { id: "R2", characters: [["s5", "e", {}], ["s6", "f", {}]] }
      ], carets: { A: { beat: "R1", offset: 3 } }, recovery: []
    }
  },
  "T04 removed": {
    seed: [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], beat: "R1", from: 2, to: 2,
    orders: ["D3", "late-C"],
    expected: {
      rows: [{ id: "R2", characters: [["s5", "e", {}], ["s6", "f", {}]] }],
      carets: { A: { beat: "R2", offset: 0 } },
      recovery: [{ row: { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1", "x", {}], ["a2", "y", {}], ["s3", "c", {}], ["s4", "d", {}]] }, by: "Bob", edited: ["a1", "a2"] }]
    },
    undo: {
      rows: [{ id: "R2", characters: [["s5", "e", {}], ["s6", "f", {}]] }],
      carets: { A: { beat: "R2", offset: 0 } },
      recovery: [{ row: { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["s3", "c", {}], ["s4", "d", {}]] }, by: "Bob", edited: [] }]
    }
  },
  T01: {
    seed: [{ id: "R1", text: "abcd" }], beat: "R1", from: 1, to: 3,
    orders: ["D1", "D3", "dup", "rev", "late-C"],
    expected: {
      rows: [{ id: "R1", characters: [["s1", "a", {}], ["b1", "X", {}], ["s4", "d", {}]] }],
      carets: { A: { beat: "R1", offset: 1 } }, recovery: []
    },
    undo: {
      rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2*", "b", {}], ["b1", "X", {}], ["s3*", "c", {}], ["s4", "d", {}]] }],
      carets: { A: { beat: "R1", offset: 1, selection: { beat: "R1", from: 1, to: 4 } } }, recovery: []
    }
  },
  "T01 composition": {
    seed: [{ id: "R1", text: "abcd" }], beat: "R1", from: 1, to: 3,
    orders: ["D1", "D3", "dup", "rev", "late-C"],
    expected: {
      rows: [{ id: "R1", characters: [["s1", "a", {}], ["a1", "β", {}], ["b1", "X", {}], ["s4", "d", {}]] }],
      carets: { A: { beat: "R1", offset: 2 } }, recovery: []
    },
    undo: {
      rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2*", "b", {}], ["b1", "X", {}], ["s3*", "c", {}], ["s4", "d", {}]] }],
      carets: { A: { beat: "R1", offset: 1, selection: { beat: "R1", from: 1, to: 4 } } }, recovery: []
    }
  },
  T02: {
    seed: [{ id: "R1", text: "ab" }], beat: "R1", from: 2, to: 2,
    orders: ["D3", "dup", "late-C"],
    expected: {
      rows: [{ id: "R1", characters: [["b1", "X", {}], ["s1", "a", {}], ["s2", "b", {}], ["a1", "c", {}]] }],
      carets: { A: { beat: "R1", offset: 4 } }, recovery: []
    },
    undo: {
      rows: [{ id: "R1", characters: [["b1", "X", {}], ["s1", "a", {}], ["s2", "b", {}]] }],
      carets: { A: { beat: "R1", offset: 3 } }, recovery: []
    }
  },
  "T02 boundary": {
    seed: [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }], beat: "R2", from: 0, to: 0,
    orders: ["D3"],
    expected: {
      rows: [
        { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "Y", {}]] },
        { id: "R2", characters: [["a1", "Z", {}], ["s3", "c", {}], ["s4", "d", {}]] }
      ], carets: { A: { beat: "R2", offset: 1 } }, recovery: []
    },
    undo: {
      rows: [
        { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "Y", {}]] },
        { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]] }
      ], carets: { A: { beat: "R2", offset: 0 } }, recovery: []
    }
  },
  T03: {
    seed: [{ id: "R1", text: "the the" }], beat: "R1", from: 7, to: 7,
    orders: ["D1", "D3"],
    expected: {
      rows: [{ id: "R1", characters: [["s1", "t", { b: true }], ["s2", "h", { b: true }], ["s3", "e", { b: true }]] }],
      carets: { A: { beat: "R1", offset: 3 } }, recovery: []
    },
    undo: {
      rows: [{ id: "R1", characters: [["s1", "t", { b: true }], ["s2", "h", { b: true }], ["s3", "e", { b: true }], ["s4*", " ", {}], ["s5*", "t", {}], ["s6*", "h", {}], ["s7*", "e", {}]] }],
      carets: { A: { beat: "R1", offset: 7 } }, recovery: []
    }
  },
  "T03 replace": {
    seed: [{ id: "R1", text: "the the" }], beat: "R1", from: 4, to: 7,
    orders: ["D1", "D3", "dup"],
    expected: {
      rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["a1", "a", {}], ["b1", "n", {}]] }],
      carets: { A: { beat: "R1", offset: 5 } }, recovery: []
    },
    undo: {
      rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5*", "t", {}], ["s6*", "h", {}], ["s7*", "e", {}], ["b1", "n", {}]] }],
      carets: { A: { beat: "R1", offset: 4, selection: { beat: "R1", from: 4, to: 7 } } }, recovery: []
    }
  }
};
