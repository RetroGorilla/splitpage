import type { Step } from "../native-chosen/play.ts";
import type { ModelStep } from "./model.ts";

export interface RowHistory { label: string; steps: Step[]; model: ModelStep[] }

const ALICE = 0, BOB = 1;
type Part = { real: Step[]; model: ModelStep[] };
const sync: Part = { real: [{ from: BOB, to: ALICE }, { from: ALICE, to: BOB }], model: [{ from: BOB, to: ALICE }, { from: ALICE, to: BOB }] };
const splitB = (at: "start" | "end"): Part => ({
  real: [{ by: ALICE, cmd: { op: "split", id: "B", at: at === "start" ? 0 : 1, created: "N" } }], model: [{ by: ALICE, op: "split", at }]
});
const cut = (...rows: string[]): Part => ({ real: [{ by: BOB, cmd: { op: "delete", rows } }], model: [{ by: BOB, op: "cut", rows }] });
const press = (by: number, op: "undo" | "redo"): Part => ({ real: [{ by, cmd: { op } }], model: [{ by, op }] });
const history = (label: string, parts: Part[]): RowHistory => ({ label, steps: parts.flatMap(part => part.real), model: parts.flatMap(part => part.model) });

// why: Alice is copy 0 (client 1), Bob copy 1 (client 2); the split runs on `justTwo`, `A: a`, `B: b`
export const BASES: { label: string; parts: Part[] }[] = [
  { label: "four steps, each delivered", parts: [splitB("start"), sync, cut("N"), sync, press(ALICE, "undo"), sync, press(BOB, "undo"), sync] },
  { label: "split at the end", parts: [splitB("end"), sync, cut("N"), sync, press(ALICE, "undo"), sync, press(BOB, "undo"), sync] },
  { label: "Bob cuts A, B and N together", parts: [splitB("start"), sync, cut("A", "B", "N"), sync, press(ALICE, "undo"), sync, press(BOB, "undo"), sync] },
  { label: "Alice undoes before Bob cuts", parts: [splitB("start"), sync, press(ALICE, "undo"), cut("N"), sync, press(BOB, "undo"), sync] },
  { label: "Bob cuts and undoes while Alice undoes, offline", parts: [splitB("start"), sync, cut("N"), press(BOB, "undo"), press(ALICE, "undo"), sync] },
  { label: "the cut delivered, both undo offline", parts: [splitB("start"), sync, cut("N"), sync, press(ALICE, "undo"), press(BOB, "undo"), sync] }
];

export const CONTINUATIONS: { label: string; parts: Part[] }[] = [
  { label: "", parts: [] },
  { label: "Alice redoes, Bob redoes, Alice undoes", parts: [press(ALICE, "redo"), sync, press(BOB, "redo"), sync, press(ALICE, "undo"), sync] },
  { label: "Bob redoes, Alice redoes, Bob undoes", parts: [press(BOB, "redo"), sync, press(ALICE, "redo"), sync, press(BOB, "undo"), sync] }
];

export const ROW_HISTORIES: RowHistory[] = BASES.flatMap(base => CONTINUATIONS.map(more =>
  history(more.label ? `${base.label}; ${more.label}` : base.label, [...base.parts, ...more.parts])));
