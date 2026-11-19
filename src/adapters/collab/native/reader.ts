import * as Y from "yjs";
import type { DocumentShape } from "../../../core/document/validated.ts";
import { toHtml } from "../../../core/text/html.ts";
import type { Run } from "../../../core/text/runs.ts";
import { nativeBlockOf, nativeItemLength, nativeRunsOf, nativeUnitCounts } from "./inline.ts";
import type { NativeDeltaItem } from "./inline.ts";
import type { NativeRoots } from "./roots.ts";
import { NATIVE_FIELD_PREFIX, decodeNativeValue, deepFrozen } from "./values.ts";

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

export type NativeProblemKind = "no-text" | "hidden-units" | "unknown-embed" | "bad-value" | "bad-key" | "heading-without-row" | "join-not-read";

export interface NativeReaderProblem {
  readonly kind: NativeProblemKind;
  readonly where: string;
}

export interface NativeReaderCounts {
  readonly parses: number;
  readonly rowsBuilt: number;
  readonly structures: number;
}

export interface NativeSpanPlace {
  readonly segment: string;
  readonly span: number;
}

export interface NativeSpanContent {
  readonly key: string | null;
  readonly start: number;
  readonly end: number;
  readonly items: readonly NativeDeltaItem[];
}

interface ParsedSpan extends NativeSpanContent { readonly content: string }

interface ParsedSegment {
  readonly hasText: boolean;
  readonly spans: readonly ParsedSpan[];
  readonly signature: string;
}

interface UnplacedRef extends NativeSpanPlace { readonly reason: NativeUnplacedReason }
interface StoredBlock { readonly kind: "b" | "h"; readonly id: string; readonly shown: boolean }
type DeepListener = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void;
interface NativeWatched { readonly observeDeep: (listener: DeepListener) => void; readonly unobserveDeep: (listener: DeepListener) => void }
type Problems = NativeReaderProblem[] | null;

const BEAT_FIELDS = ["status", "lengthSeconds", "paragraphStart"];
const META_FIELDS = ["docId", "schema", "wordsPerMinute", "targetSeconds"];

export function nativeSegmentSpans(segment: unknown): NativeSpanContent[] | null {
  if (!(segment instanceof Y.Map)) return null;
  const text = segment.get("text");
  if (!(text instanceof Y.Text)) return null;
  const spans: { key: string | null; start: number; end: number; items: NativeDeltaItem[] }[] = [];
  let current = { key: nativeBlockOf(segment.get("head")), start: 0, end: 0, items: [] as NativeDeltaItem[] }, index = 0;
  spans.push(current);
  for (const item of text.toDelta() as NativeDeltaItem[]) {
    const boundary = typeof item.insert === "string" ? null : nativeBlockOf(item.insert);
    index += nativeItemLength(item);
    if (boundary) { current = { key: boundary, start: index, end: index, items: [] }; spans.push(current); }
    else { current.items.push(item); current.end = index; }
  }
  return spans;
}

function parseSegment(segment: unknown): ParsedSegment {
  const spans = nativeSegmentSpans(segment);
  if (!spans) return { hasText: false, spans: [], signature: "~" };
  return { hasText: true, spans: spans.map(span => ({ ...span, content: JSON.stringify(span.items) })), signature: spans.map(span => span.key ?? "~").join("|") };
}

function contentsByKey(spans: readonly ParsedSpan[]): Map<string, string> {
  const contents = new Map<string, string[]>();
  for (const span of spans) if (span.key) contents.set(span.key, [...contents.get(span.key) ?? [], span.content]);
  return new Map([...contents].map(([key, list]) => [key, JSON.stringify(list)]));
}

function decoded(record: Y.Map<unknown>, key: string, where: string, problems: Problems): { readonly value: unknown } | null {
  if (!record.has(key)) return null;
  const value = decodeNativeValue(record.get(key));
  if (!value) problems?.push({ kind: "bad-value", where: where + "/" + key });
  return value;
}

function fileFields(record: Y.Map<unknown>, where: string, problems: Problems): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const key of [...record.keys()].sort()) {
    if (!key.startsWith(NATIVE_FIELD_PREFIX)) continue;
    const value = decoded(record, key, where, problems);
    if (value) entries.push([key.slice(NATIVE_FIELD_PREFIX.length), value.value]);
  }
  return Object.fromEntries(entries);
}

function namedFields(record: Y.Map<unknown>, names: readonly string[], where: string, problems: Problems): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const name of names) { const value = decoded(record, name, where, problems); if (value) entries.push([name, value.value]); }
  const extra = decoded(record, "extra", where, problems);
  if (extra) {
    if (extra.value && typeof extra.value === "object" && !Array.isArray(extra.value)) entries.push(...Object.entries(extra.value));
    else problems?.push({ kind: "bad-value", where: where + "/extra" });
  }
  return entries;
}

function rankOf(record: unknown): string | null {
  const rank = record instanceof Y.Map ? record.get("rank") : undefined;
  return typeof rank === "string" ? rank : null;
}

function byRank(map: Y.Map<Y.Map<unknown>>): [string, Y.Map<unknown>][] {
  const entries = [...map].filter((entry): entry is [string, Y.Map<unknown>] => entry[1] instanceof Y.Map);
  const rank = (record: Y.Map<unknown>): string => rankOf(record) ?? "";
  return entries.sort(([leftId, left], [rightId, right]) => rank(left) < rank(right) ? -1 : rank(left) > rank(right) ? 1 : leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
}

function samePlace(left: NativeSpanPlace | undefined, right: NativeSpanPlace | undefined): boolean {
  return left?.segment === right?.segment && left?.span === right?.span;
}

export class NativeScriptReader {
  private readonly roots: NativeRoots;
  private readonly parsed = new Map<string, ParsedSegment>();
  private readonly dirtySegments = new Set<string>();
  private readonly dirtyBeats = new Set<string>();
  private readonly dirtyHeadings = new Set<string>();
  private everything = true;
  private structural = true;
  private closed = false;
  private outlineEntries: readonly NativeOutlineEntry[] = Object.freeze([]);
  private readonly headingIndex = new Map<string, number>();
  private places = new Map<string, NativeSpanPlace>();
  private candidates: UnplacedRef[] = [];
  private readonly rowCache = new Map<string, NativeReadRow>();
  private readonly builtFrom = new Map<string, string>();
  private readonly pendingRows = new Set<string>();
  private readonly pendingGone = new Set<string>();
  private readonly pendingHeadings = new Set<string>();
  private pendingOutline = false;
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

  private watch(type: NativeWatched, handle: DeepListener): void {
    const listener: DeepListener = events => { handle(events); };
    type.observeDeep(listener);
    this.detach.push(() => { type.unobserveDeep(listener); });
  }

  close(): void {
    this.closed = true;
    for (const stop of this.detach.splice(0)) stop();
  }

  isClosed(): boolean {
    return this.closed;
  }

  counts(): NativeReaderCounts {
    return { parses: this.parses, rowsBuilt: this.rowsBuilt, structures: this.structures };
  }

  refresh(): NativeReadChanges {
    this.sync();
    const changes = Object.freeze({
      rows: Object.freeze([...this.pendingRows]), gone: Object.freeze([...this.pendingGone]),
      headings: Object.freeze([...this.pendingHeadings]), outline: this.pendingOutline
    });
    this.pendingRows.clear(); this.pendingGone.clear(); this.pendingHeadings.clear(); this.pendingOutline = false;
    return changes;
  }

  private sync(): void {
    if (this.closed) throw new Error("The script reader is closed");
    if (!this.everything && !this.structural && !this.dirtySegments.size && !this.dirtyBeats.size && !this.dirtyHeadings.size) return;
    if (this.everything) {
      for (const key of [...this.roots.segments.keys(), ...this.parsed.keys()]) this.dirtySegments.add(key);
      for (const key of this.roots.beats.keys()) this.dirtyBeats.add(key);
      this.structural = true;
      this.everything = false;
    }
    this.reparse();
    if (this.structural) this.restructure();
    for (const id of this.dirtyBeats) {
      if (!this.places.has(id)) continue;
      const previous = this.rowCache.get(id), row = this.buildRow(id);
      this.rowCache.set(id, row);
      if (!previous || previous.audioText !== row.audioText || previous.visualText !== row.visualText || JSON.stringify(previous.fields) !== JSON.stringify(row.fields)) {
        this.pendingGone.delete(id); this.pendingRows.add(id);
      }
    }
    for (const id of this.dirtyHeadings) {
      const index = this.headingIndex.get(id), entry = index === undefined ? undefined : this.outlineEntries[index];
      if (index === undefined || entry?.kind !== "heading") continue;
      const name = this.nameOf(id);
      if (name === entry.name) continue;
      this.outlineEntries = Object.freeze(this.outlineEntries.map((value, at) => at === index ? Object.freeze({ kind: "heading" as const, id, name }) : value));
      this.pendingHeadings.add(id);
    }
    this.dirtyBeats.clear(); this.dirtyHeadings.clear();
  }

  private reparse(): void {
    for (const key of this.dirtySegments) {
      const old = this.parsed.get(key), record = this.roots.segments.get(key);
      if (record === undefined) {
        if (old) { this.parsed.delete(key); this.structural = true; for (const span of old.spans) if (span.key?.startsWith("b:")) this.dirtyBeats.add(span.key.slice(2)); }
        continue;
      }
      const next = parseSegment(record);
      this.parses++;
      this.parsed.set(key, next);
      if (!old || old.signature !== next.signature || old.hasText !== next.hasText) this.structural = true;
      const before = contentsByKey(old?.spans ?? []), after = contentsByKey(next.spans);
      for (const [block, content] of [...before, ...after]) {
        if (block.startsWith("b:") && (before.get(block) !== content || after.get(block) !== content)) this.dirtyBeats.add(block.slice(2));
      }
    }
    this.dirtySegments.clear();
  }

  private segment(key: string): ParsedSegment | null {
    const cached = this.parsed.get(key);
    if (cached) return cached;
    const record = this.roots.segments.get(key);
    if (record === undefined) return null;
    const parsed = parseSegment(record);
    this.parses++;
    this.parsed.set(key, parsed);
    return parsed;
  }

  private restructure(): void {
    this.structures++;
    const seen = new Set<string>(), blocks: StoredBlock[] = [], candidates: UnplacedRef[] = [], places = new Map<string, NativeSpanPlace>();
    const ordered = new Set(this.roots.order.toArray().filter((key): key is string => typeof key === "string"));
    for (const segment of ordered) {
      const parsed = this.segment(segment);
      if (!parsed?.hasText) continue;
      parsed.spans.forEach((span, index) => {
        const ref = { segment, span: index };
        if (span.key === null) { candidates.push({ ...ref, reason: "no-head" }); return; }
        if (seen.has(span.key)) { candidates.push({ ...ref, reason: "repeated" }); return; }
        seen.add(span.key);
        const kind = span.key.startsWith("h:") ? "h" : "b", id = span.key.slice(2);
        if (kind === "h") {
          candidates.push({ ...ref, reason: "heading-text" });
          const record = this.roots.headings.get(id);
          blocks.push({ kind, id, shown: record instanceof Y.Map && record.get("removed") !== true });
          return;
        }
        const shown = this.roots.beats.get(id) instanceof Y.Map && this.roots.visuals.get(id) instanceof Y.Text;
        if (shown) places.set(id, ref); else candidates.push({ ...ref, reason: "no-record" });
        blocks.push({ kind, id, shown });
      });
    }
    for (const key of this.roots.segments.keys()) {
      if (ordered.has(key)) continue;
      this.segment(key)?.spans.forEach((_, index) => { candidates.push({ segment: key, span: index, reason: "no-order" }); });
    }
    for (const id of this.places.keys()) if (!places.has(id)) { this.rowCache.delete(id); this.builtFrom.delete(id); this.pendingRows.delete(id); this.pendingGone.add(id); }
    for (const [id, place] of places) {
      if (!samePlace(place, this.places.get(id)) && this.spanAt(place)?.content !== this.builtFrom.get(id)) this.dirtyBeats.add(id);
    }
    this.places = places;
    this.candidates = candidates;
    const outline = Object.freeze(this.ranked(blocks).map(block => Object.freeze(block.kind === "h" ? { kind: "heading" as const, id: block.id, name: this.nameOf(block.id) } : { kind: "row" as const, id: block.id })));
    if (JSON.stringify(outline) !== JSON.stringify(this.outlineEntries)) this.pendingOutline = true;
    this.outlineEntries = outline;
    this.headingIndex.clear();
    outline.forEach((entry, index) => { if (entry.kind === "heading") this.headingIndex.set(entry.id, index); });
    this.structural = false;
  }

  // why: blocks show in rank order and ties keep stored order; a block with no rank reads after the block before it
  private ranked(blocks: readonly StoredBlock[]): StoredBlock[] {
    let previous = "";
    const keyed = blocks.map((block, index) => {
      const rank = rankOf(block.kind === "h" ? this.roots.headings.get(block.id) : this.roots.beats.get(block.id));
      if (rank !== null) previous = rank;
      return { block, rank: rank ?? previous, index };
    });
    keyed.sort((left, right) => left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : left.index - right.index);
    return keyed.map(entry => entry.block).filter(block => block.shown);
  }

  private nameOf(id: string): string {
    const cell = this.roots.names.get(id);
    return cell instanceof Y.Text ? cell.toString() : "";
  }

  private spanAt(place: NativeSpanPlace): ParsedSpan | null {
    return this.parsed.get(place.segment)?.spans[place.span] ?? null;
  }

  private beatFields(id: string, problems: Problems): Record<string, unknown> {
    const record = this.roots.beats.get(id), entries: [string, unknown][] = [];
    if (record instanceof Y.Map) {
      entries.push(...namedFields(record, BEAT_FIELDS, "beats/" + id, problems));
      if (record.has("joined")) problems?.push({ kind: "join-not-read", where: "beats/" + id });
    }
    const edited = this.roots.edited.get(id);
    if (edited && typeof edited === "object") {
      for (const [field, name] of [["updatedAt", "at"], ["updatedBy", "by"]] as const) {
        const stored = (edited as Record<string, unknown>)[name];
        if (stored === undefined) continue;
        const value = decodeNativeValue(stored);
        if (value) entries.push([field, value.value]); else problems?.push({ kind: "bad-value", where: "edited/" + id + "/" + name });
      }
    } else if (edited !== undefined) problems?.push({ kind: "bad-value", where: "edited/" + id });
    return Object.fromEntries(entries);
  }

  private buildRow(id: string): NativeReadRow {
    this.rowsBuilt++;
    const place = this.places.get(id), span = place ? this.spanAt(place) : null, visual = this.roots.visuals.get(id);
    this.builtFrom.set(id, span?.content ?? "");
    const narration = nativeRunsOf(span?.items ?? []), visualRuns = nativeRunsOf((visual instanceof Y.Text ? visual.toDelta() : []) as NativeDeltaItem[]);
    return deepFrozen({ id, narration, visual: visualRuns, audioText: toHtml(narration), visualText: toHtml(visualRuns), fields: this.beatFields(id, null) });
  }

  outline(): readonly NativeOutlineEntry[] {
    this.sync();
    return this.outlineEntries;
  }

  row(id: string): NativeReadRow | null {
    this.sync();
    return this.rowCache.get(id) ?? null;
  }

  rows(): NativeReadRow[] {
    return this.outline().flatMap(entry => {
      const row = entry.kind === "row" ? this.rowCache.get(entry.id) : undefined;
      return row ? [row] : [];
    });
  }

  narrationSpans(beat: string): readonly NativeSpanPlace[] {
    this.sync();
    const place = this.places.get(beat);
    return place ? [place] : [];
  }

  unplaced(): NativeUnplacedSpan[] {
    this.sync();
    return this.candidates.flatMap(ref => {
      const span = this.spanAt(ref);
      return span && span.end > span.start ? [{ segment: ref.segment, reason: ref.reason, length: span.end - span.start }] : [];
    });
  }

  problems(): NativeReaderProblem[] {
    const entries = this.outline(), problems: NativeReaderProblem[] = [];
    for (const key of [...this.roots.segments.keys()].sort()) {
      const parsed = this.segment(key);
      if (!parsed) continue;
      if (!parsed.hasText) { problems.push({ kind: "no-text", where: "segments/" + key }); continue; }
      parsed.spans.forEach((span, index) => this.cellProblems(span.items, "segments/" + key + "#" + index, problems));
    }
    for (const id of this.places.keys()) {
      const visual = this.roots.visuals.get(id);
      if (visual instanceof Y.Text) this.cellProblems(visual.toDelta() as NativeDeltaItem[], "visuals/" + id, problems);
      this.beatFields(id, problems);
    }
    entries.forEach((entry, index) => { if (entry.kind === "heading" && entries[index + 1]?.kind !== "row") problems.push({ kind: "heading-without-row", where: "headings/" + entry.id }); });
    this.collect(problems);
    return problems;
  }

  private cellProblems(items: readonly NativeDeltaItem[], where: string, problems: NativeReaderProblem[]): void {
    if (!items.length) return;
    const counts = nativeUnitCounts(items);
    if (counts.unknown) problems.push({ kind: "unknown-embed", where });
    if (counts.hidden > counts.unknown) problems.push({ kind: "hidden-units", where });
  }

  private collect(problems: Problems): Pick<DocumentShape, "title" | "docId" | "rev" | "schema" | "comments" | "people" | "productionTags" | "brollShots"> & Record<string, unknown> {
    const meta = this.roots.meta, title = meta.get("title");
    const metaFields = Object.fromEntries(namedFields(meta, META_FIELDS, "meta", problems));
    const replies = new Map<string, Record<string, unknown>[]>();
    for (const [key, record] of byRank(this.roots.replies)) {
      const ids = decodeNativeValue(key)?.value, commentId = record.get("commentId");
      if (!Array.isArray(ids) || ids.length !== 2 || typeof ids[0] !== "string" || typeof ids[1] !== "string" || ids[0] !== commentId) {
        problems?.push({ kind: "bad-key", where: "replies/" + key });
        continue;
      }
      const list = replies.get(ids[0]) ?? [];
      list.push({ ...fileFields(record, "replies/" + key, problems), id: ids[1] });
      replies.set(ids[0], list);
    }
    const records = (root: Y.Map<Y.Map<unknown>>, name: string): Record<string, unknown>[] =>
      byRank(root).map(([id, record]) => ({ ...fileFields(record, name + "/" + id, problems), id }));
    return {
      ...metaFields,
      title: title instanceof Y.Text ? title.toString() : "",
      docId: typeof metaFields.docId === "string" ? metaFields.docId : "",
      rev: typeof metaFields.rev === "number" ? metaFields.rev : 0,
      schema: typeof metaFields.schema === "number" ? metaFields.schema : 0,
      comments: records(this.roots.comments, "comments").map(comment => ({ ...comment, replies: replies.get(String(comment.id)) ?? [] })) as DocumentShape["comments"],
      people: records(this.roots.people, "people") as DocumentShape["people"],
      productionTags: records(this.roots.tags, "tags") as DocumentShape["productionTags"],
      brollShots: records(this.roots.shots, "shots") as DocumentShape["brollShots"]
    };
  }

  // why: the file holds one heading per row, so only a heading directly above a row is saved; problems() lists the rest
  document(): DocumentShape {
    const entries = this.outline();
    const rows = entries.flatMap(entry => {
      const row = entry.kind === "row" ? this.rowCache.get(entry.id) : undefined;
      return row ? [{ id: row.id, ...row.fields, visualText: row.visualText, audioText: row.audioText }] : [];
    });
    const sections = entries.flatMap((entry, index) => {
      const next = entries[index + 1], record = entry.kind === "heading" ? this.roots.headings.get(entry.id) : undefined;
      if (entry.kind !== "heading" || next?.kind !== "row") return [];
      return [{ ...record instanceof Y.Map ? fileFields(record, "headings/" + entry.id, null) : {}, id: entry.id, name: entry.name, firstSceneId: next.id }];
    });
    return structuredClone({ ...this.collect(null), rows, ...sections.length ? { sections } : {} });
  }
}
