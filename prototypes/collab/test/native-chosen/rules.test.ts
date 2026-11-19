import assert from "node:assert/strict";
import test from "node:test";
import { ALL_RULES, NO_RULES } from "../../src/native/variant.ts";
import type { NativeRule } from "../../src/native/variant.ts";
import { b, base, h, lines, load, outline, seed, storedOf } from "./kit.ts";
import { ruleView } from "./model.ts";
import type { Spec } from "./kit.ts";

export interface RuleCase { name: string; rule: NativeRule; spec: () => Spec; rows: string[]; prepare?: (bytes: Uint8Array) => Uint8Array }

const UNTOUCHED_TAIL = ["D: jkl / 4", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"];

// why: every expected outline below is written by hand from the stored state and the rule's wording
export const RULE_CASES: RuleCase[] = [
  {
    name: "a: text before the first boundary goes to that segment's first beat",
    rule: "prefix",
    spec: () => { const spec = base(); spec.segments.S = { units: ["Ω", b("B"), "def", b("C"), "ghi"] }; delete spec.beats.A; delete spec.visuals.A; return spec; },
    rows: ["B: Ωdef / 2", "C: ghi / 3", ...UNTOUCHED_TAIL]
  },
  {
    name: "a: a heading between the stray text and the first beat",
    rule: "prefix",
    spec: () => { const spec = base(); spec.segments.T = { units: ["Ω", h("H"), "mno", b("E"), "pqr"] }; delete spec.beats.D; delete spec.visuals.D; return spec; },
    rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "#H mno", "E: Ωpqr / 5", "#I stu", "F: vwx / 6"]
  },
  {
    name: "a: a segment with no beat gives its text to the row above",
    rule: "prefix",
    spec: () => { const spec = base(); spec.segments.V = { units: ["Ω"] }; delete spec.beats.F; delete spec.visuals.F; return spec; },
    rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqrΩ / 5", "#I stu"]
  },
  {
    name: "a: the first segment has no beat and nothing above it",
    rule: "prefix",
    spec: () => {
      const spec = base(); spec.segments.S = { units: ["Ω"] };
      delete spec.beats.A; delete spec.beats.B; delete spec.beats.C;
      delete spec.visuals.A; delete spec.visuals.B; delete spec.visuals.C;
      return spec;
    },
    rows: ["D: Ωjkl / 4", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"]
  },
  {
    name: "b: an empty script shows its stray letters as a narration-only row",
    rule: "empty",
    spec: () => ({ order: ["S"], segments: { S: { units: ["Ωψ"] } }, beats: {}, visuals: {}, headings: {} }),
    rows: ["~stray: Ωψ / "]
  },
  {
    name: "b: the narration-only row sits above the headings",
    rule: "empty",
    spec: () => ({ order: ["U", "S"], segments: { U: { head: h("I"), units: ["stu"] }, S: { units: ["Ω"] } }, beats: {}, visuals: {}, headings: { I: {} } }),
    rows: ["~stray: Ω / ", "#I stu"]
  },
  {
    name: "c: a repeated boundary is ignored and the narration shows twice",
    rule: "repeat",
    spec: () => { const spec = base(); spec.segments.S = { head: b("A"), units: ["abc", b("B"), b("B"), "defdef", b("C"), "ghi"] }; return spec; },
    rows: ["A: abc / 1", "B: defdef / 2", "C: ghi / 3", ...UNTOUCHED_TAIL]
  },
  {
    name: "c: text between two copies of one boundary stays in that beat",
    rule: "repeat",
    spec: () => { const spec = base(); spec.segments.S = { head: b("A"), units: ["abc", b("B"), "de", b("B"), "f", b("C"), "ghi"] }; return spec; },
    rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", ...UNTOUCHED_TAIL]
  },
  {
    name: "d: a join naming a beat that is not directly above shows as its own row",
    rule: "adjacent",
    spec: () => { const spec = base(); spec.beats.C = { joined: { into: "A", glue: " " } }; return spec; },
    rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", ...UNTOUCHED_TAIL]
  },
  {
    name: "d: a join naming a deleted beat shows as its own row",
    rule: "adjacent",
    spec: () => {
      const spec = base(); spec.segments.S = { head: b("A"), units: ["abc", b("C"), "ghi"] };
      delete spec.beats.B; delete spec.visuals.B; spec.beats.C = { joined: { into: "B", glue: " " } };
      return spec;
    },
    rows: ["A: abc / 1", "C: ghi / 3", ...UNTOUCHED_TAIL]
  }
];

const JOINED: string[] = ["A: abc / 1", "B(B+C): def ghi / 2\n3", ...UNTOUCHED_TAIL];

test("E11 rules: each stored state shows the hand-written rows on three copies and a late joiner", () => {
  for (const item of RULE_CASES) {
    const bytes = seed(item.spec()), copies = [1, 2, 3, 44].map(client => load(bytes, client));
    try {
      for (const copy of copies) assert.deepEqual(outline(copy), item.rows, item.name);
      assert.ok(copies[0]?.ruleUse()[item.rule], `${item.name}: the rule was used`);
    } finally { for (const copy of copies) copy.destroy(); }
  }
});

test("E11 rules: the plain model reads the same hand-written rows", () => {
  for (const item of RULE_CASES) assert.deepEqual(lines(ruleView(storedOf(item.spec()))), item.rows, item.name);
  const joined = base(); joined.beats.C = { joined: { into: "B", glue: " " } };
  assert.deepEqual(lines(ruleView(storedOf(joined))), JOINED);
});

test("E11 rules: a join naming the beat directly above still counts", () => {
  const spec = base(); spec.beats.C = { joined: { into: "B", glue: " " } };
  const replica = load(seed(spec), 1);
  try { assert.deepEqual(outline(replica), JOINED); assert.equal(replica.ruleUse().adjacent, 0); } finally { replica.destroy(); }
});

test("E11 rules: switching one rule off breaks exactly the states that need it", () => {
  for (const item of RULE_CASES) {
    const replica = load(seed(item.spec(), ALL_RULES), 1, { ...ALL_RULES, [item.rule]: false });
    try { assert.notDeepEqual(outline(replica), item.rows, `${item.name} without rule ${item.rule}`); } finally { replica.destroy(); }
  }
  const none = load(seed(base(), NO_RULES), 1, NO_RULES);
  try { assert.deepEqual(outline(none), ["A: abc / 1", "B: def / 2", "C: ghi / 3", ...UNTOUCHED_TAIL]); } finally { none.destroy(); }
});
