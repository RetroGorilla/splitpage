import type { Run } from "../../../../src/core/text/runs.ts";
import { scalePerfFixture } from "../perf/fixtures.ts";
import { lifetimePlan } from "../perf/lifetime/workload.ts";
import { projectionReferences } from "../proj/reference.ts";
import { deltaToRuns, htmlToDelta } from "../proj/richtext.ts";
import { copy, records } from "../proj/value.ts";
import type { ProjectionBag } from "../proj/value.ts";
import type { NativeField } from "./variant.ts";

export type TapeOp = { op: "turn"; writer: number } | { op: "splice"; beat: string; field: NativeField; from: number; to: number; insert: Run[] };

export interface TypingTape {
  document: ProjectionBag;
  writers: number;
  ops: TapeOp[];
  typed: number;
  atoms: number;
  corrections: number;
  revisionDeletes: number;
  finalCharacters: number;
}

export function longDemo(): ProjectionBag {
  const source = projectionReferences().find(item => item.name === "src/starters/long-demo.json");
  if (!source || records(source.document.rows).length !== 30) throw new Error("Canonical long demo changed");
  return source.document;
}

export function scaledDemo(copies: number): ProjectionBag {
  return scalePerfFixture(longDemo(), copies);
}

function unitsOf(html: string, source: ProjectionBag): Run[] {
  const result: Run[] = [];
  for (const item of htmlToDelta(html, source.productionTags, source.comments)) {
    if (typeof item.insert !== "string") { result.push(...deltaToRuns([item], source.productionTags, source.comments)); continue; }
    for (const character of Array.from(item.insert)) result.push(...deltaToRuns([{ insert: character, attributes: item.attributes ?? {} }], source.productionTags, source.comments));
  }
  return result;
}

// why: the same counts as the Stage 1 lifetime workload's typing: one correction per 55 typed characters,
// then half of each of the first five beats replaced by the next beat's words
export function typingTape(writers: number, copies = 1): TypingTape {
  const source = scaledDemo(copies), rows = records(source.rows), ops: TapeOp[] = [], lengths = new Map<string, number>();
  const document = { ...copy(source), rows: rows.map(row => ({ ...row, audioText: "", visualText: "" })) };
  let turn = 0, typed = 0, typing = 0, atoms = 0, corrections = 0, final = 0;
  const next = (): void => { ops.push({ op: "turn", writer: turn++ % writers }); };
  for (const row of rows) {
    next();
    for (const field of ["audioText", "visualText"] as const) {
      let index = 0;
      for (const unit of unitsOf(String(row[field] ?? ""), source)) {
        const beat = String(row.id);
        ops.push({ op: "splice", beat, field, from: index, to: index, insert: [unit] });
        index += unit.atom ? 1 : unit.text.length;
        if (unit.atom) { atoms++; continue; }
        typed += unit.text.length; typing++;
        if (Math.floor(typing / lifetimePlan.correctionEvery) > Math.floor((typing - 1) / lifetimePlan.correctionEvery)) {
          ops.push({ op: "splice", beat, field, from: index - unit.text.length, to: index, insert: [] });
          ops.push({ op: "splice", beat, field, from: index - unit.text.length, to: index - unit.text.length, insert: [unit] });
          corrections++; typed += unit.text.length;
        }
      }
      final += index;
      if (field === "audioText") lengths.set(String(row.id), index);
    }
  }
  for (let index = 0; index < lifetimePlan.revisionBeats * copies; index++) {
    const at = Math.floor(index / lifetimePlan.revisionBeats) * 30 + index % lifetimePlan.revisionBeats;
    const row = rows[at], following = rows[at + 1];
    if (!row || !following) throw new Error("Missing revision beat");
    next();
    const beat = String(row.id), length = Math.floor((lengths.get(beat) ?? 0) / lifetimePlan.revisionDivisor);
    const words = htmlToDelta(String(following.audioText), source.productionTags, source.comments).map(item => typeof item.insert === "string" ? item.insert : "").join("");
    const replacement = words.repeat(Math.ceil(length / words.length)).slice(0, length);
    ops.push({ op: "splice", beat, field: "audioText", from: 0, to: length, insert: [] });
    for (let offset = 0; offset < replacement.length; offset++) {
      ops.push({ op: "splice", beat, field: "audioText", from: offset, to: offset, insert: [{ text: replacement.charAt(offset), marks: {} }] });
      typed++;
    }
  }
  return { document, writers, ops, typed, atoms, corrections, revisionDeletes: lifetimePlan.revisionBeats * copies, finalCharacters: final };
}
