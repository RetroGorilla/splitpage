import * as Y from "yjs";
import type { DocumentShape } from "../../../core/document/validated.ts";
import { toHtml } from "../../../core/text/html.ts";
import type { Run } from "../../../core/text/runs.ts";
import { nativeBlockOf, nativeItemLength, nativeRunsOf, nativeUnitCounts } from "./inline.ts";
import type { NativeDeltaItem } from "./inline.ts";
import type { NativeRoots } from "./roots.ts";
import { NATIVE_FIELD_PREFIX, decodeNativeValue, deepFrozen, nativeFieldName } from "./values.ts";

export type NativeOutlineEntry = { readonly kind: "heading"; readonly id: string; readonly name: string } | { readonly kind: "row"; readonly id: string };

export interface NativeReadRow {
  readonly id: string;
  readonly members: readonly string[];
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

export type NativeUnplacedReason = "no-order";

export interface NativeUnplacedSpan {
  readonly segment: string;
  readonly reason: NativeUnplacedReason;
  readonly length: number;
}

export type NativeProblemKind = "no-text" | "hidden-units" | "unknown-embed" | "unshown-marks" | "bad-value" | "bad-key" | "heading-without-row" | "join-not-read" | "missing-beat-record" | "missing-visual" | "missing-heading-record" | "missing-name" | "no-order" | "no-segment";

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
}

function samePlacement(left: ParsedSegment, right: ParsedSegment): boolean {
  return left.hasText === right.hasText && left.spans.length === right.spans.length && left.spans.every((span, index) => span.key === right.spans[index]?.key);
}

interface UnplacedRef extends NativeSpanPlace { readonly reason: NativeUnplacedReason }
interface StoredBlock { readonly kind: "b" | "h"; readonly id: string; readonly shown: boolean; readonly spans: NativeSpanPlace[] }
type DeepListener = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void;
export type NativeWatch = <Event>(type: Y.AbstractType<Event>, listener: DeepListener) => () => void;
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
  if (!spans) return { hasText: false, spans: [] };
  return { hasText: true, spans: spans.map(span => ({ ...span, content: JSON.stringify(span.items) })) };
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
    const name = nativeFieldName(key);
    if (name === null) { problems?.push({ kind: "bad-key", where: where + "/" + key }); continue; }
    const value = decoded(record, key, where, problems);
    if (value) entries.push([name, value.value]);
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

// why: a run's shape is known, so it is frozen field by field instead of by a walk over every value
function frozenRuns(runs: Run[]): readonly Run[] {
  for (const run of runs) {
    const marks = run.marks;
    if (marks.cmt) Object.freeze(marks.cmt);
    if (marks.innerTags) Object.freeze(marks.innerTags);
    Object.freeze(marks);
    if (run.atom === "image") deepFrozen(run.ref);
    Object.freeze(run);
  }
  return Object.freeze(runs);
}

interface RowMember { readonly id: string; readonly glue: string }
export interface NativeRemovedHeading { readonly id: string; readonly name: string }

function sameSpans(left: readonly NativeSpanPlace[], right: readonly NativeSpanPlace[] | undefined): boolean {
  return left.length === right?.length && left.every((ref, at) => ref.segment === right[at]?.segment && ref.span === right[at]?.span);
}

function joinOf(record: unknown): { into: string; glue: string } | null {
  const joined: unknown = record instanceof Y.Map ? record.get("joined") : undefined;
  if (!joined || typeof joined !== "object") return null;
  const value = joined as Readonly<Record<string, unknown>>;
  return typeof value.into === "string" && typeof value.glue === "string" ? { into: value.into, glue: value.glue } : null;
}

const EMPTY_SPANS: readonly NativeSpanPlace[] = Object.freeze([]);

export class NativeScriptReader {
  private readonly roots: NativeRoots;
  private readonly parsed = new Map<string, ParsedSegment>();
  private readonly dirtySegments = new Set<string>();
  private readonly dirtyBeats = new Set<string>();
  private readonly dirtyHeadings = new Set<string>();
  private structural = true;
  private closed = false;
  private outlineEntries: readonly NativeOutlineEntry[] = Object.freeze([]);
  private readonly headingIndex = new Map<string, number>();
  private places = new Map<string, NativeSpanPlace>();
  private headingPlaces = new Map<string, NativeSpanPlace>();
  private candidates: UnplacedRef[] = [];
  private readonly rowCache = new Map<string, NativeReadRow>();
  private narration = new Map<string, readonly NativeSpanPlace[]>();
  private readonly builtNarration = new Map<string, string>();
  private readonly movedSegments = new Set<string>();
  private spanOwners = new Map<string, string[]>();
  private groups = new Map<string, RowMember[]>();
  private groupHeads = new Map<string, string>();
  private removedHeadings: readonly string[] = [];
  private structuralProblems: NativeReaderProblem[] = [];
  private stray: string | null = null;
  private readonly pendingRows = new Set<string>();
  private readonly pendingGone = new Set<string>();
  private readonly pendingHeadings = new Set<string>();
  private pendingOutline = false;
  private readonly detach: (() => void)[] = [];
  private parses = 0;
  private rowsBuilt = 0;
  private structures = 0;

  constructor(roots: NativeRoots, watch?: NativeWatch) {
    this.roots = roots;
    if (!watch) return;
    const observe = <Event>(type: Y.AbstractType<Event>, listener: DeepListener): void => { this.detach.push(watch(type, listener)); };
    observe(roots.segments, events => {
      for (const event of events) {
        const [segment] = event.path;
        if (typeof segment === "string") { this.dirtySegments.add(segment); if (event.path.length === 1) this.structural = true; }
        else for (const key of event.keys.keys()) { this.dirtySegments.add(key); this.structural = true; }
      }
    });
    observe(roots.order, () => { this.structural = true; });
    observe(roots.beats, events => {
      for (const event of events) {
        const [beat] = event.path;
        if (typeof beat !== "string") { this.structural = true; for (const key of event.keys.keys()) this.dirtyBeats.add(key); continue; }
        this.dirtyBeats.add(beat);
        if (event.path.length === 1 && (event.keys.has("rank") || event.keys.has("joined"))) this.structural = true;
      }
    });
    observe(roots.visuals, events => {
      for (const event of events) {
        const [beat] = event.path;
        if (typeof beat === "string") this.dirtyBeats.add(beat);
        else { this.structural = true; for (const key of event.keys.keys()) this.dirtyBeats.add(key); }
      }
    });
    observe(roots.headings, () => { this.structural = true; });
    observe(roots.names, events => {
      for (const event of events) {
        const [heading] = event.path;
        if (typeof heading === "string") this.dirtyHeadings.add(heading); else this.structural = true;
      }
    });
    observe(roots.edited, events => { for (const event of events) for (const key of event.keys.keys()) this.dirtyBeats.add(key); });
  }

  close(): void {
    this.closed = true;
    for (const stop of this.detach.splice(0)) stop();
  }

  isClosed(): boolean {
    return this.closed;
  }

  counts(): NativeReaderCounts {
    return Object.freeze({ parses: this.parses, rowsBuilt: this.rowsBuilt, structures: this.structures });
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
    if (!this.structural && !this.dirtySegments.size && !this.dirtyBeats.size && !this.dirtyHeadings.size) return;
    this.reparse();
    if (this.structural) this.restructure();
    const dirtyRows = new Set<string>();
    for (const beat of this.dirtyBeats) {
      const head = this.groupHeads.get(beat);
      if (head !== undefined) dirtyRows.add(head);
    }
    for (const id of dirtyRows) {
      const previous = this.rowCache.get(id), row = this.buildRow(id);
      this.rowCache.set(id, row);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(row)) {
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
        if (this.parsed.delete(key)) this.structural = true;
        continue;
      }
      const next = parseSegment(record);
      this.parses++;
      this.parsed.set(key, next);
      if (!old || !samePlacement(old, next)) {
        this.structural = true;
        this.movedSegments.add(key);
        continue;
      }
      const owners = this.spanOwners.get(key);
      next.spans.forEach((span, index) => {
        if (span.content === old?.spans[index]?.content) return;
        const owner = owners?.[index];
        if (owner !== undefined) this.dirtyBeats.add(owner);
      });
      if (this.stray !== null && owners?.includes(this.stray)) this.structural = true;
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
    const seen = new Set<string>(), blocks: StoredBlock[] = [], places = new Map<string, NativeSpanPlace>();
    const top: NativeSpanPlace[] = [], problems: NativeReaderProblem[] = [], headingPlaces = new Map<string, NativeSpanPlace>();
    const ordered = new Set(this.roots.order.toArray().filter((key): key is string => typeof key === "string"));
    const positions = new Map<string, number>();
    let previousBeat: StoredBlock | undefined;
    for (const segment of ordered) {
      positions.set(segment, positions.size);
      const parsed = this.segment(segment);
      if (!parsed) { problems.push({ kind: "no-segment", where: "segments/" + segment }); continue; }
      const leading: NativeSpanPlace[] = [];
      let previous: StoredBlock | undefined, firstBeat: StoredBlock | undefined, lastBeat = previousBeat;
      parsed.spans.forEach((span, index) => {
        const ref = Object.freeze({ segment, span: index }), key = span.key;
        if (key === null || seen.has(key)) { (previous?.spans ?? leading).push(ref); return; }
        seen.add(key);
        const kind = key.startsWith("h:") ? "h" : "b", id = key.slice(2);
        if (kind === "b") {
          const hasRecord = this.roots.beats.get(id) instanceof Y.Map, hasVisual = this.roots.visuals.get(id) instanceof Y.Text;
          if (!hasRecord) problems.push({ kind: "missing-beat-record", where: "beats/" + id });
          if (!hasVisual) problems.push({ kind: "missing-visual", where: "visuals/" + id });
          if (!hasRecord || !hasVisual) { (previous?.spans ?? leading).push(ref); return; }
          places.set(id, ref);
          previous = { kind, id, shown: true, spans: [ref] };
          firstBeat ??= previous;
          lastBeat = previous;
        } else {
          const record = this.roots.headings.get(id), hasName = this.roots.names.get(id) instanceof Y.Text;
          if (!(record instanceof Y.Map)) problems.push({ kind: "missing-heading-record", where: "headings/" + id });
          if (!hasName) problems.push({ kind: "missing-name", where: "names/" + id });
          if (record instanceof Y.Map && hasName) headingPlaces.set(id, ref);
          previous = { kind, id, shown: record instanceof Y.Map && hasName && record.get("removed") !== true, spans: [ref] };
        }
        blocks.push(previous);
      });
      (firstBeat?.spans ?? previousBeat?.spans ?? top).push(...leading);
      previousBeat = lastBeat;
    }
    const below: (StoredBlock | undefined)[] = [];
    let nextBeat: StoredBlock | undefined;
    for (let at = blocks.length - 1; at >= 0; at--) {
      below[at] = nextBeat;
      if (blocks[at]?.kind === "b") nextBeat = blocks[at];
    }
    if (nextBeat) nextBeat.spans.push(...top);
    previousBeat = undefined;
    for (const [at, block] of blocks.entries()) {
      if (block.kind === "b") { previousBeat = block; continue; }
      const next = blocks[at + 1];
      const owner = next?.kind === "b" ? next : previousBeat ?? below[at];
      (owner?.spans ?? top).push(...block.spans);
    }
    this.stray = null;
    if (!places.size && top.length) {
      let id = "~stray";
      while (seen.has("b:" + id) || this.roots.beats.has(id) || this.roots.visuals.has(id)) id += "~";
      this.stray = id;
    }
    const narration = new Map<string, readonly NativeSpanPlace[]>(), owners = new Map<string, string[]>();
    const assign = (id: string, spans: NativeSpanPlace[]): void => {
      if (spans.length > 1) spans.sort((a, b) => (positions.get(a.segment) ?? 0) - (positions.get(b.segment) ?? 0) || a.span - b.span);
      if ((!sameSpans(spans, this.narration.get(id)) || spans.some(ref => this.movedSegments.has(ref.segment)))
        && this.narrationContent(spans) !== this.builtNarration.get(id)) this.dirtyBeats.add(id);
      narration.set(id, Object.freeze(spans));
      for (const ref of spans) {
        const refs = owners.get(ref.segment) ?? [];
        refs[ref.span] = id;
        owners.set(ref.segment, refs);
      }
    };
    for (const block of blocks) if (block.kind === "b") assign(block.id, block.spans);
    if (this.stray !== null) assign(this.stray, top);
    for (const id of this.narration.keys()) if (!narration.has(id)) this.builtNarration.delete(id);
    this.movedSegments.clear();
    this.places = places;
    this.headingPlaces = headingPlaces;
    this.narration = narration;
    this.spanOwners = owners;
    this.structuralProblems = problems;
    this.candidates = [];
    for (const key of [...this.roots.segments.keys()].sort()) {
      if (!ordered.has(key)) this.segment(key)?.spans.forEach((_, index) => { this.candidates.push({ segment: key, span: index, reason: "no-order" }); });
    }
    this.updateOutline(this.ranked(blocks), blocks);
    this.structural = false;
  }

  private updateOutline(ranked: readonly StoredBlock[], stored: readonly StoredBlock[]): void {
    const outline: NativeOutlineEntry[] = [], groups = new Map<string, RowMember[]>(), heads = new Map<string, string>();
    const start = (id: string): RowMember[] => {
      outline.push(Object.freeze({ kind: "row", id }));
      const group = [{ id, glue: "" }];
      groups.set(id, group);
      heads.set(id, id);
      return group;
    };
    const stray = this.stray;
    if (stray !== null && this.narration.get(stray)?.some(ref => (this.spanAt(ref)?.items.length ?? 0) > 0)) start(stray);
    let previous: RowMember[] | undefined;
    for (const block of ranked) {
      const id = block.id;
      if (block.kind === "h") {
        outline.push(Object.freeze({ kind: "heading", id, name: this.nameOf(id) }));
        previous = undefined;
        continue;
      }
      const joined = joinOf(this.roots.beats.get(id)), head = previous?.[0];
      if (head && previous && joined && joined.into === previous.at(-1)?.id) {
        previous.push({ id, glue: joined.glue });
        heads.set(id, head.id);
      } else previous = start(id);
    }
    for (const id of this.groups.keys()) {
      if (groups.has(id)) continue;
      this.rowCache.delete(id); this.pendingRows.delete(id); this.pendingGone.add(id);
    }
    for (const [id, group] of groups) {
      const before = this.groups.get(id);
      if (group.length !== before?.length || group.some((member, index) => member.id !== before[index]?.id || member.glue !== before[index]?.glue)) {
        this.dirtyBeats.add(id);
      }
    }
    this.groups = groups;
    this.groupHeads = heads;
    this.removedHeadings = stored.flatMap(block => block.kind === "h" && !block.shown
      && this.roots.headings.get(block.id)?.get("removed") === true && this.roots.names.get(block.id) instanceof Y.Text ? [block.id] : []);
    if (outline.length !== this.outlineEntries.length || outline.some((entry, at) => {
      const before = this.outlineEntries[at];
      return entry.kind !== before?.kind || entry.id !== before.id || (entry.kind === "heading" && before.kind === "heading" && entry.name !== before.name);
    })) this.pendingOutline = true;
    this.outlineEntries = Object.freeze(outline);
    this.headingIndex.clear();
    outline.forEach((entry, index) => { if (entry.kind === "heading") this.headingIndex.set(entry.id, index); });
  }

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

  private narrationContent(spans: readonly NativeSpanPlace[]): string {
    const content: string[] = [];
    for (const ref of spans) {
      const span = this.spanAt(ref);
      if (span?.items.length) content.push(span.content);
    }
    return content.length === 1 ? content[0] ?? "" : JSON.stringify(content);
  }

  private beatFields(id: string, problems: Problems): Record<string, unknown> {
    const record = this.roots.beats.get(id), entries: [string, unknown][] = [];
    if (record instanceof Y.Map) {
      entries.push(...namedFields(record, BEAT_FIELDS, "beats/" + id, problems));
      if (record.has("joined") && this.groupHeads.get(id) === id) problems?.push({ kind: "join-not-read", where: "beats/" + id });
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
    const group = this.groups.get(id) ?? [], audio: NativeDeltaItem[] = [], visual: NativeDeltaItem[] = [];
    for (const member of group) {
      const refs = this.narration.get(member.id) ?? EMPTY_SPANS;
      this.builtNarration.set(member.id, this.narrationContent(refs));
      const items = refs.length === 1 && refs[0] ? this.spanAt(refs[0])?.items ?? [] : refs.flatMap(ref => this.spanAt(ref)?.items ?? []);
      if (member.glue && audio.length && items.length) audio.push({ insert: member.glue });
      audio.push(...items);
      const cell = this.roots.visuals.get(member.id);
      const delta = (cell instanceof Y.Text ? cell.toDelta() : []) as NativeDeltaItem[];
      if (visual.length && delta.length) visual.push({ insert: "\n" });
      visual.push(...delta);
    }
    const narration = nativeRunsOf(audio), visualRuns = nativeRunsOf(visual);
    return Object.freeze({
      id, members: Object.freeze(id === this.stray ? [] : group.map(member => member.id)),
      narration: frozenRuns(narration), visual: frozenRuns(visualRuns), audioText: toHtml(narration), visualText: toHtml(visualRuns),
      fields: deepFrozen(this.beatFields(id, null))
    });
  }

  outline(): readonly NativeOutlineEntry[] {
    this.sync();
    return this.outlineEntries;
  }

  row(id: string): NativeReadRow | null {
    this.sync();
    return this.rowCache.get(id) ?? null;
  }

  rows(): readonly NativeReadRow[] {
    return Object.freeze(this.outline().flatMap(entry => {
      const row = entry.kind === "row" ? this.rowCache.get(entry.id) : undefined;
      return row ? [row] : [];
    }));
  }

  beatBoundary(beat: string): NativeSpanPlace | null {
    this.sync();
    return this.places.get(beat) ?? null;
  }

  headingBoundary(heading: string, removed: boolean): NativeSpanPlace | null {
    this.sync();
    const place = this.headingPlaces.get(heading);
    return place && (this.roots.headings.get(heading)?.get("removed") === true) === removed ? place : null;
  }

  narrationSpans(beat: string): readonly NativeSpanPlace[] {
    this.sync();
    if (beat === this.stray && !this.groupHeads.has(beat)) return EMPTY_SPANS;
    const spans = this.narration.get(beat) ?? EMPTY_SPANS, own = this.places.get(beat);
    return spans.length < 2 ? spans : Object.freeze(spans.filter(ref => ref === own || this.spanAt(ref)?.items.length));
  }

  recovery(): readonly NativeRemovedHeading[] {
    this.sync();
    return Object.freeze(this.removedHeadings.map(id => Object.freeze({ id, name: this.nameOf(id) })));
  }

  unplaced(): readonly NativeUnplacedSpan[] {
    this.sync();
    return Object.freeze(this.candidates.flatMap(ref => {
      const span = this.spanAt(ref);
      return span && span.end > span.start ? [Object.freeze({ segment: ref.segment, reason: ref.reason, length: span.end - span.start })] : [];
    }));
  }

  problems(): readonly NativeReaderProblem[] {
    const entries = this.outline(), problems: NativeReaderProblem[] = [...this.structuralProblems];
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
    for (const id of this.headingPlaces.keys()) {
      const name = this.roots.names.get(id);
      if (name && name.toString().length !== name.length) problems.push({ kind: "bad-value", where: "names/" + id });
    }
    entries.forEach((entry, index) => { if (entry.kind === "heading" && entries[index + 1]?.kind !== "row") problems.push({ kind: "heading-without-row", where: "headings/" + entry.id }); });
    for (const span of this.unplaced()) problems.push({ kind: "no-order", where: "segments/" + span.segment });
    this.collect(problems);
    return deepFrozen(problems);
  }

  private cellProblems(items: readonly NativeDeltaItem[], where: string, problems: NativeReaderProblem[]): void {
    if (!items.length) return;
    const counts = nativeUnitCounts(items);
    if (counts.unknown) problems.push({ kind: "unknown-embed", where });
    if (counts.hidden > counts.unknown) problems.push({ kind: "hidden-units", where });
    if (counts.unshown) problems.push({ kind: "unshown-marks", where });
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
    return deepFrozen({ ...this.collect(null), rows, ...sections.length ? { sections } : {} });
  }
}
