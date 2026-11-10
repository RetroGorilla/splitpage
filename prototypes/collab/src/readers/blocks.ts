import type * as Y from "yjs";
import type { SchemaCandidate } from "../schema.ts";
import type { ProjectionBlock } from "../proj/document.ts";
import type { ProjectionDelta } from "../proj/richtext.ts";
import { compactDelta, deltaLength } from "../perf/delta.ts";
import { identityGet } from "./identity.ts";
import { readBoundaryRecord, readContentAtom, readMarkRecord, readSegmentRecord, readWireValue, rootMap, rootOrder, rootText } from "./records.ts";

export interface ReaderBlockStream { text: Y.Text; head: unknown; delta: readonly ProjectionDelta[] }
export interface ReaderBlockSpan { block: ProjectionBlock; text: Y.Text; start: number; end: number; parts: { index: number; delta: ProjectionDelta }[] }
export interface ReaderBlockCache { head: string; spans: ReaderBlockSpan[]; blocked: string[] }

export function readerBlockStreams(doc: Y.Doc, candidate: SchemaCandidate, read: (text: Y.Text) => readonly ProjectionDelta[]): ReaderBlockStream[] {
  if (candidate === "A") { const text = rootText(doc, "flow"); return text ? [{ text, head: null, delta: read(text) }] : []; }
  return [...new Set(rootOrder(doc))].flatMap(id => {
    const segment = readSegmentRecord(identityGet(rootMap(doc, "segments"), id));
    return segment ? [{ text: segment.text, head: segment.head ? { [segment.head.kind ? "h" : "b"]: segment.head.id } : null, delta: read(segment.text) }] : [];
  });
}

export function readerBlockDelta(text: Y.Text): ProjectionDelta[] {
  return compactDelta((text.toDelta() as { insert: unknown; attributes?: unknown }[]).map(item => ({
    insert: typeof item.insert === "string" ? readWireValue(item.insert) as string : readContentAtom(item.insert) ?? {}, attributes: readMarkRecord(item.attributes)
  })));
}

export function assembleReaderBlocks(streams: readonly ReaderBlockStream[], cache?: Map<Y.Text, ReaderBlockCache>): ReaderBlockSpan[] {
  const spans: ReaderBlockSpan[] = [], seen = new Set<string>();
  for (const { text, head, delta } of streams) {
    const header = readBoundaryRecord(head), signature = header ? `${header.kind ?? "beat"}:${header.id}` : "";
    const previous = cache?.get(text), own = new Set(previous?.spans.map(span => `${span.block.kind}:${span.block.id}`));
    if (previous?.head === signature && previous.spans.every(span => !seen.has(`${span.block.kind}:${span.block.id}`))
      && previous.blocked.every(key => seen.has(key) || own.has(key))) {
      for (const span of previous.spans) { seen.add(`${span.block.kind}:${span.block.id}`); spans.push(span); }
      continue;
    }
    const local: ReaderBlockSpan[] = [], blocked: string[] = [];
    let current: ReaderBlockSpan | undefined, index = 0;
    const boundary = (raw: unknown, start: number): void => {
      const value = readBoundaryRecord(raw); if (!value) return;
      const kind = value.kind ? "h" : "b", key = `${kind}:${value.id}`;
      if (seen.has(key)) { blocked.push(key); return; }
      seen.add(key); if (current) current.end = index;
      current = { block: { id: value.id, kind, delta: [] }, text, start, end: text.length, parts: [] }; local.push(current);
    };
    boundary(head, 0);
    for (const item of delta) {
      const insert = typeof item.insert === "string" ? readWireValue(item.insert) as string : readContentAtom(item.insert);
      if (insert && typeof insert === "object" && ("b" in insert || "h" in insert)) boundary(insert, index + 1);
      else if (current && insert !== null) {
        const part = { insert, attributes: readMarkRecord(item.attributes) };
        current.block.delta.push(part); current.parts.push({ index, delta: part });
      }
      index += deltaLength(item);
    }
    for (const span of local) span.block.delta = compactDelta(span.block.delta);
    spans.push(...local); cache?.set(text, { head: signature, spans: local, blocked });
  }
  return spans;
}
