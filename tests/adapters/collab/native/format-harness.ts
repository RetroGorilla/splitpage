import * as Y from "yjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import type { NativeMarkChange } from "../../../../src/adapters/collab/native/format-commands.ts";
import type { NativeDeltaItem } from "../../../../src/adapters/collab/native/inline.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { anchorNativeText, replaceNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { convertedScript, shown } from "./helpers.ts";
import { testNativeUndo } from "./undo-harness.ts";
import type { TestNativeUndo } from "./undo-harness.ts";

export interface RaceChar { readonly ch: string; readonly names: readonly string[] }
export type RaceStackItem = TestNativeUndo["undoStack"][number];

const SUFFIX = "\u001f";

// why: written apart from the adapter's reader, after prototypes/collab/src/format-keys/model.ts, so the counts
// do not lean on the code they count
export function visibleName(key: string): string {
  const at = key.indexOf(SUFFIX);
  return at < 0 ? key : key.slice(0, at);
}

export function readCell(delta: readonly NativeDeltaItem[], applications = false): RaceChar[] {
  const result: RaceChar[] = [];
  for (const item of delta) {
    const keys = Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([key]) => visibleName(key));
    const names = (applications ? keys : [...new Set(keys)]).sort();
    if (typeof item.insert === "string") for (const ch of item.insert) result.push({ ch, names });
    else result.push({ ch: "￼", names });
  }
  return result;
}

export function printCell(chars: readonly RaceChar[]): string {
  const parts: { text: string; names: string }[] = [];
  for (const char of chars) {
    const names = char.names.join(","), last = parts.at(-1);
    if (last?.names === names) last.text += char.ch; else parts.push({ text: char.ch, names });
  }
  return parts.map(part => part.names ? `[${part.text}|${part.names}]` : part.text).join("");
}

export function firstDifference(expected: readonly RaceChar[], actual: readonly RaceChar[]): number {
  for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
    const want = expected[index], got = actual[index];
    if (!want || !got || want.ch !== got.ch || want.names.join(",") !== got.names.join(",")) return index;
  }
  return -1;
}

export interface RaceWriter {
  readonly script: NativeScript;
  readonly undo: TestNativeUndo;
}

export function cellOf(writer: RaceWriter, cell: NativeTextTarget): Y.Text {
  const value = cell.cell === "visual" ? writer.script.roots.visuals.get(cell.beat) : writer.script.roots.segments.get("b:" + cell.beat)?.get("text");
  if (!(value instanceof Y.Text)) throw new Error("No cell " + cell.beat);
  return value;
}

export function deltaOf(script: NativeScript, cell: NativeTextTarget): NativeDeltaItem[] {
  if (cell.cell === "visual") return (script.roots.visuals.get(cell.beat)?.toDelta() ?? []) as NativeDeltaItem[];
  return [...nativeSegmentSpans(script.roots.segments.get("b:" + cell.beat))?.[0]?.items ?? []];
}

function writerOf(script: NativeScript): RaceWriter {
  const roots = script.roots;
  // why: an editor binding reads every text change's delta, the condition E4 and E6 measured under
  for (const root of [roots.segments, roots.visuals]) root.observeDeep(events => { for (const event of events) if (event instanceof Y.YTextEvent) void event.delta; });
  return { script, undo: testNativeUndo(script) };
}

export function joined(state: Uint8Array, client: number): RaceWriter {
  const doc = new Y.Doc();
  doc.clientID = client;
  const script = openNativeScript(doc);
  Y.applyUpdate(doc, state, "remote");
  script.reader.refresh();
  return writerOf(script);
}

// why: as in E4 and E6, writers edit their own copies and a stored copy receives every update, as a server does
export class RaceWorld {
  readonly server = new Y.Doc();
  readonly writers: RaceWriter[];

  constructor(rows: Record<string, { audioText: string; visualText: string }>, clients: readonly number[], seedClient = 900, seed?: (fixture: RaceWriter) => void) {
    const fixture = writerOf(convertedScript(migrateRows({
      schema: 2, title: "Races", docId: "doc-races", rev: 0, rows: Object.entries(rows).map(([id, cells]) => ({ id, ...cells })),
      comments: [], people: [], productionTags: [], brollShots: []
    }), seedClient));
    seed?.(fixture);
    Y.applyUpdate(this.server, Y.encodeStateAsUpdate(fixture.script.doc), "remote");
    fixture.undo.destroy();
    fixture.script.close();
    this.writers = clients.map(client => {
      const writer = joined(Y.encodeStateAsUpdate(this.server), client);
      writer.script.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") Y.applyUpdate(this.server, update, "remote"); });
      return writer;
    });
  }

  pull(writer: RaceWriter): void {
    Y.applyUpdate(writer.script.doc, Y.encodeStateAsUpdate(this.server, Y.encodeStateVector(writer.script.doc)), "remote");
    writer.script.reader.refresh();
  }

  pullAll(): void { for (const writer of this.writers) this.pull(writer); }

  // why: a late joiner loads one writer's saved state; its stored cells and its reading must match the writer's
  lateAgrees(writer: RaceWriter, cells: readonly NativeTextTarget[]): boolean {
    const late = joined(Y.encodeStateAsUpdate(writer.script.doc), 901);
    try {
      return cells.every(cell => JSON.stringify(deltaOf(late.script, cell)) === JSON.stringify(deltaOf(writer.script, cell)))
        && JSON.stringify(shown(late.script)) === JSON.stringify(shown(writer.script));
    } finally { late.undo.destroy(); late.script.close(); }
  }

  close(): void { for (const writer of this.writers) { writer.undo.destroy(); writer.script.close(); } }
}

function anchored(writer: RaceWriter, cell: NativeTextTarget, from: number, to: number) {
  const result = anchorNativeText(writer.script, cell, from, to);
  if (result.kind !== "anchored") throw new Error("Could not anchor: " + result.reason);
  return result.range;
}

export function formatRange(writer: RaceWriter, cell: NativeTextTarget, from: number, to: number, change: NativeMarkChange): string {
  return formatNativeText(writer.script, anchored(writer, cell, from, to), change).kind;
}

export function typeAt(writer: RaceWriter, cell: NativeTextTarget, at: number, text: string): string {
  return replaceNativeText(writer.script, anchored(writer, cell, at, at), [{ text, marks: {} }]).kind;
}

export function deleteRange(writer: RaceWriter, cell: NativeTextTarget, from: number, to: number): string {
  return replaceNativeText(writer.script, anchored(writer, cell, from, to), []).kind;
}

export function countUpdates(writer: RaceWriter, act: () => void): number {
  let updates = 0;
  const count = (): void => { updates++; };
  writer.script.doc.on("update", count);
  try { act(); } finally { writer.script.doc.off("update", count); }
  writer.script.reader.refresh();
  return updates;
}
