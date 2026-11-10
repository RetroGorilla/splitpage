import * as Y from "yjs";
import type { SchemaCandidate } from "../schema.ts";
import type { ProjectionBlock } from "../proj/document.ts";
import type { ProjectionDelta } from "../proj/richtext.ts";
import { assembleReaderBlocks, readerBlockDelta, readerBlockStreams } from "../readers/blocks.ts";
import type { ReaderBlockCache } from "../readers/blocks.ts";
import { patchDelta, sameDelta } from "./delta.ts";

export interface PerfBlockSpan {
  block: ProjectionBlock;
  text: Y.Text;
  start: number;
  end: number;
}

export class PerfBlockIndex {
  private readonly streams = new Map<Y.Text, ProjectionDelta[]>();
  private readonly parsed = new Map<Y.Text, ReaderBlockCache>();
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
    const spans = assembleReaderBlocks(readerBlockStreams(this.doc, this.candidate, text => {
      let delta = this.streams.get(text);
      if (!delta) { delta = readerBlockDelta(text); this.streams.set(text, delta); }
      return delta;
    }), this.parsed);
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
