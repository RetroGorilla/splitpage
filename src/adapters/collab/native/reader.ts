import * as Y from "yjs";
import type { DocumentShape } from "../../../core/document/validated.ts";
import { toHtml } from "../../../core/text/html.ts";
import type { Run } from "../../../core/text/runs.ts";
import { nativeBlockOf, nativeItemLength, nativeRunsOf } from "./inline.ts";
import type { NativeDeltaItem } from "./inline.ts";
import type { NativeRoots } from "./roots.ts";

export type NativeOutlineEntry = { readonly kind: "heading"; readonly id: string; readonly name: string } | { readonly kind: "row"; readonly id: string };

export interface NativeReadRow {
  readonly id: string;
  readonly narration: readonly Run[];
  readonly visual: readonly Run[];
  readonly audioText: string;
  readonly visualText: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface NativeReadChanges {
  readonly rows: readonly string[];
  readonly gone: readonly string[];
  readonly headings: readonly string[];
  readonly outline: boolean;
}

export type NativeUnplacedReason = "no-head" | "repeated" | "no-record" | "heading-text" | "no-order";

export interface NativeUnplacedSpan {
  readonly segment: string;
  readonly reason: NativeUnplacedReason;
  readonly length: number;
}

export interface NativeReaderCounts {
  readonly parses: number;
  readonly rowsBuilt: number;
  readonly structures: number;
}

export interface NativeNarrationPlace {
  readonly text: Y.Text;
  readonly start: number;
  readonly end: number;
  readonly items: readonly NativeDeltaItem[];
}

interface ParsedSpan {
  readonly key: string | null;
  readonly start: number;
  readonly end: number;
  readonly items: readonly NativeDeltaItem[];
  readonly content: string;
}

interface ParsedSegment {
  readonly text: Y.Text | null;
  readonly spans: readonly ParsedSpan[];
  readonly signature: string;
}

interface SpanRef { readonly segment: string; readonly span: number }
interface UnplacedRef extends SpanRef { readonly reason: NativeUnplacedReason }
interface StoredBlock { readonly kind: "b" | "h"; readonly id: string; readonly shown: boolean }
type DeepListener = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void;
interface NativeWatched { readonly observeDeep: (listener: DeepListener) => void; readonly unobserveDeep: (listener: DeepListener) => void }

const RESERVED = new Set(["rank", "extra"]);
const EMPTY_CHANGES: NativeReadChanges = Object.freeze({ rows: [], gone: [], headings: [], outline: false });

function blockParts(key: string): { kind: "b" | "h"; id: string } {
  return { kind: key.startsWith("h:") ? "h" : "b", id: key.slice(2) };
}

function parseSegment(segment: Y.Map<unknown> | undefined): ParsedSegment {
  const raw = segment?.get("text"), text = raw instanceof Y.Text ? raw : null;
  const spans: { key: string | null; start: number; end: number; items: NativeDeltaItem[] }[] = [];
  let current = { key: nativeBlockOf(segment?.get("head")), start: 0, end: 0, items: [] as NativeDeltaItem[] }, index = 0;
  spans.push(current);
  for (const item of (text?.toDelta() ?? []) as NativeDeltaItem[]) {
    const boundary = typeof item.insert === "string" ? null : nativeBlockOf(item.insert);
    index += nativeItemLength(item);
    if (boundary) { current = { key: boundary, start: index, end: index, items: [] }; spans.push(current); }
    else { current.items.push(item); current.end = index; }
  }
  return {
    text,
    spans: spans.map(span => ({ ...span, content: JSON.stringify(span.items) })),
    signature: spans.map(span => span.key ?? (span.items.length ? "+" : "-")).join("|")
  };
}

function contentsByKey(spans: readonly ParsedSpan[]): Map<string, string> {
  const contents = new Map<string, string[]>();
  for (const span of spans) if (span.key) contents.set(span.key, [...contents.get(span.key) ?? [], span.content]);
  return new Map([...contents].map(([key, list]) => [key, JSON.stringify(list)]));
}

function plainRecord(record: Y.Map<unknown>, skip: ReadonlySet<string>): Record<string, unknown> {
  const entries = [...record].filter(([key]) => !skip.has(key)), extra = record.get("extra");
  if (typeof extra === "string") entries.push(...Object.entries(JSON.parse(extra) as Record<string, unknown>));
  return Object.fromEntries(entries);
}

function byRank(map: Y.Map<Y.Map<unknown>>): [string, Y.Map<unknown>][] {
  const entries = [...map].filter((entry): entry is [string, Y.Map<unknown>] => entry[1] instanceof Y.Map);
  const rank = (record: Y.Map<unknown>): string => { const value = record.get("rank"); return typeof value === "string" ? value : ""; };
  return entries.sort(([leftId, left], [rightId, right]) => rank(left) < rank(right) ? -1 : rank(left) > rank(right) ? 1 : leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
}

export class NativeScriptReader {
  private readonly roots: NativeRoots;
  private readonly parsed = new Map<string, ParsedSegment>();
  private readonly dirtySegments = new Set<string>();
  private readonly dirtyBeats = new Set<string>();
  private readonly dirtyHeadings = new Set<string>();
  private everything = true;
  private structural = true;
  private blocks: StoredBlock[] = [];
  private outlineEntries: NativeOutlineEntry[] = [];
  private readonly places = new Map<string, SpanRef>();
  private unplacedRefs: UnplacedRef[] = [];
  private readonly rowCache = new Map<string, NativeReadRow>();
  private readonly detach: (() => void)[] = [];
  private parses = 0;
  private rowsBuilt = 0;
  private structures = 0;

  constructor(roots: NativeRoots) {
    this.roots = roots;
    this.watch(roots.segments, events => {
      for (const event of events) {
        const [segment] = event.path;
        if (typeof segment === "string") { this.dirtySegments.add(segment); if (event.path.length === 1) this.structural = true; }
        else for (const key of event.keys.keys()) { this.dirtySegments.add(key); this.structural = true; }
      }
    });
    this.watch(roots.order, () => { this.structural = true; });
    this.watch(roots.beats, events => {
      for (const event of events) {
        const [beat] = event.path;
        if (typeof beat !== "string") { this.structural = true; for (const key of event.keys.keys()) this.dirtyBeats.add(key); continue; }
        this.dirtyBeats.add(beat);
        if (event.path.length === 1 && event.keys.has("rank")) this.structural = true;
      }
    });
    this.watch(roots.visuals, events => {
      for (const event of events) {
        const [beat] = event.path;
        if (typeof beat === "string") this.dirtyBeats.add(beat);
        else { this.structural = true; for (const key of event.keys.keys()) this.dirtyBeats.add(key); }
      }
    });
    this.watch(roots.headings, () => { this.structural = true; });
    this.watch(roots.names, events => {
      for (const event of events) {
        const [heading] = event.path;
        if (typeof heading === "string") this.dirtyHeadings.add(heading); else for (const key of event.keys.keys()) this.dirtyHeadings.add(key);
      }
    });
    this.watch(roots.edited, events => { for (const event of events) for (const key of event.keys.keys()) this.dirtyBeats.add(key); });
  }

  private watch(type: NativeWatched, handle: (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void): void {
    const listener = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => { handle(events); };
    type.observeDeep(listener);
    this.detach.push(() => { type.unobserveDeep(listener); });
  }

  close(): void {
    for (const stop of this.detach.splice(0)) stop();
  }

  counts(): NativeReaderCounts {
    return { parses: this.parses, rowsBuilt: this.rowsBuilt, structures: this.structures };
  }

  refresh(): NativeReadChanges {
    if (!this.everything && !this.structural && !this.dirtySegments.size && !this.dirtyBeats.size && !this.dirtyHeadings.size) return EMPTY_CHANGES;
    if (this.everything) {
      for (const key of [...this.roots.segments.keys(), ...this.parsed.keys()]) this.dirtySegments.add(key);
      for (const key of this.roots.beats.keys()) this.dirtyBeats.add(key);
      this.structural = true;
      this.everything = false;
    }
    this.reparse();
    const before = new Set(this.places.keys()), outline = this.structural;
    if (this.structural) this.restructure();
    const gone = [...before].filter(id => !this.places.has(id)), rows: string[] = [];
    for (const id of gone) this.rowCache.delete(id);
    for (const id of this.places.keys()) if (!before.has(id)) this.dirtyBeats.add(id);
    for (const id of this.dirtyBeats) {
      if (!this.places.has(id)) continue;
      const previous = this.rowCache.get(id), row = this.buildRow(id);
      this.rowCache.set(id, row);
      if (!previous || previous.audioText !== row.audioText || previous.visualText !== row.visualText || JSON.stringify(previous.fields) !== JSON.stringify(row.fields)) rows.push(id);
    }
    const headings = [...this.dirtyHeadings].filter(id => this.outlineEntries.some(entry => entry.kind === "heading" && entry.id === id));
    if (headings.length && !outline) this.outlineEntries = this.outlineEntries.map(entry => entry.kind === "heading" && headings.includes(entry.id) ? { ...entry, name: this.nameOf(entry.id) } : entry);
    this.dirtyBeats.clear(); this.dirtyHeadings.clear();
    return { rows, gone, headings, outline };
  }

  private reparse(): void {
    for (const key of this.dirtySegments) {
      const old = this.parsed.get(key), record = this.roots.segments.get(key);
      if (!(record instanceof Y.Map)) {
        if (old) { this.parsed.delete(key); this.structural = true; for (const span of old.spans) if (span.key?.startsWith("b:")) this.dirtyBeats.add(span.key.slice(2)); }
        continue;
      }
      const next = parseSegment(record);
      this.parses++;
      this.parsed.set(key, next);
      if (!old || old.signature !== next.signature) this.structural = true;
      const before = contentsByKey(old?.spans ?? []), after = contentsByKey(next.spans);
      for (const [key, content] of [...before, ...after]) {
        if (key.startsWith("b:") && (before.get(key) !== content || after.get(key) !== content)) this.dirtyBeats.add(key.slice(2));
      }
    }
    this.dirtySegments.clear();
  }

  private segment(key: string): ParsedSegment | null {
    const cached = this.parsed.get(key);
    if (cached) return cached;
    const record = this.roots.segments.get(key);
    if (!(record instanceof Y.Map)) return null;
    const parsed = parseSegment(record);
    this.parses++;
    this.parsed.set(key, parsed);
    return parsed;
  }

  private restructure(): void {
    this.structures++;
    const seen = new Set<string>(), blocks: StoredBlock[] = [], unplaced: UnplacedRef[] = [], ordered = new Set(this.roots.order.toArray());
    this.places.clear();
    for (const segment of ordered) {
      this.segment(segment)?.spans.forEach((span, index) => {
        const filled = span.end > span.start, ref = { segment, span: index };
        if (span.key === null) { if (filled) unplaced.push({ ...ref, reason: "no-head" }); return; }
        if (seen.has(span.key)) { if (filled) unplaced.push({ ...ref, reason: "repeated" }); return; }
        seen.add(span.key);
        const { kind, id } = blockParts(span.key);
        if (kind === "h") {
          if (filled) unplaced.push({ ...ref, reason: "heading-text" });
          const record = this.roots.headings.get(id);
          blocks.push({ kind, id, shown: record instanceof Y.Map && record.get("removed") !== true });
          return;
        }
        const shown = this.roots.beats.get(id) instanceof Y.Map && this.roots.visuals.get(id) instanceof Y.Text;
        if (shown) this.places.set(id, ref); else if (filled) unplaced.push({ ...ref, reason: "no-record" });
        blocks.push({ kind, id, shown });
      });
    }
    for (const key of this.roots.segments.keys()) {
      if (ordered.has(key)) continue;
      this.segment(key)?.spans.forEach((span, index) => { if (span.end > span.start) unplaced.push({ segment: key, span: index, reason: "no-order" }); });
    }
    this.blocks = blocks;
    this.unplacedRefs = unplaced;
    this.outlineEntries = this.ranked().map(block => block.kind === "h" ? { kind: "heading", id: block.id, name: this.nameOf(block.id) } : { kind: "row", id: block.id });
    this.structural = false;
  }

  // why: blocks show in rank order and ties keep stored order; a block with no rank reads after the block before it
  private ranked(): StoredBlock[] {
    let previous = "";
    const keyed = this.blocks.map((block, index) => {
      const record = block.kind === "h" ? this.roots.headings.get(block.id) : this.roots.beats.get(block.id);
      const rank = record instanceof Y.Map ? record.get("rank") : undefined;
      if (typeof rank === "string") previous = rank;
      return { block, rank: typeof rank === "string" ? rank : previous, index };
    });
    keyed.sort((left, right) => left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : left.index - right.index);
    return keyed.map(entry => entry.block).filter(block => block.shown);
  }

  private nameOf(id: string): string {
    const cell = this.roots.names.get(id);
    return cell instanceof Y.Text ? cell.toString() : "";
  }

  private span(ref: SpanRef): ParsedSpan | null {
    return this.parsed.get(ref.segment)?.spans[ref.span] ?? null;
  }

  private buildRow(id: string): NativeReadRow {
    this.rowsBuilt++;
    const ref = this.places.get(id), span = ref ? this.span(ref) : null, record = this.roots.beats.get(id), visual = this.roots.visuals.get(id);
    const narration = nativeRunsOf(span?.items ?? []), visualRuns = nativeRunsOf((visual instanceof Y.Text ? visual.toDelta() : []) as NativeDeltaItem[]);
    const fields = record instanceof Y.Map ? plainRecord(record, RESERVED) : {}, edited = this.roots.edited.get(id);
    if (edited && typeof edited === "object") {
      const stamp = edited as { at?: unknown; by?: unknown };
      if (stamp.at !== undefined) fields.updatedAt = stamp.at;
      if (stamp.by !== undefined) fields.updatedBy = stamp.by;
    }
    return Object.freeze({ id, narration, visual: visualRuns, audioText: toHtml(narration), visualText: toHtml(visualRuns), fields: Object.freeze(fields) });
  }

  outline(): readonly NativeOutlineEntry[] {
    this.refresh();
    return this.outlineEntries;
  }

  row(id: string): NativeReadRow | null {
    this.refresh();
    return this.rowCache.get(id) ?? null;
  }

  rows(): NativeReadRow[] {
    return this.outline().flatMap(entry => {
      const row = entry.kind === "row" ? this.rowCache.get(entry.id) : undefined;
      return row ? [row] : [];
    });
  }

  narrationPlace(beat: string): NativeNarrationPlace | null {
    this.refresh();
    const ref = this.places.get(beat), segment = ref ? this.parsed.get(ref.segment) : undefined, span = ref ? segment?.spans[ref.span] : undefined;
    if (!segment?.text || !span) return null;
    return { text: segment.text, start: span.start, end: span.end, items: span.items };
  }

  unplaced(): NativeUnplacedSpan[] {
    this.refresh();
    return this.unplacedRefs.flatMap(ref => {
      const span = this.span(ref);
      return span && span.end > span.start ? [{ segment: ref.segment, reason: ref.reason, length: span.end - span.start }] : [];
    });
  }

  document(): DocumentShape {
    const entries = this.outline(), meta = this.roots.meta, title = meta.get("title");
    const rows = entries.flatMap(entry => {
      const row = entry.kind === "row" ? this.rowCache.get(entry.id) : undefined;
      return row ? [{ id: row.id, ...row.fields, visualText: row.visualText, audioText: row.audioText }] : [];
    });
    const sections = entries.flatMap((entry, index) => {
      const next = entries[index + 1];
      const record = entry.kind === "heading" ? this.roots.headings.get(entry.id) : undefined;
      const fields = record instanceof Y.Map ? plainRecord(record, new Set([...RESERVED, "removed"])) : {};
      return entry.kind === "heading" && next?.kind === "row" ? [{ ...fields, id: entry.id, name: entry.name, firstSceneId: next.id }] : [];
    });
    const replies = new Map<string, Record<string, unknown>[]>();
    for (const [key, record] of byRank(this.roots.replies)) {
      const [commentId, id] = JSON.parse(key) as [string, string], list = replies.get(commentId) ?? [];
      list.push({ id, ...plainRecord(record, new Set([...RESERVED, "commentId"])) });
      replies.set(commentId, list);
    }
    const records = (map: Y.Map<Y.Map<unknown>>): Record<string, unknown>[] => byRank(map).map(([id, record]) => ({ id, ...plainRecord(record, RESERVED) }));
    const comments = records(this.roots.comments).map(comment => ({ ...comment, replies: replies.get(String(comment.id)) ?? [] }));
    const fields = plainRecord(meta, new Set([...RESERVED, "title", "format"]));
    return {
      ...fields,
      title: title instanceof Y.Text ? title.toString() : "",
      docId: String(fields.docId ?? ""),
      rev: typeof fields.rev === "number" ? fields.rev : 0,
      schema: typeof fields.schema === "number" ? fields.schema : 0,
      rows,
      ...sections.length ? { sections } : {},
      comments: comments as DocumentShape["comments"],
      people: records(this.roots.people) as DocumentShape["people"],
      productionTags: records(this.roots.tags) as DocumentShape["productionTags"],
      brollShots: records(this.roots.shots) as DocumentShape["brollShots"]
    };
  }
}
