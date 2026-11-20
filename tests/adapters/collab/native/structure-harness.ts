import assert from "node:assert/strict";
import * as Y from "yjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { ValidatedDocument } from "../../../../src/core/document/validated.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeTextRange } from "../../../../src/adapters/collab/native/text-commands.ts";
import { ScriptNet, convertedScript, joinedScript } from "./helpers.ts";
import { testNativeUndo } from "./undo-harness.ts";
import type { TestNativeUndo } from "./undo-harness.ts";

export interface Section { readonly id: string; readonly name: string; readonly before: string }

export function structureScript(rows: Record<string, string>, visuals: Record<string, string> = {}, sections: readonly Section[] = []): ValidatedDocument {
  return migrateRows({
    schema: 2, title: "Structure", docId: "doc-structure", rev: 0,
    rows: Object.entries(rows).map(([id, audioText]) => ({ id, audioText, visualText: visuals[id] ?? "" })),
    ...sections.length ? { sections: sections.map(section => ({ id: section.id, name: section.name, firstSceneId: section.before })) } : {},
    comments: [], people: [], productionTags: [{ id: "t:prop:lamp", cat: "prop", name: "lamp" }], brollShots: []
  });
}

export function undoOf(script: NativeScript): TestNativeUndo { return testNativeUndo(script); }

export interface Copies { readonly net: ScriptNet; readonly all: NativeScript[]; readonly undo: TestNativeUndo[] }

export function copiesOf(source: ValidatedDocument, clients: readonly number[] = [2, 3]): Copies {
  const seed = convertedScript(source, 1), all = clients.map(client => joinedScript(seed, client));
  seed.close();
  return { net: new ScriptNet(all), all, undo: all.map(undoOf) };
}

export function caret(script: NativeScript, beat: string, at: number): NativeTextRange {
  const anchored = anchorNativeText(script, { beat, cell: "narration" }, at);
  assert.equal(anchored.kind, "anchored", `no caret in ${beat} at ${at}`);
  return (anchored as { range: NativeTextRange }).range;
}

export function split(script: NativeScript, beat: string, at: number): string {
  const outcome = splitNativeRow(script, caret(script, beat, at));
  assert.equal(outcome.kind, "written", JSON.stringify(outcome));
  script.reader.refresh();
  return (outcome as { created: string }).created;
}

export function remove(script: NativeScript, ...beats: string[]): void {
  assert.deepEqual(removeNativeRows(script, beats), { kind: "written" });
  script.reader.refresh();
}

export function join(script: NativeScript, beat: string, into: string, glue = " "): void {
  assert.deepEqual(joinNativeRow(script, beat, into, glue), { kind: "written" });
  script.reader.refresh();
}

export function unjoin(script: NativeScript, beat: string): void {
  assert.deepEqual(unjoinNativeRow(script, beat), { kind: "written" });
  script.reader.refresh();
}

export function press(undo: TestNativeUndo, script: NativeScript, redo = false): void {
  assert.ok(redo ? undo.redo() : undo.undo(), redo ? "nothing to redo" : "nothing to undo");
  script.reader.refresh();
}

export function rowsOf(script: NativeScript): string[] {
  return script.reader.rows().map(row => `${row.id}: ${row.narration.map(run => run.atom ? "￼" : run.text).join("")}`);
}

// why: the stored narration in reading order, `[id]` for a beat boundary and `[#id]` for a heading's, so a test sees
// text the reader leaves unplaced and boundaries without a record
export function storedOf(script: NativeScript): string {
  return script.roots.order.toArray().map(key => (nativeSegmentSpans(script.roots.segments.get(key)) ?? []).map(span => {
    const text = span.items.map(item => typeof item.insert === "string" ? item.insert : "￼").join("");
    return span.key === null ? text : `[${span.key.startsWith("h:") ? "#" : ""}${span.key.slice(2)}]${text}`;
  }).join("")).join(" | ");
}

// why: the full update as well as the state vector, since a write that only deletes leaves the vector unchanged
export function stateOf(script: NativeScript): { readonly vector: Uint8Array; readonly update: Uint8Array } {
  return { vector: Y.encodeStateVector(script.doc), update: Y.encodeStateAsUpdate(script.doc) };
}
