import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import type { Run } from "../../../../src/core/text/runs.ts";
import { NativeReplica, nativeRuns } from "../native/variant.ts";
import type { NativeDeltaItem, NativeDocumentSource, NativeField } from "../native/variant.ts";
import { baseScheme, countKeys, makeReplica, quantile } from "./keys.ts";
import type { KeyScheme } from "./keys.ts";
import { ATOM, FormatModel, firstDifference, marksOfNames, namesOfMarks, printCell, readCell } from "./model.ts";
import type { ModelChar } from "./model.ts";

export interface PasteRun { text: string; names: string[] }
export type Command =
  | { op: "type"; beat: string; field: NativeField; at: number; text: string; names?: string[] }
  | { op: "splice"; beat: string; field: NativeField; from: number; to: number; insert: Run[] }
  | { op: "delete"; beat: string; field: NativeField; from: number; to: number }
  | { op: "format"; beat: string; field: NativeField; from: number; to: number; name: string; on: boolean }
  | { op: "paste"; beat: string; field: NativeField; at: number; runs: PasteRun[] }
  | { op: "undo" };

export interface Mismatch { copy: string; cell: string; index: number; expected: string; actual: string }
export interface Snapshot {
  characters: number; formattedCharacters: number; keysMedian: number; keysP95: number; keysMax: number; mostOfOneKind: number;
  bytes: number; readMs: number; busiestCell: string; busiestKeys: number;
}

export class CheckFailure extends Error {
  readonly mismatch: Mismatch;
  constructor(mismatch: Mismatch) { super(`${mismatch.copy} ${mismatch.cell}: expected ${mismatch.expected}, shows ${mismatch.actual}`); this.mismatch = mismatch; }
}

export const cellKey =(beat: string, field: NativeField): string => `${beat}/${field}`;

export function deltaOf(replica: NativeReplica, beat: string, field: NativeField): NativeDeltaItem[] {
  if (field === "visualText") return (replica.visuals.get(beat)?.toDelta() ?? []) as NativeDeltaItem[];
  return replica.block(beat).delta;
}

// why: writers edit their own copies; the stored copy receives every update and keeps no undo history, as a server does
export class World {
  readonly writers: NativeReplica[];
  readonly server = new Y.Doc();
  readonly model = new FormatModel();
  readonly beats: string[];
  readonly scheme: KeyScheme;
  formatting = 0;
  private readonly undoable: boolean[];

  constructor(document: NativeDocumentSource, scheme: KeyScheme, writers: number) {
    this.scheme = scheme;
    const seed = new NativeReplica(900, 0, baseScheme(scheme));
    seed.hydrate(document);
    const state = seed.encode();
    Y.applyUpdate(this.server, state);
    seed.destroy();
    // why: the model starts from the source, never from what the variant shows, so only plain starting text is accepted
    const rows = (Array.isArray(document.rows) ? document.rows : []) as Record<string, unknown>[];
    this.beats = rows.map(row => String(row.id));
    for (const row of rows) for (const field of ["audioText", "visualText"] as const) {
      const text = String(row[field] ?? "");
      if (/[<&]/.test(text)) throw new Error("The model takes plain starting text only");
      this.model.insert(cellKey(String(row.id), field), 0, [...text].map(ch => ({ ch, names: [] })));
    }
    this.writers = Array.from({ length: writers }, (_, index) => {
      const replica = makeReplica(scheme, index + 1);
      Y.applyUpdate(replica.doc, state, "remote");
      replica.changes();
      replica.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") Y.applyUpdate(this.server, update, "remote"); });
      return replica;
    });
    this.undoable = this.writers.map(() => false);
  }

  pull(writer: number): void {
    const replica = this.writers[writer] as NativeReplica;
    Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(this.server, Y.encodeStateVector(replica.doc)), "remote");
    replica.changes();
  }

  pullAll(): void { this.writers.forEach((_, index) => this.pull(index)); }

  length(beat: string, field: NativeField): number { return this.model.cell(cellKey(beat, field)).length; }

  run(writer: number, command: Command): void {
    const replica = this.writers[writer] as NativeReplica;
    if (command.op === "undo") {
      if (!this.undoable[writer]) throw new Error("An undo must follow the writer's own format or paste");
      if (replica.undo.undo() === null) throw new Error("Undo found nothing");
      this.model.undo(writer);
      this.undoable[writer] = false;
      replica.changes();
      return;
    }
    const key = cellKey(command.beat, command.field), cell = replica.cell(command.beat, command.field), length = this.model.cell(key).length;
    if (cell.end - cell.start !== length) {
      throw new CheckFailure({ copy: `writer ${writer + 1}`, cell: key, index: -1, expected: `${length} characters`, actual: `${cell.end - cell.start} characters` });
    }
    this.undoable[writer] = command.op === "format" || command.op === "paste";
    if (command.op === "type") {
      for (const [offset, ch] of [...command.text].entries()) {
        const at = command.at + offset, names = command.names ?? [...this.model.left(key, at)];
        replica.splice(command.beat, command.field, at, at, [{ text: ch, marks: marksOfNames(names) }]);
        this.model.insert(key, at, [{ ch, names }]);
        replica.changes();
      }
      return;
    }
    if (command.op === "splice") {
      replica.splice(command.beat, command.field, command.from, command.to, command.insert);
      this.model.remove(key, command.from, command.to);
      this.model.insert(key, command.from, command.insert.flatMap((run): ModelChar[] => run.atom
        ? [{ ch: ATOM, names: namesOfMarks(run.marks) }] : [...run.text].map(ch => ({ ch, names: namesOfMarks(run.marks) }))));
    } else if (command.op === "delete") {
      replica.splice(command.beat, command.field, command.from, command.to, []);
      this.model.remove(key, command.from, command.to);
    } else if (command.op === "format") {
      if (command.to <= command.from || command.to > length) throw new Error(`Empty or outside range ${command.from}..${command.to}`);
      this.model.save(writer, key);
      replica.format(command.beat, command.field, command.from, command.to, { [command.name]: command.on ? true : null });
      this.model.set(key, command.from, command.to, command.name, command.on);
      this.formatting++;
    } else {
      this.model.save(writer, key);
      replica.splice(command.beat, command.field, command.at, command.at, command.runs.map(run => ({ text: run.text, marks: marksOfNames(run.names) })));
      this.model.insert(key, command.at, command.runs.flatMap(run => [...run.text].map(ch => ({ ch, names: run.names }))));
      this.formatting++;
    }
    replica.changes();
  }

  reader(): NativeReplica {
    const replica = new NativeReplica(777, 0, baseScheme(this.scheme));
    replica.undo.destroy();
    Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(this.server), "remote");
    replica.changes();
    return replica;
  }

  // why: every copy and a copy loaded from the stored state must show what the model says, character by character
  check(limit = 5): Mismatch[] {
    const found: Mismatch[] = [], reader = this.reader();
    const copies: [string, NativeReplica][] = [...this.writers.map((replica, index): [string, NativeReplica] => [`writer ${index + 1}`, replica]), ["stored", reader]];
    for (const [name, replica] of copies) for (const beat of this.beats) for (const field of ["audioText", "visualText"] as const) {
      const expected = this.model.cell(cellKey(beat, field)), actual = readCell(deltaOf(replica, beat, field)), index = firstDifference(expected, actual);
      if (index >= 0 && found.length < limit) found.push({ copy: name, cell: cellKey(beat, field), index, expected: printCell(expected.slice(Math.max(0, index - 3), index + 4)), actual: printCell(actual.slice(Math.max(0, index - 3), index + 4)) });
    }
    reader.destroy();
    return found;
  }

  bytes(): number { return Y.encodeStateAsUpdate(this.server).length; }

  snapshot(): Snapshot {
    const reader = this.reader(), counts: number[] = [];
    let mostOfOneKind = 0, busiest = { cell: "", keys: -1, text: null as Y.Text | null };
    for (const beat of this.beats) for (const field of ["audioText", "visualText"] as const) {
      const count = countKeys(deltaOf(reader, beat, field));
      for (const keys of count.perCharacter) counts.push(keys);
      mostOfOneKind = Math.max(mostOfOneKind, count.mostOfOneKind);
      if (count.total > busiest.keys) busiest = { cell: cellKey(beat, field), keys: count.total, text: reader.cell(beat, field).text };
    }
    const formatted = counts.filter(count => count > 0), samples: number[] = [];
    for (let round = 0; round < 21; round++) {
      const started = performance.now();
      nativeRuns(busiest.text?.toDelta() as NativeDeltaItem[] ?? []);
      samples.push(performance.now() - started);
    }
    reader.destroy();
    return { characters: counts.length, formattedCharacters: formatted.length, keysMedian: quantile(formatted, 0.5), keysP95: quantile(formatted, 0.95),
      keysMax: formatted.reduce((most, count) => Math.max(most, count), 0), mostOfOneKind, bytes: this.bytes(), readMs: Math.round(quantile(samples, 0.5) * 10000) / 10000, busiestCell: busiest.cell, busiestKeys: busiest.keys };
  }

  destroy(): void { for (const replica of this.writers) replica.destroy(); this.server.destroy(); }
}

export function pasteRuns(chars: readonly ModelChar[]): PasteRun[] {
  const runs: PasteRun[] = [];
  for (const char of chars) {
    if (char.ch === ATOM) continue;
    const last = runs.at(-1);
    if (last && last.names.join(",") === char.names.join(",")) last.text += char.ch; else runs.push({ text: char.ch, names: [...char.names] });
  }
  return runs;
}
