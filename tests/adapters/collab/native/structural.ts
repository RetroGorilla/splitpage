import * as Y from "yjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { ValidatedDocument } from "../../../../src/core/document/validated.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { convertedScript } from "./helpers.ts";

export const LARGE_BEATS = 900;

// why: the prototype's cost fixture: 30 beats per segment, a heading at the head of every third segment,
// 120 letters of narration and 48 of visual per beat
export function largeDocument(beats = LARGE_BEATS): ValidatedDocument {
  const rows = Array.from({ length: beats }, (_, index) => ({ id: "B" + index, status: "ready", audioText: "n".repeat(120), visualText: "v".repeat(48) }));
  const sections = rows.filter((_, index) => index % 90 === 0).map(row => ({ id: "H" + row.id.slice(1), name: "Scene " + row.id.slice(1), firstSceneId: row.id }));
  return migrateRows({ schema: 2, title: "Large", docId: "doc-large", rev: 0, rows, sections, comments: [], people: [], productionTags: [], brollShots: [] });
}

export function narrationText(script: NativeScript, beat: string): { readonly text: Y.Text; readonly start: number; readonly end: number } {
  const places = script.reader.narrationSpans(beat), place = places[0], record = place ? script.roots.segments.get(place.segment) : undefined;
  const span = place ? nativeSegmentSpans(record)?.[place.span] : undefined, text = record?.get("text");
  if (places.length !== 1 || !span || !(text instanceof Y.Text)) throw new Error("No single narration span for " + beat);
  return { text, start: span.start, end: span.end };
}

export function largeState(beats = LARGE_BEATS): Uint8Array {
  return Y.encodeStateAsUpdate(convertedScript(largeDocument(beats), 1).doc);
}

export function loadedCopy(state: Uint8Array, clientID: number): NativeScript {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const copy = openNativeScript(doc);
  Y.applyUpdate(doc, state, "remote");
  copy.reader.refresh();
  return copy;
}

// why: slice 3 owns the split command; this writes the shape the design gives a split so a copy can receive one
export function splitUpdate(state: Uint8Array, beat: string, offset: number, id: string): Uint8Array {
  const writer = loadedCopy(state, 77), place = narrationText(writer, beat), outline = writer.reader.outline();
  const at = outline.findIndex(entry => entry.kind === "row" && entry.id === beat), next = outline[at + 1];
  const rankOf = (entryId: string | undefined): string => String(writer.roots.beats.get(entryId ?? "")?.get("rank") ?? writer.roots.headings.get(entryId ?? "")?.get("rank") ?? "");
  const left = rankOf(beat), right = next ? rankOf(next.id) : "";
  if (offset > place.end - place.start || (right && left + "V" >= right)) throw new Error("No place to split " + beat);
  const before = Y.encodeStateVector(writer.doc);
  writer.doc.transact(() => {
    place.text.insertEmbed(place.start + offset, { b: id }, {});
    const record = new Y.Map<unknown>();
    writer.roots.beats.set(id, record);
    record.set("rank", left + "V");
    record.set("status", JSON.stringify("ready"));
    record.set("extra", "{}");
    const visual = new Y.Text();
    writer.roots.visuals.set(id, visual);
  }, writer.origin);
  const update = Y.encodeStateAsUpdate(writer.doc, before);
  writer.reader.close();
  return update;
}
