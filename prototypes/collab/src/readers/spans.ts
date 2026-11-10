import { assembleReaderBlocks, readerBlockDelta, readerBlockStreams } from "./blocks.ts";
import * as Y from "yjs";
import type { CollabCharacter, CollabRow, IdentityBook } from "../model.ts";
import type { SchemaCandidate } from "../schema.ts";
import { readMarkRecord, readWireValue } from "./records.ts";

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
  return assembleReaderBlocks(readerBlockStreams(doc, candidate, readerBlockDelta)).map(span => {
    const row: CollabRow = { id: span.block.id, characters: [] };
    if (span.block.kind === "h") row.kind = "heading";
    for (const part of span.parts) if (typeof part.delta.insert === "string") row.characters.push(...readerCharacters(span.text, part.index, part.delta.insert, row.kind ? {} : part.delta.attributes, row.id, book));
    return { row, text: span.text, start: span.start, end: span.end };
  });
}
