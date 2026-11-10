import * as Y from "yjs";
import type { SchemaCandidate } from "../schema.ts";
import type { ProjectionBlock } from "../proj/document.ts";
import type { ProjectionDelta } from "../proj/richtext.ts";
import { readBoundaryRecord, readContentAtom, readMarkRecord, readSegmentRecord, readWireValue, rootMap, rootOrder, rootText } from "../readers/records.ts";
import { deltaLength, patchDelta, sameDelta } from "./delta.ts";

export interface PerfBlockSpan {
  block: ProjectionBlock;
  text: Y.Text;
  start: number;
  end: number;
}

export class PerfBlockIndex {
  private readonly streams = new Map<Y.Text, ProjectionDelta[]>();
  private readonly parsed = new Map<Y.Text, { head: unknown; spans: PerfBlockSpan[] }>();
  private readonly byText = new Map<Y.Text, PerfBlockSpan[]>();
  spans: PerfBlockSpan[] = [];
  lastLookupSpansScanned = 0;
  readonly doc: Y.Doc;
  readonly candidate: SchemaCandidate;

  constructor(doc: Y.Doc, candidate: SchemaCandidate) {
    this.doc = doc;
    this.candidate = candidate;
    this.refresh([]);
  }

  refresh(events: readonly Y.YEvent<Y.AbstractType<unknown>>[]): Set<string> {
    for (const event of events) if (event instanceof Y.YTextEvent && this.streams.has(event.target)) {
      try { this.streams.set(event.target, patchDelta(this.streams.get(event.target) ?? [], event.delta)); } catch { this.streams.delete(event.target); }
      this.parsed.delete(event.target);
    }
    const previous = new Map(this.spans.map(span => [`${span.block.kind}:${span.block.id}`, span.block]));
    const spans: PerfBlockSpan[] = [];
    const seen = new Set<string>();
    let current: PerfBlockSpan | undefined;
    const scan = (text: Y.Text, head?: unknown): void => {
      current = undefined;
      const header = readBoundaryRecord(head), signature = header ? `${header.kind ?? "beat"}:${header.id}` : "";
      const cached = this.parsed.get(text);
      if (cached && cached.head === signature && cached.spans.every(span => !seen.has(`${span.block.kind}:${span.block.id}`))) {
        for (const span of cached.spans) { seen.add(`${span.block.kind}:${span.block.id}`); spans.push(span); }
        current = cached.spans.at(-1);
        return;
      }
      const beginAt = spans.length;
      let index = 0;
      const boundary = (value: unknown, start: number): void => {
        const atom = readBoundaryRecord(value); if (!atom) return;
        const kind = atom.kind ? "h" : "b", id = atom.id;
        const key = `${kind}:${id}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (current && current.text === text) current.end = index;
        current = { block: { id, kind, delta: [] }, text, start, end: text.length };
        spans.push(current);
      };
      if (head) boundary(head, 0);
      let delta = this.streams.get(text);
      if (!delta) {
        const raw = text.toDelta() as { insert: unknown; attributes?: unknown }[];
        const loaded: ProjectionDelta[] = raw.map(item => ({ insert: typeof item.insert === "string" ? readWireValue(item.insert) as string : readContentAtom(item.insert) ?? {}, attributes: { ...readMarkRecord(item.attributes) } }));
        delta = loaded; this.streams.set(text, loaded);
      }
      for (const item of delta) {
        const insert = typeof item.insert === "string" ? readWireValue(item.insert) as string : readContentAtom(item.insert);
        if (insert && typeof insert === "object" && ("b" in insert || "h" in insert)) boundary(insert, index + 1);
        else {
          const destination = current as PerfBlockSpan | undefined;
          if (destination && insert !== null) destination.block.delta.push({ insert, attributes: { ...readMarkRecord(item.attributes) } });
        }
        index += deltaLength(item);
      }
      this.parsed.set(text, { head: signature, spans: spans.slice(beginAt) });
    };
    if (this.candidate === "A") { const text = rootText(this.doc, "flow"); if (text) scan(text); }
    else for (const id of new Set(rootOrder(this.doc))) {
      const segment = readSegmentRecord(rootMap(this.doc, "segments")?.get(id));
      if (segment) scan(segment.text, segment.head ? { [segment.head.kind ? "h" : "b"]: segment.head.id } : undefined);
    }
    const changed = new Set<string>();
    for (const span of spans) {
      const key = `${span.block.kind}:${span.block.id}`;
      const old = previous.get(key);
      if (old && sameDelta(old.delta, span.block.delta)) span.block = old;
      else changed.add(span.block.id);
      previous.delete(key);
    }
    for (const block of previous.values()) changed.add(block.id);
    this.spans = spans;
    this.byText.clear();
    for (const span of spans) {
      const group = this.byText.get(span.text) ?? [];
      group.push(span);
      this.byText.set(span.text, group);
    }
    return changed;
  }

  containing(text: Y.AbstractType<unknown>, index: number): PerfBlockSpan | undefined {
    this.lastLookupSpansScanned = 0;
    return text instanceof Y.Text ? this.byText.get(text)?.find(span => {
      this.lastLookupSpansScanned++;
      return span.start <= index && index < span.end;
    }) : undefined;
  }

  locate(id: string): PerfBlockSpan {
    const span = this.spans.find(item => item.block.id === id);
    if (!span) throw new Error(`Missing beat ${id}`);
    return span;
  }
}
