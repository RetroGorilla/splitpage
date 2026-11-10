import type { DeliveryOrder } from "../src/delivery.ts";
import type { ScriptOracle } from "../src/model.ts";

export interface ReplacementIntentFixture {
  name: string;
  data: string;
  names: string[];
  remote: number | null;
  orders: DeliveryOrder[];
  expected: ScriptOracle;
  undo: ScriptOracle;
}

const identical: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["a1", "t", {}], ["a2", "h", {}], ["a3", "e", {}]] }],
  carets: { A: { beat: "R1", offset: 7 } }, recovery: []
};
const restored: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5*", "t", {}], ["s6*", "h", {}], ["s7*", "e", {}]] }],
  carets: { A: { beat: "R1", offset: 4, selection: { beat: "R1", from: 4, to: 7 } } }, recovery: []
};
const concurrent: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["a1", "t", {}], ["a2", "h", {}], ["a3", "e", {}], ["b1", "n", {}]] }],
  carets: { A: { beat: "R1", offset: 7 } }, recovery: []
};

export const replacementIntentFixtures: ReplacementIntentFixture[] = [
  { name: "typed identical text", data: "the", names: ["a1", "a2", "a3"], remote: null, orders: ["D1"], expected: identical, undo: restored },
  { name: "pasted identical text", data: "the", names: ["a1", "a2", "a3"], remote: null, orders: ["D1"], expected: identical, undo: restored },
  {
    name: "replacement sharing a prefix", data: "then", names: ["a1", "a2", "a3", "a4"], remote: null, orders: ["D1"],
    expected: {
      rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["a1", "t", {}], ["a2", "h", {}], ["a3", "e", {}], ["a4", "n", {}]] }],
      carets: { A: { beat: "R1", offset: 8 } }, recovery: []
    }, undo: restored
  },
  {
    name: "replacement sharing a suffix", data: "she", names: ["a1", "a2", "a3"], remote: null, orders: ["D1"],
    expected: {
      rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["a1", "s", {}], ["a2", "h", {}], ["a3", "e", {}]] }],
      carets: { A: { beat: "R1", offset: 7 } }, recovery: []
    }, undo: restored
  },
  {
    name: "identical replacement with remote at left gap", data: "the", names: ["a1", "a2", "a3"], remote: 4, orders: ["D1", "D3", "dup"], expected: concurrent,
    undo: {
      rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["b1", "n", {}], ["s5*", "t", {}], ["s6*", "h", {}], ["s7*", "e", {}]] }],
      carets: { A: { beat: "R1", offset: 5, selection: { beat: "R1", from: 5, to: 8 } } }, recovery: []
    }
  },
  {
    name: "identical replacement with remote inside word", data: "the", names: ["a1", "a2", "a3"], remote: 5, orders: ["D1", "D3", "dup"], expected: concurrent,
    undo: {
      rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5*", "t", {}], ["b1", "n", {}], ["s6*", "h", {}], ["s7*", "e", {}]] }],
      carets: { A: { beat: "R1", offset: 4, selection: { beat: "R1", from: 4, to: 8 } } }, recovery: []
    }
  },
  {
    name: "identical replacement with remote at right gap", data: "the", names: ["a1", "a2", "a3"], remote: 7, orders: ["D1", "D3", "dup"], expected: concurrent,
    undo: {
      rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5*", "t", {}], ["s6*", "h", {}], ["s7*", "e", {}], ["b1", "n", {}]] }],
      carets: { A: { beat: "R1", offset: 4, selection: { beat: "R1", from: 4, to: 7 } } }, recovery: []
    }
  }
];

