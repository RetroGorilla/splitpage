import { identityGet } from "./identity.ts";
import * as Y from "yjs";
import type { CollabCharacter, CollabRow, IdentityBook } from "../model.ts";
import type { SchemaCandidate } from "../schema.ts";
import { readBoundaryRecord, readMarkRecord, readSegmentRecord, readWireValue, rootMap, rootOrder, rootText } from "./records.ts";

export interface ReaderTextSpan { row: CollabRow; text: Y.Text; start: number; end: number }

export function readerCharacters(text: Y.Text, index: number, value: string, marks: unknown, beat: string, book: IdentityBook): CollabCharacter[] {
  value = readWireValue(value) as string;
  const valid = readMarkRecord(marks);
  return Array.from({ length: value.length }, (_, offset) => {
    const id = Y.createRelativePositionFromTypeIndex(text, index + offset, 0).item;
    const identity = id ? { client: id.client, clock: id.clock } : null;
    return { identity, notation: identity ? book.notation(identity) : "[missing]", value: value.charAt(offset), marks: valid, beat };
  });
}

export function readerTextSpans(doc: Y.Doc, candidate: SchemaCandidate, book: IdentityBook): ReaderTextSpan[] {
  const spans: ReaderTextSpan[] = [], seen = new Set<string>();
  const scan = (text: Y.Text, head?: { id: string; kind?: "heading" } | null): void => {
    let current: ReaderTextSpan | undefined, index = 0;
    const begin = (boundary: { id: string; kind?: "heading" } | null, start: number): void => {
      if (!boundary || seen.has(boundary.id)) return;
      if (current) current.end = index;
      seen.add(boundary.id);
      current = { row: { id: boundary.id, characters: [], ...(boundary.kind ? { kind: boundary.kind } : {}) }, text, start, end: text.length };
      spans.push(current);
    };
    if (head) begin(head, 0);
    for (const delta of text.toDelta()) {
      const insert: unknown = delta.insert;
      if (typeof insert === "string") {
        if (current) current.row.characters.push(...readerCharacters(text, index, insert, current.row.kind ? {} : delta.attributes, current.row.id, book));
        index += insert.length;
      } else { begin(readBoundaryRecord(insert), index + 1); index++; }
    }
  };
  if (candidate === "A") { const text = rootText(doc, "flow"); if (text) scan(text); }
  else for (const id of new Set(rootOrder(doc))) {
    const segment = readSegmentRecord(identityGet(rootMap(doc, "segments"), id));
    if (segment) scan(segment.text, segment.head);
  }
  return spans;
}
