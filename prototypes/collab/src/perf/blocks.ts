import * as Y from "yjs";
import { mapValue, textValue } from "../schema.ts";
import type { SchemaCandidate } from "../schema.ts";
import type { ProjectionBlock } from "../proj/document.ts";
import { readDelta } from "../proj/richtext.ts";
import type { ProjectionDelta } from "../proj/richtext.ts";
import { bag } from "../proj/value.ts";
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
      this.streams.set(event.target, patchDelta(this.streams.get(event.target) ?? [], event.delta));
      this.parsed.delete(event.target);
    }
    const previous = new Map(this.spans.map(span => [`${span.block.kind}:${span.block.id}`, span.block]));
    const spans: PerfBlockSpan[] = [];
    const seen = new Set<string>();
    let current: PerfBlockSpan | undefined;
    const scan = (text: Y.Text, head?: unknown): void => {
      const cached = this.parsed.get(text);
      if (cached && cached.head === head && cached.spans.every(span => !seen.has(`${span.block.kind}:${span.block.id}`))) {
        for (const span of cached.spans) { seen.add(`${span.block.kind}:${span.block.id}`); spans.push(span); }
        current = cached.spans.at(-1);
        return;
      }
      const beginAt = spans.length;
      let index = 0;
      const boundary = (value: unknown, start: number): void => {
        const atom = bag(value);
        const kind = "b" in atom ? "b" : "h";
        const id = String(atom[kind]);
        const key = `${kind}:${id}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (current && current.text === text) current.end = index;
        current = { block: { id, kind, delta: [] }, text, start, end: text.length };
        spans.push(current);
      };
      if (head) boundary(head, 0);
      let delta = this.streams.get(text);
      if (!delta) { delta = readDelta(text); this.streams.set(text, delta); }
      for (const item of delta) {
        if (typeof item.insert === "object" && ("b" in item.insert || "h" in item.insert)) boundary(item.insert, index + 1);
        else {
          if (!current) throw new Error("Content before a boundary");
          current.block.delta.push(item);
        }
        index += deltaLength(item);
      }
      this.parsed.set(text, { head, spans: spans.slice(beginAt) });
    };
    if (this.candidate === "A") scan(this.doc.getText("flow"));
    else for (const id of new Set(this.doc.getArray<string>("order").toArray())) {
      const segment = mapValue(this.doc.getMap("segments").get(id));
      scan(textValue(segment.get("text")), segment.get("head"));
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
