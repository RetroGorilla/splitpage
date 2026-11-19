import type { DocumentShape } from "../../../../src/core/document/validated.ts";
import { orderedMarks } from "../../../../src/core/text/runs.ts";
import type { Run } from "../../../../src/core/text/runs.ts";
import type { NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { cells, fixture } from "./helpers.ts";

export type TapeOp = { readonly op: "turn"; readonly writer: number } | { readonly op: "splice"; readonly target: NativeTextTarget; readonly from: number; readonly to: number; readonly insert: readonly Run[] };

export interface TypingTape {
  readonly document: DocumentShape;
  readonly source: DocumentShape;
  readonly ops: readonly TapeOp[];
  readonly typed: number;
  readonly atoms: number;
  readonly corrections: number;
  readonly revised: readonly string[];
}

const CORRECTION_EVERY = 55, REVISION_BEATS = 5, REVISION_DIVISOR = 2;

export function unitsOf(runs: readonly Run[]): Run[] {
  return runs.flatMap(run => run.atom ? [run] : Array.from(run.text, text => ({ text, marks: run.marks })));
}

export function unitLength(unit: Run): number {
  return unit.atom ? 1 : unit.text.length;
}

export function unitKeys(runs: readonly Run[]): string[] {
  return unitsOf(runs).map(unit => JSON.stringify(unit.atom ? { ...unit, marks: orderedMarks(unit.marks) } : [unit.text, orderedMarks(unit.marks)]));
}

export function spliceUnits(units: Run[], from: number, to: number, insert: readonly Run[]): void {
  let offset = 0, start = -1, end = -1;
  for (let index = 0; index <= units.length; index++) {
    if (offset === from && start < 0) start = index;
    if (offset === to) { end = index; break; }
    offset += units[index] ? unitLength(units[index] as Run) : 0;
  }
  if (start < 0 || end < start) throw new Error(`The model has no range ${from}..${to}`);
  units.splice(start, end - start, ...unitsOf(insert));
}

// why: the counts of prototypes/collab/src/native/tape.ts: one correction per 55 typed characters,
// then half of each of the first five beats replaced by the next beat's words
export function typingTape(writers: number): TypingTape {
  const source = fixture("src/starters/long-demo.json"), ops: TapeOp[] = [], lengths = new Map<string, number>();
  const document = { ...structuredClone(source), rows: source.rows.map(row => ({ ...structuredClone(row), audioText: "", visualText: "" })) };
  let turn = 0, typed = 0, typing = 0, atoms = 0, corrections = 0;
  const next = (): void => { ops.push({ op: "turn", writer: turn++ % writers }); };
  for (const row of source.rows) {
    next();
    for (const [field, cell] of [["audioText", "narration"], ["visualText", "visual"]] as const) {
      const target = { beat: row.id, cell };
      let index = 0;
      for (const unit of unitsOf(cells(String(row[field] ?? "")))) {
        ops.push({ op: "splice", target, from: index, to: index, insert: [unit] });
        index += unitLength(unit);
        if (unit.atom) { atoms++; continue; }
        typed += unit.text.length; typing++;
        if (typing % CORRECTION_EVERY === 0) {
          ops.push({ op: "splice", target, from: index - unit.text.length, to: index, insert: [] });
          ops.push({ op: "splice", target, from: index - unit.text.length, to: index - unit.text.length, insert: [unit] });
          corrections++; typed += unit.text.length;
        }
      }
      if (cell === "narration") lengths.set(row.id, index);
    }
  }
  const revised: string[] = [];
  for (let index = 0; index < REVISION_BEATS; index++) {
    const row = source.rows[index], following = source.rows[index + 1];
    if (!row || !following) throw new Error("Missing revision beat");
    next();
    const target = { beat: row.id, cell: "narration" as const }, length = Math.floor((lengths.get(row.id) ?? 0) / REVISION_DIVISOR);
    const words = cells(String(following.audioText)).map(run => run.atom ? "" : run.text).join("");
    const replacement = Array.from(words.repeat(Math.ceil(length / words.length))).slice(0, length);
    ops.push({ op: "splice", target, from: 0, to: length, insert: [] });
    let at = 0;
    for (const text of replacement) {
      ops.push({ op: "splice", target, from: at, to: at, insert: [{ text, marks: {} }] });
      at += text.length; typed += text.length;
    }
    revised.push(row.id);
  }
  return { document, source, ops, typed, atoms, corrections, revised };
}
