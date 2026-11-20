import * as Y from "yjs";
import { normalizeNativeGallery, readNativeGallery } from "./gallery.ts";
import { projectSharedJoinedFields } from "../../../core/collab/projection/joins.ts";
import type { DocumentShape } from "../../../core/document/validated.ts";
import { toHtml } from "../../../core/text/html.ts";
import type { Run } from "../../../core/text/runs.ts";
import { nativeBlockOf, nativeItemLength, nativeRunsOf, nativeUnitCounts } from "./inline.ts";
import type { NativeDeltaItem } from "./inline.ts";
import type { NativeRoots } from "./roots.ts";
import {
  NATIVE_BEAT_FIELDS, NATIVE_FIELD_PREFIX, NATIVE_GALLERY_FIELDS, NATIVE_GALLERY_KEY, decodeNativeValue, deepFrozen,
  isNativeBeatExtra, isNativeBeatField, nativeFieldKey, nativeFieldName, nativeGalleryOf, sameNativeValue
} from "./values.ts";

type CommentCell = "visualText" | "audioText";

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

export interface NativeReadBeat {
  readonly id: string;
  readonly row: string;
  readonly narration: readonly Run[];
  readonly visual: readonly Run[];
  readonly fields: Readonly<Record<string, unknown>>;
  readonly joined: Readonly<{ into: string; glue: string }> | null;
}

export type NativeUnplacedReason = "no-order";

export interface NativeUnplacedSpan {
  readonly segment: string;
  readonly reason: NativeUnplacedReason;
  readonly length: number;
}

export type NativeProblemKind = "no-text" | "hidden-units" | "unknown-embed" | "unshown-marks" | "bad-value" | "bad-key" | "heading-without-row" | "join-not-read" | "missing-beat-record" | "missing-visual" | "missing-heading-record" | "missing-name" | "no-order" | "no-segment" | "joined-field-not-shown";

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

export interface NativeRankedBlock {
  readonly kind: "beat" | "heading";
  readonly id: string;
  readonly head: string | null;
  readonly rank: string;
  readonly bound: string | null;
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
interface RankedBlock { readonly block: StoredBlock; readonly rank: string; readonly bound: string | null; readonly index: number }
type DeepListener = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void;
export type NativeWatch = <Event>(type: Y.AbstractType<Event>, listener: DeepListener) => () => void;
type Problems = NativeReaderProblem[] | null;

const META_FIELDS = ["docId", "schema", "wordsPerMinute", "targetSeconds"];
const PRIMARY_GALLERY_FIELDS = { imageRef: "imageRef", imageName: "name", imageAnnotation: "annotation", imageLinks: "links" };

function fieldBag(value: unknown): value is Readonly<Record<string, unknown>> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function galleryLink(value: unknown): value is Readonly<Record<string, unknown>> {
  return fieldBag(value) && (typeof value.href === "string" && !!value.href
    || (!value.href && typeof value.name === "string" && (value.size == null || typeof value.size === "number")));
}

function gallerySlots(fields: Readonly<Record<string, unknown>>): { readonly path: string; readonly slot: Readonly<Record<string, unknown>> }[] {
  const primary = Object.fromEntries(Object.entries(PRIMARY_GALLERY_FIELDS).flatMap(([key, name]) =>
    Object.hasOwn(fields, key) && (key !== "imageRef" || fields[key] != null) ? [[name, fields[key]]] : []));
  const slots = Object.keys(primary).length ? [{ path: "image", slot: primary }] : [];
  const more = fields.moreImages;
  if (Array.isArray(more)) more.forEach((value: unknown, index) => {
    if (fieldBag(value)) slots.push({ path: "moreImages/" + index, slot: value });
  });
  return slots;
}

function gallerySlotShown(source: Readonly<Record<string, unknown>>, output: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(source).every(([key, value]) => {
    if (key !== "links" || !Array.isArray(value)) return sameNativeValue(value, output[key]);
    const links = Array.isArray(output.links) ? output.links : [];
    return value.every((link: unknown) => fieldBag(link) && links.some((shown: unknown) => fieldBag(shown)
      && Object.entries(link).every(([name, field]) => sameNativeValue(field, shown[name]))));
  });
}

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

function beatExtraEntries(record: Y.Map<unknown>, where: string, problems: Problems,
  gallery?: Readonly<Record<string, unknown>>): [string, unknown][] {
  const entries: [string, unknown][] = [];
  if (gallery) for (const entry of Object.entries(gallery)) entries.push(entry);
  record.forEach((stored, key) => {
    if (key === "rank" || key === "joined" || isNativeBeatField(key)) return;
    if (key === NATIVE_GALLERY_KEY) {
      if (gallery) return;
      const value = readNativeGallery(stored);
      if (value) for (const entry of Object.entries(value)) entries.push(entry);
      else problems?.push({ kind: "bad-value", where: where + "/" + key });
      return;
    }
    const name = nativeFieldName(key);
    if (name === null || !isNativeBeatExtra(name) || nativeFieldKey(name) !== key) {
      problems?.push({ kind: "bad-key", where: where + "/" + key });
      return;
    }
    const value = decodeNativeValue(stored);
    if (value) entries.push([name, value.value]);
    else problems?.push({ kind: "bad-value", where: where + "/" + key });
  });
  if (entries.length > 1) entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return entries;
}

function fileFieldEntries(record: Y.Map<unknown>, where: string, problems: Problems): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key of [...record.keys()].sort()) {
    if (!key.startsWith(NATIVE_FIELD_PREFIX)) continue;
    const name = nativeFieldName(key);
    if (name === null) { problems?.push({ kind: "bad-key", where: where + "/" + key }); continue; }
    const value = decoded(record, key, where, problems);
    if (value) entries.push([name, value.value]);
  }
  return entries;
}

function fileFields(record: Y.Map<unknown>, where: string, problems: Problems): Record<string, unknown> {
  return Object.fromEntries(fileFieldEntries(record, where, problems));
}

function namedFields(record: Y.Map<unknown>, names: readonly string[], where: string, problems: Problems): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const name of names) { const value = decoded(record, name, where, problems); if (value) entries.push([name, value.value]); }
  return entries;
}

function metaFields(record: Y.Map<unknown>, problems: Problems): Record<string, unknown> {
  const entries = namedFields(record, META_FIELDS, "meta", problems), extra = decoded(record, "extra", "meta", problems);
  if (extra) {
    if (fieldBag(extra.value)) {
      for (const entry of Object.entries(extra.value)) entries.push(entry);
    }
    else problems?.push({ kind: "bad-value", where: "meta/extra" });
  }
  return Object.fromEntries(entries);
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
  private readonly anchorsByRow = new Map<string, Set<string>>();
  private readonly rowsByAnchor = new Map<string, Map<string, CommentCell>>();
  private narration = new Map<string, readonly NativeSpanPlace[]>();
  private readonly builtNarration = new Map<string, string>();
  private readonly movedSegments = new Set<string>();
  private spanOwners = new Map<string, string[]>();
  private groups = new Map<string, RowMember[]>();
  private groupHeads = new Map<string, string>();
  private storedBlocks: readonly StoredBlock[] = [];
  private rankedBlocks: readonly RankedBlock[] = [];
  private removedHeadings: readonly string[] = [];
  private structuralProblems: NativeReaderProblem[] = [];
  private stray: string | null = null;
  private readonly pendingRows = new Set<string>();
  private readonly pendingGone = new Set<string>();
  private noticeBeats: Set<string> | null = null;
  private noticeLayout = false;
  private readonly pendingHeadings = new Set<string>();
  private pendingOutline = false;
  private readonly detach: (() => void)[] = [];
  private parses = 0;
  private rowsBuilt = 0;
  private structures = 0;

  constructor(roots: NativeRoots, watch: NativeWatch) {
    this.roots = roots;
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

  refreshNotice(): { beats: readonly string[]; layout: boolean } {
    this.noticeBeats ??= new Set();
    this.refresh();
    const changes = { beats: [...this.noticeBeats], layout: this.noticeLayout };
    this.noticeBeats.clear();
    this.noticeLayout = false;
    return changes;
  }

  private sync(): void {
    if (this.closed) throw new Error("The script reader is closed");
    if (!this.structural && !this.dirtySegments.size && !this.dirtyBeats.size && !this.dirtyHeadings.size) return;
    this.reparse();
    if (this.structural) this.restructure();
    const dirtyRows = new Set<string>();
    for (const beat of this.dirtyBeats) {
      this.noticeBeats?.add(beat);
      const head = this.groupHeads.get(beat);
      if (head !== undefined) dirtyRows.add(head);
    }
    for (const id of dirtyRows) {
      const previous = this.rowCache.get(id), row = this.buildRow(id);
      this.rowCache.set(id, row);
      if (!previous || row.audioText !== previous.audioText || row.visualText !== previous.visualText) this.indexCommentAnchors(row);
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

  private layout(ordered: ReadonlySet<string>, segmentAt: (key: string) => ParsedSegment | null, newHeading?: string) {
    const seen = new Set<string>(), blocks: StoredBlock[] = [], places = new Map<string, NativeSpanPlace>();
    const top: NativeSpanPlace[] = [], problems: NativeReaderProblem[] = [], headingPlaces = new Map<string, NativeSpanPlace>();
    const positions = new Map<string, number>();
    let previousBeat: StoredBlock | undefined;
    for (const segment of ordered) {
      positions.set(segment, positions.size);
      const parsed = segmentAt(segment);
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
        } else if (id === newHeading) {
          previous = { kind, id, shown: true, spans: [ref] };
        } else {
          const record = this.roots.headings.get(id), hasName = this.roots.names.get(id) instanceof Y.Text;
          if (!(record instanceof Y.Map)) problems.push({ kind: "missing-heading-record", where: "headings/" + id });
          if (!hasName) problems.push({ kind: "missing-name", where: "names/" + id });
          if (record instanceof Y.Map && hasName) headingPlaces.set(id, ref);
          previous = { kind, id, shown: record instanceof Y.Map && hasName && record.get("removed") !== true, spans: [ref] };
        }
        blocks.push(previous);
      });
      const destination = firstBeat?.spans ?? previousBeat?.spans ?? top;
      for (const span of leading) destination.push(span);
      previousBeat = lastBeat;
    }
    const below: (StoredBlock | undefined)[] = [];
    let nextBeat: StoredBlock | undefined;
    for (let at = blocks.length - 1; at >= 0; at--) {
      below[at] = nextBeat;
      if (blocks[at]?.kind === "b") nextBeat = blocks[at];
    }
    if (nextBeat) for (const span of top) nextBeat.spans.push(span);
    previousBeat = undefined;
    for (const [at, block] of blocks.entries()) {
      if (block.kind === "b") { previousBeat = block; continue; }
      const next = blocks[at + 1];
      const owner = next?.kind === "b" ? next : previousBeat ?? below[at];
      const destination = owner?.spans ?? top;
      for (const span of block.spans) destination.push(span);
    }
    return { seen, blocks, places, top, problems, headingPlaces, positions };
  }

  private restructure(): void {
    this.structures++;
    const ordered = new Set(this.roots.order.toArray().filter((key): key is string => typeof key === "string"));
    const { seen, blocks, places, top, problems, headingPlaces, positions } = this.layout(ordered, key => this.segment(key));
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
    this.storedBlocks = blocks;
    this.rankedBlocks = this.ranked(blocks);
    this.updateOutline(this.rankedBlocks, blocks);
    this.structural = false;
  }

  private updateOutline(ranked: readonly RankedBlock[], stored: readonly StoredBlock[]): void {
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
    for (const { block } of ranked) {
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
      this.dropCommentAnchors(id);
      this.rowCache.delete(id); this.pendingRows.delete(id); this.pendingGone.add(id);
    }
    for (const [id, group] of groups) {
      const before = this.groups.get(id);
      if (group.length !== before?.length || group.some((member, index) => member.id !== before[index]?.id || member.glue !== before[index]?.glue)) {
        this.dirtyBeats.add(id);
      }
    }
    if (this.noticeBeats) {
      this.noticeLayout = true;
      for (const [id, head] of this.groupHeads) if (heads.get(id) !== head) this.noticeBeats.add(id);
      for (const id of heads.keys()) if (!this.groupHeads.has(id)) this.noticeBeats.add(id);
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

  private ranked(blocks: readonly StoredBlock[], newHeading?: { readonly id: string; readonly rank: string }, overrides?: ReadonlyMap<string, string>): RankedBlock[] {
    let previous: string | null = null, bound: string | null = null;
    const keyed = blocks.map((block, index) => {
      const record = block.kind === "h" ? this.roots.headings.get(block.id) : this.roots.beats.get(block.id);
      const override = overrides?.get(block.kind + ":" + block.id);
      const rank = override !== undefined ? override : block.kind === "h" && block.id === newHeading?.id ? newHeading.rank : rankOf(record);
      if (rank !== null) { previous = rank; bound = rank; }
      else if (record instanceof Y.Map && record.has("rank")) bound = "";
      return { block, rank: previous ?? "", bound, index };
    });
    keyed.sort((left, right) => left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : left.index - right.index);
    return keyed.filter(({ block }) => block.shown);
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

  private beatFields(id: string, problems: Problems, gallery?: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const record = this.roots.beats.get(id), entries: [string, unknown][] = [];
    if (record instanceof Y.Map) {
      const where = "beats/" + id;
      for (const name of NATIVE_BEAT_FIELDS) {
        const value = decoded(record, name, where, problems);
        if (value) entries.push([name, value.value]);
      }
      for (const entry of beatExtraEntries(record, where, problems, gallery)) entries.push(entry);
      if (problems && record.has("joined") && this.groupHeads.get(id) === id) problems.push({ kind: "join-not-read", where });
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

  private rowFields(id: string, problems: Problems, replacement?: { beat: string; gallery: Readonly<Record<string, unknown>> }): Record<string, unknown> {
    const root = this.beatFields(id, null, replacement?.beat === id ? replacement.gallery : undefined), group = this.groups.get(id);
    if (!group || group.length < 2) return root;
    const members = group.map(member => ({
      id: member.id, fields: member.id === id ? root : this.beatFields(member.id, null, replacement?.beat === member.id ? replacement.gallery : undefined)
    }));
    const galleries = members.map(member => gallerySlots(member.fields));
    const records = galleries.flatMap((slots, member) => slots.map(({ slot }, index) => {
      const { links, ...picture } = slot;
      return { key: String(index).padStart(10, "0"), fields: {
        beat: members[member]?.id, picture, links: Array.isArray(links) ? links.filter(galleryLink).map(fields => ({ fields })) : []
      } };
    }));
    const { row: projected, overflow } = projectSharedJoinedFields(root, members.map(member => ({ ...member.fields, id: member.id })), records);
    // why: previewing a write checks whether the assembled gallery would change on reload; reading keeps only what
    // reload keeps
    const row = replacement ? projected : normalizeNativeGallery(projected);
    if (problems) {
      const shown = gallerySlots(row).map(({ slot }) => slot);
      members.forEach((member, index) => {
        const where = "beats/" + member.id + "/";
        for (const [key, value] of Object.entries(member.fields)) {
          if (!NATIVE_GALLERY_FIELDS.has(key) && JSON.stringify(value) !== JSON.stringify(row[key])) problems.push({ kind: "joined-field-not-shown", where: where + key });
        }
        const more = member.fields.moreImages;
        if (more !== undefined && (!Array.isArray(more) || more.some(value => !fieldBag(value)))) {
          problems.push({ kind: "joined-field-not-shown", where: where + "moreImages" });
        }
        for (const { path, slot } of galleries[index] ?? []) {
          if (!shown.some(output => gallerySlotShown(slot, output)) || overflow.some(entry => entry.beat === member.id && gallerySlotShown(slot, entry.slot))) {
            problems.push({ kind: "joined-field-not-shown", where: where + path });
          }
        }
      });
    }
    return row;
  }

  private buildRow(id: string): NativeReadRow {
    this.rowsBuilt++;
    const group = this.groups.get(id) ?? [], audio: NativeDeltaItem[] = [], visual: NativeDeltaItem[] = [];
    for (const member of group) {
      const refs = this.narration.get(member.id) ?? EMPTY_SPANS;
      this.builtNarration.set(member.id, this.narrationContent(refs));
      const items = this.narrationItems(refs);
      if (member.glue && audio.length && items.length) audio.push({ insert: member.glue });
      for (const item of items) audio.push(item);
      const cell = this.roots.visuals.get(member.id);
      const delta = (cell instanceof Y.Text ? cell.toDelta() : []) as NativeDeltaItem[];
      if (visual.length && delta.length) visual.push({ insert: "\n" });
      for (const item of delta) visual.push(item);
    }
    const narration = nativeRunsOf(audio), visualRuns = nativeRunsOf(visual);
    return Object.freeze({
      id, members: Object.freeze(id === this.stray ? [] : group.map(member => member.id)),
      narration: frozenRuns(narration), visual: frozenRuns(visualRuns), audioText: toHtml(narration), visualText: toHtml(visualRuns),
      fields: deepFrozen(this.rowFields(id, null))
    });
  }

  private narrationItems(refs: readonly NativeSpanPlace[]): readonly NativeDeltaItem[] {
    return refs.length === 1 && refs[0] ? this.spanAt(refs[0])?.items ?? [] : refs.flatMap(ref => this.spanAt(ref)?.items ?? []);
  }

  noticeBeat(id: string): NativeReadBeat | null {
    this.sync();
    const row = this.groupHeads.get(id), cell = this.roots.visuals.get(id);
    if (row === undefined || id === this.stray) return null;
    const single = this.groups.get(row)?.length === 1 ? this.rowCache.get(row) : undefined;
    return Object.freeze({
      id, row,
      narration: single?.narration ?? frozenRuns(nativeRunsOf(this.narrationItems(this.narration.get(id) ?? EMPTY_SPANS))),
      visual: single?.visual ?? frozenRuns(nativeRunsOf((cell?.toDelta() ?? []) as NativeDeltaItem[])),
      fields: single?.fields ?? deepFrozen(this.beatFields(id, null)),
      joined: deepFrozen(joinOf(this.roots.beats.get(id)))
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

  private dropCommentAnchors(id: string): void {
    for (const anchor of this.anchorsByRow.get(id) ?? []) {
      const rows = this.rowsByAnchor.get(anchor);
      rows?.delete(id);
      if (!rows?.size) this.rowsByAnchor.delete(anchor);
    }
    this.anchorsByRow.delete(id);
  }

  // why: the file reattaches an anchor to its first projected row and checks the visual cell before narration
  private indexCommentAnchors(row: NativeReadRow): void {
    this.dropCommentAnchors(row.id);
    const anchors = new Set<string>();
    for (const [field, runs] of [["visualText", row.visual], ["audioText", row.narration]] as const) {
      if (!row[field].includes("cmt-anchor")) continue;
      for (const run of runs) for (const anchor of run.marks.cmt ?? []) {
        if (anchors.has(anchor)) continue;
        anchors.add(anchor);
        const rows = this.rowsByAnchor.get(anchor) ?? new Map<string, CommentCell>();
        rows.set(row.id, field);
        this.rowsByAnchor.set(anchor, rows);
      }
    }
    if (anchors.size) this.anchorsByRow.set(row.id, anchors);
  }

  commentAnchor(id: string): { readonly rowId: string; readonly field: CommentCell } | null {
    this.sync();
    const rows = this.rowsByAnchor.get(id);
    if (!rows) return null;
    const first = rows.size === 1 ? rows.keys().next().value : this.outlineEntries.find(entry => entry.kind === "row" && rows.has(entry.id))?.id;
    const field = first === undefined ? undefined : rows.get(first);
    return first !== undefined && field !== undefined ? Object.freeze({ rowId: first, field }) : null;
  }

  beatBoundary(beat: string): NativeSpanPlace | null {
    this.sync();
    return this.places.get(beat) ?? null;
  }

  previewJoinedGallery(beat: string, gallery: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
    this.sync();
    const head = this.groupHeads.get(beat);
    if (head === undefined || (this.groups.get(head)?.length ?? 0) < 2) return null;
    return nativeGalleryOf(this.rowFields(head, null, { beat, gallery }));
  }

  rankedOrder(): readonly NativeRankedBlock[] {
    this.sync();
    return Object.freeze(this.rankedBlocks.map(({ block, rank, bound }) => Object.freeze({
      kind: block.kind === "h" ? "heading" as const : "beat" as const,
      id: block.id,
      head: block.kind === "b" ? this.groupHeads.get(block.id) ?? null : null,
      rank,
      bound
    })));
  }

  previewMoveOrder(ranks: ReadonlyMap<string, string>): readonly { readonly kind: "beat" | "heading"; readonly id: string }[] {
    this.sync();
    return Object.freeze(this.ranked(this.storedBlocks, undefined, ranks).map(({ block }) => Object.freeze({
      kind: block.kind === "h" ? "heading" as const : "beat" as const,
      id: block.id
    })));
  }

  ranksAboveBeat(beat: string): { readonly before: string | null; readonly after: string | null } | null {
    this.sync();
    if (this.groupHeads.get(beat) !== beat) return null;
    const index = this.rankedBlocks.findIndex(({ block }) => block.kind === "b" && block.id === beat);
    const target = this.rankedBlocks[index];
    if (!target) return null;
    const left = this.rankedBlocks[index - 1], before = left?.bound ?? null, after = target.bound;
    // why: a first rankless beat inherits the new heading's rank, beneath it and before the next ranked block
    if (!left && after === null) return Object.freeze({ before: null, after: this.rankedBlocks.find(entry => entry.bound !== null)?.bound ?? null });
    return Object.freeze({ before, after: after ?? "" });
  }

  headingPlacement(beat: string, id: string, rank: string): { readonly segment: string; readonly at: number | null } | null {
    this.sync();
    const own = this.places.get(beat), first = this.narrationSpans(beat)[0];
    if (!own || !first) return null;
    const boundary = this.previewHeading(beat, id, rank, own, false);
    return boundary ?? (first === own ? null : this.previewHeading(beat, id, rank, first, true));
  }

  // why: a marker can redirect recovered text even when it leaves every narration item untouched
  private previewHeading(beat: string, id: string, rank: string, place: NativeSpanPlace, prefix: boolean) {
    const segment = this.parsed.get(place.segment), span = segment?.spans[place.span];
    if (!segment || !span) return null;
    const key = "h:" + id, standalone = !prefix && place.span === 0;
    const marker: ParsedSpan = prefix ? { ...span, key } : { key, start: 0, end: 0, items: [], content: "[]" };
    const ordered = new Set(this.roots.order.toArray().flatMap(entry => entry === place.segment && standalone ? [key, entry] : [entry]));
    const proposed = [...segment.spans];
    if (prefix) proposed.splice(place.span, 1, { ...span, end: span.start, items: [], content: "[]" }, marker);
    else if (!standalone) proposed.splice(place.span, 0, marker);
    const segmentAt = (entry: string): ParsedSegment | null => {
      if (standalone && entry === key) return { hasText: true, spans: [marker] };
      if (entry === place.segment) return { hasText: true, spans: proposed };
      return this.parsed.get(entry) ?? null;
    };
    const { blocks } = this.layout(ordered, segmentAt, id), ranked = this.ranked(blocks, { id, rank });
    const index = ranked.findIndex(({ block }) => block.kind === "h" && block.id === id);
    const target = ranked[index + 1]?.block;
    if (index < 0 || target?.kind !== "b" || target.id !== beat) return null;
    ranked.splice(index, 1);
    if (ranked.length !== this.rankedBlocks.length || ranked.some(({ block }, at) => {
      const prior = this.rankedBlocks[at]?.block;
      return prior?.id !== block.id || prior.kind !== block.kind;
    })) return null;

    const owners = new Map<ParsedSpan, string>();
    for (const block of blocks) if (block.kind === "b") {
      for (const ref of block.spans) {
        const item = segmentAt(ref.segment)?.spans[ref.span];
        if (item?.items.length) owners.set(prefix && item === marker ? span : item, block.id);
      }
    }
    for (const [segment, previous] of this.spanOwners) {
      const spans = this.parsed.get(segment)?.spans ?? [];
      if (spans.some((item, at) => item.items.length && owners.get(item) !== previous[at])) return null;
    }
    return Object.freeze({ segment: place.segment, at: standalone ? null : prefix ? span.start : span.start - 1 });
  }

  hasHeadingMarker(id: string): boolean {
    return this.hasMarker("h:" + id);
  }

  hasBeatMarker(id: string): boolean {
    return this.hasMarker("b:" + id);
  }

  private hasMarker(key: string): boolean {
    this.sync();
    for (const { spans } of this.parsed.values()) if (spans.some(span => span.key === key)) return true;
    return false;
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
    for (const id of this.roots.beats.keys()) if (!this.places.has(id)) this.beatFields(id, problems);
    for (const [id, group] of this.groups) if (group.length > 1) this.rowFields(id, problems);
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
    const fields = metaFields(meta, problems);
    const replies = new Map<string, Record<string, unknown>[]>();
    for (const [key, record] of byRank(this.roots.replies)) {
      if (record.get("removed") === true) continue;
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
      byRank(root).filter(([, record]) => name !== "comments" || record.get("removed") !== true)
        .map(([id, record]) => ({ ...fileFields(record, name + "/" + id, problems), id }));
    return {
      ...fields,
      title: title instanceof Y.Text ? title.toString() : "",
      docId: typeof fields.docId === "string" ? fields.docId : "",
      rev: typeof fields.rev === "number" ? fields.rev : 0,
      schema: typeof fields.schema === "number" ? fields.schema : 0,
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

export function readNativeOnce<T>(roots: NativeRoots, read: (reader: NativeScriptReader) => T): T {
  const reader = new NativeScriptReader(roots, () => () => undefined);
  try { return read(reader); } finally { reader.close(); }
}
