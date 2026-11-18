import * as Y from "yjs";
import { toHtml } from "../../../../src/core/text/html.ts";
import type { Marks, Run } from "../../../../src/core/text/runs.ts";
import { deltaToRuns, htmlToDelta } from "../proj/richtext.ts";

export type NativeField = "audioText" | "visualText";
export type NativeAttributes = Record<string, true>;
export interface NativeDeltaItem { insert: string | Record<string, unknown>; attributes?: Record<string, unknown> }
export interface NativeBlock { id: string; kind: "b" | "h"; segment: string; start: number; end: number; delta: NativeDeltaItem[] }
export interface NativeRemoval { by: string; at: number; seen: Record<string, number> }
export interface NativeJoin { into: string; glue: string }
export interface NativeRow { id: string; audioText: string; visualText: string; fields: Record<string, unknown> }
export interface NativeTextChange { segment: string; delta: unknown[] }
export interface NativeChanges { text: NativeTextChange[]; rows: NativeRow[]; gone: string[]; order: boolean; records: string[] }
export interface NativeRecovery { beat: string; kept: string; unseen: string[] }
export interface NativeDocumentSource { rows?: unknown; sections?: unknown; comments?: unknown; people?: unknown; productionTags?: unknown; brollShots?: unknown; [key: string]: unknown }

export type NativeScheme = "name" | "act";
type KeyChoice = (wanted: NativeAttributes, beside: Record<string, unknown> | null) => NativeAttributes;

const FORMATS = ["b", "i", "u", "s", "hl", "dir", "cue"] as const;
const ACT = "\u001f";
const RECORD_ROOTS = { comments: "comments", people: "people", productionTags: "tags", brollShots: "shots" } as const;
const ROOTS = ["segments", "beats", "visuals", "comments", "people", "tags", "shots", "meta"] as const;

function bags(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
}

// why: one key per mark name, so two people adding one comment, tag or link agree on a single attribute
// and different names overlap freely; main reads names as present or absent per character in the same way
export function nativeAttributes(marks: Marks): NativeAttributes {
  const result: NativeAttributes = {};
  for (const key of FORMATS) if (marks[key]) result[key] = true;
  for (const id of marks.cmt ?? []) result[`c:${id}`] = true;
  for (const id of [marks.tag, ...(marks.innerTags ?? [])]) if (id) result[`t:${id}`] = true;
  if (marks.href) result[`l:${marks.href}`] = true;
  return result;
}

export function nativeMarkName(key: string): string {
  const at = key.indexOf(ACT);
  return at < 0 ? key : key.slice(0, at);
}

export function nativeMarks(attributes: Record<string, unknown> | undefined): Marks {
  const marks: Marks = {}, names = new Set<string>();
  for (const [key, value] of Object.entries(attributes ?? {})) if (value === true) names.add(nativeMarkName(key));
  const comments: string[] = [], tags: string[] = [], links: string[] = [];
  for (const key of names) {
    if (key.startsWith("c:")) comments.push(key.slice(2));
    else if (key.startsWith("t:")) tags.push(key.slice(2));
    else if (key.startsWith("l:")) links.push(key.slice(2));
    else if ((FORMATS as readonly string[]).includes(key)) marks[key as (typeof FORMATS)[number]] = true;
  }
  if (comments.length) marks.cmt = comments.sort();
  tags.sort(); links.sort();
  if (tags[0]) marks.tag = tags[0];
  if (tags.length > 1) marks.innerTags = tags.slice(1);
  if (links[0]) marks.href = links[0];
  return marks;
}

function embedOf(run: Run): Record<string, unknown> | null {
  if (run.atom === "broll") return { k: run.id, label: run.text };
  if (run.atom === "who") return { w: run.name };
  if (run.atom === "image") return { img: run.ref };
  if (run.atom === "video") return { video: run.href, host: run.host };
  return null;
}

function runOf(item: NativeDeltaItem): Run | null {
  const marks = nativeMarks(item.attributes);
  if (typeof item.insert === "string") return { text: item.insert, marks };
  const value = item.insert;
  if (typeof value.k === "string") return { atom: "broll", id: value.k, text: typeof value.label === "string" ? value.label : "B-roll:", marks };
  if (typeof value.w === "string") return { atom: "who", name: value.w, text: "@" + value.w, marks };
  if (typeof value.video === "string") return { atom: "video", href: value.video, host: String(value.host ?? ""), text: "", marks };
  return null;
}

export function nativeRuns(delta: readonly NativeDeltaItem[]): Run[] {
  return delta.flatMap(item => { const run = runOf(item); return run ? [run] : []; });
}

export function nativeHtml(delta: readonly NativeDeltaItem[]): string {
  return toHtml(nativeRuns(delta));
}

export function runsOfHtml(html: string, tags: unknown, comments: unknown): Run[] {
  return deltaToRuns(htmlToDelta(html, tags, comments), tags, comments);
}

function writeRuns(text: Y.Text, index: number, runs: readonly Run[], choose: KeyChoice, beside: Record<string, unknown> | null): number {
  for (const run of runs) {
    const embed = embedOf(run), attributes = choose(nativeAttributes(run.marks), beside);
    if (embed) { text.insertEmbed(index, embed, attributes); index += 1; }
    else if (run.text) { text.insert(index, run.text, attributes); index += run.text.length; }
    else continue;
    beside = attributes;
  }
  return index;
}

function attributesAt(delta: readonly NativeDeltaItem[], offset: number): Record<string, unknown> | null {
  let index = 0;
  if (offset < 0) return null;
  for (const item of delta) {
    index += typeof item.insert === "string" ? item.insert.length : 1;
    if (offset < index) return item.attributes ?? {};
  }
  return null;
}

function boundaryOf(insert: unknown): { id: string; kind: "b" | "h" } | null {
  if (!insert || typeof insert !== "object") return null;
  const value = insert as Record<string, unknown>;
  if (typeof value.b === "string") return { id: value.b, kind: "b" };
  return typeof value.h === "string" ? { id: value.h, kind: "h" } : null;
}

export class NativeReplica {
  readonly doc = new Y.Doc();
  readonly origin = { local: true };
  readonly undo: Y.UndoManager;
  private readonly views = new Map<string, NativeBlock[]>();
  private readonly home = new Map<string, string>();
  private shown = new Map<string, NativeRow>();
  private readonly groups = new Map<string, string[]>();
  private readonly owner = new Map<string, string>();
  private readonly dirtySegments = new Set<string>();
  private readonly dirtyBeats = new Set<string>();
  private readonly dirtyRecords = new Set<string>();
  private textChanges: NativeTextChange[] = [];
  private structureChanged = true;
  private readonly layout = new Map<string, string>();
  readonly scheme: NativeScheme;

  constructor(client: number, captureTimeout = 0, scheme: NativeScheme = "name") {
    this.doc.clientID = client;
    this.scheme = scheme;
    for (const name of ROOTS) this.doc.getMap(name);
    this.doc.getArray("order");
    this.segments.observeDeep(events => {
      for (const event of events) {
        const id = event.path[0];
        if (typeof id === "string") {
          this.dirtySegments.add(id); this.views.delete(id);
          if (event instanceof Y.YTextEvent) this.textChanges.push({ segment: id, delta: event.delta });
          else this.structureChanged = true;
        } else if (event instanceof Y.YMapEvent) {
          this.structureChanged = true;
          for (const key of event.keysChanged as Set<string>) { this.dirtySegments.add(key); this.views.delete(key); }
        }
      }
    });
    for (const name of ["beats", "visuals"] as const) this.doc.getMap(name).observeDeep(events => {
      for (const event of events) {
        const id = event.path[0];
        if (typeof id === "string") {
          this.dirtyBeats.add(id);
          if (event instanceof Y.YTextEvent) this.textChanges.push({ segment: `visual:${id}`, delta: event.delta });
          else if (event instanceof Y.YMapEvent && (event.keysChanged.has("joined") || event.keysChanged.has("removed"))) this.structureChanged = true;
        } else if (event instanceof Y.YMapEvent) { this.structureChanged = true; for (const key of event.keysChanged as Set<string>) this.dirtyBeats.add(key); }
      }
    });
    for (const name of ["comments", "people", "tags", "shots", "meta"] as const) this.doc.getMap(name).observeDeep(() => { this.dirtyRecords.add(name); });
    this.order.observe(() => { this.structureChanged = true; });
    this.undo = new Y.UndoManager([this.segments, this.order, this.beats, this.visuals, this.doc.getMap("comments")],
      { trackedOrigins: new Set([this.origin]), captureTimeout });
  }

  get segments(): Y.Map<Y.Map<unknown>> { return this.doc.getMap("segments"); }
  get beats(): Y.Map<Y.Map<unknown>> { return this.doc.getMap("beats"); }
  get visuals(): Y.Map<Y.Text> { return this.doc.getMap("visuals"); }
  get order(): Y.Array<string> { return this.doc.getArray("order"); }

  transact(change: () => void): void { this.doc.transact(change, this.origin); }

  // why: an act's key is its writer and that writer's clock when it began, so a reloaded copy never reuses one
  private actKey(name: string): string {
    return `${name}${ACT}${this.doc.clientID.toString(36)}.${Y.getState(this.doc.store, this.doc.clientID).toString(36)}`;
  }

  private readonly choose: KeyChoice = (wanted, beside) => {
    if (this.scheme === "name") return wanted;
    const result: NativeAttributes = {};
    for (const name of Object.keys(wanted)) {
      const kept = Object.keys(beside ?? {}).filter(key => beside?.[key] === true && nativeMarkName(key) === name);
      for (const key of kept.length ? kept : [this.actKey(name)]) result[key] = true;
    }
    return result;
  };

  private cellDelta(beat: string, field: NativeField): NativeDeltaItem[] {
    return field === "visualText" ? this.visualDelta(beat) : this.block(beat).delta;
  }

  hydrate(source: NativeDocumentSource): void {
    this.doc.transact(() => {
      const meta = this.doc.getMap("meta");
      for (const [key, value] of Object.entries(source)) {
        if (!["rows", "sections", "comments", "people", "productionTags", "brollShots"].includes(key)) meta.set(key, value);
      }
      for (const [field, root] of Object.entries(RECORD_ROOTS)) {
        const map = this.doc.getMap(root);
        bags(source[field]).forEach((record, index) => map.set(String(record.id), { ...record, rank: index }));
      }
      const sections = bags(source.sections);
      for (const row of bags(source.rows)) {
        const id = String(row.id);
        for (const heading of sections.filter(section => section.firstSceneId === id)) {
          this.addSegment(`seg-h-${String(heading.id)}`, { h: String(heading.id) }, [{ text: String(heading.name ?? ""), marks: {} }]);
        }
        this.addSegment(`seg-b-${id}`, { b: id }, runsOfHtml(String(row.audioText ?? ""), source.productionTags, source.comments));
        const beat = new Y.Map<unknown>();
        this.beats.set(id, beat);
        for (const [key, value] of Object.entries(row)) if (key !== "id" && key !== "audioText" && key !== "visualText") beat.set(key, value);
        const visual = new Y.Text();
        this.visuals.set(id, visual);
        writeRuns(visual, 0, runsOfHtml(String(row.visualText ?? ""), source.productionTags, source.comments), this.choose, null);
      }
    }, "hydration");
    this.changes();
  }

  private addSegment(id: string, head: Record<string, string>, runs: readonly Run[]): void {
    const segment = new Y.Map<unknown>(), text = new Y.Text();
    this.segments.set(id, segment);
    segment.set("head", head);
    segment.set("text", text);
    writeRuns(text, 0, runs, this.choose, null);
    this.order.push([id]);
  }

  private view(segment: string): NativeBlock[] {
    const cached = this.views.get(segment);
    if (cached) return cached;
    const record = this.segments.get(segment), text = record?.get("text"), blocks: NativeBlock[] = [];
    if (record && text instanceof Y.Text) {
      let current: NativeBlock | null = null, index = 0;
      const open = (raw: unknown, start: number): void => {
        const boundary = boundaryOf(raw);
        if (!boundary) return;
        if (current) current.end = start - 1;
        current = { ...boundary, segment, start, end: text.length, delta: [] };
        blocks.push(current);
      };
      open(record.get("head"), 0);
      for (const item of text.toDelta() as NativeDeltaItem[]) {
        if (typeof item.insert !== "string" && boundaryOf(item.insert)) open(item.insert, index + 1);
        else (current as NativeBlock | null)?.delta.push(item);
        index += typeof item.insert === "string" ? item.insert.length : 1;
      }
    }
    this.views.set(segment, blocks);
    for (const block of blocks) this.home.set(`${block.kind}:${block.id}`, segment);
    return blocks;
  }

  block(beat: string, kind: "b" | "h" = "b"): NativeBlock {
    const guess = this.home.get(`${kind}:${beat}`) ?? `seg-${kind}-${beat}`;
    const found = this.view(guess).find(block => block.id === beat && block.kind === kind);
    if (found) return found;
    for (const segment of this.order.toArray()) {
      const block = this.view(segment).find(candidate => candidate.id === beat && candidate.kind === kind);
      if (block) return block;
    }
    throw new Error(`Missing beat ${beat}`);
  }

  cell(beat: string, field: NativeField): { text: Y.Text; start: number; end: number } {
    if (field === "visualText") {
      const text = this.visuals.get(beat);
      if (!text) throw new Error(`Missing visual ${beat}`);
      return { text, start: 0, end: text.length };
    }
    const block = this.block(beat), text = this.segments.get(block.segment)?.get("text");
    if (!(text instanceof Y.Text)) throw new Error(`Missing text ${beat}`);
    return { text, start: block.start, end: block.end };
  }

  splice(beat: string, field: NativeField, from: number, to: number, insert: readonly Run[]): void {
    this.transact(() => {
      const cell = this.cell(beat, field);
      if (from < 0 || to < from || cell.start + to > cell.end) throw new Error(`Range outside ${beat}`);
      const delta = this.scheme === "act" && insert.length ? this.cellDelta(beat, field) : [];
      const beside = attributesAt(delta, from - 1) ?? attributesAt(delta, from);
      // why: inserting before deleting keeps the typed text in its gap when another copy's text lands beside it
      const after = writeRuns(cell.text, cell.start + from, insert, this.choose, beside);
      if (to > from) cell.text.delete(after, to - from);
    });
  }

  format(beat: string, field: NativeField, from: number, to: number, marks: Record<string, true | null>): void {
    this.transact(() => {
      const cell = this.cell(beat, field);
      let attributes = marks;
      if (this.scheme === "act") {
        attributes = {};
        let index = 0;
        const held = new Set<string>();
        for (const item of this.cellDelta(beat, field)) {
          const next = index + (typeof item.insert === "string" ? item.insert.length : 1);
          if (next > from && index < to) for (const [key, value] of Object.entries(item.attributes ?? {})) if (value === true) held.add(key);
          index = next;
        }
        for (const [name, value] of Object.entries(marks)) {
          if (value) attributes[this.actKey(name)] = true;
          else for (const key of held) if (nativeMarkName(key) === name) attributes[key] = null;
        }
      }
      cell.text.format(cell.start + from, to - from, attributes);
    });
  }

  split(beat: string, offset: number, created: string, fields: Record<string, unknown> = {}): void {
    this.transact(() => {
      const cell = this.cell(beat, "audioText");
      cell.text.insertEmbed(cell.start + offset, { b: created }, {});
      const record = new Y.Map<unknown>();
      this.beats.set(created, record);
      for (const [key, value] of Object.entries(fields)) record.set(key, value);
      this.visuals.set(created, new Y.Text());
    });
  }

  join(from: string, into: string, glue: string): void {
    this.transact(() => { this.beat(from).set("joined", { into, glue } satisfies NativeJoin); });
  }

  unjoin(from: string): void {
    this.transact(() => { this.beat(from).delete("joined"); });
  }

  remove(beat: string, by: string, at = 0): void {
    const seen = Object.fromEntries([...Y.decodeStateVector(Y.encodeStateVector(this.doc))].map(([client, clock]) => [String(client), clock]));
    this.transact(() => { this.beat(beat).set("removed", { by, at, seen } satisfies NativeRemoval); });
  }

  restore(beat: string): void {
    this.transact(() => { this.beat(beat).delete("removed"); });
  }

  setField(beat: string, field: string, value: unknown): void {
    this.transact(() => { this.beat(beat).set(field, value); });
  }

  beat(id: string): Y.Map<unknown> {
    const record = this.beats.get(id);
    if (!record) throw new Error(`Missing beat record ${id}`);
    return record;
  }

  removal(beat: string): NativeRemoval | null {
    const value = this.beats.get(beat)?.get("removed") as NativeRemoval | undefined;
    return value && typeof value === "object" ? value : null;
  }

  joined(beat: string): NativeJoin | null {
    const value = this.beats.get(beat)?.get("joined") as NativeJoin | undefined;
    return value && typeof value === "object" && typeof value.into === "string" ? value : null;
  }

  blocks(): NativeBlock[] {
    const seen = new Set<string>();
    return [...new Set(this.order.toArray())].flatMap(segment => this.view(segment)).filter(block => {
      const key = `${block.kind}:${block.id}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  private visualDelta(beat: string): NativeDeltaItem[] {
    return (this.visuals.get(beat)?.toDelta() ?? []) as NativeDeltaItem[];
  }

  private target(beat: string, blocks: ReadonlyMap<string, NativeBlock>): string | null {
    const passed = new Set<string>();
    let current = beat;
    for (;;) {
      if (this.removal(current)) return null;
      const join = this.joined(current);
      if (!join || !blocks.has(join.into) || passed.has(join.into)) return current;
      passed.add(current); current = join.into;
    }
  }

  private row(id: string, members: readonly NativeBlock[]): NativeRow {
    const audio: NativeDeltaItem[] = [], visual: NativeDeltaItem[] = [];
    for (const member of members) {
      const glue = member.id === id ? "" : this.joined(member.id)?.glue ?? "";
      if (glue && audio.length && member.delta.length) audio.push({ insert: glue });
      audio.push(...member.delta);
      const own = this.visualDelta(member.id);
      if (visual.length && own.length) visual.push({ insert: "\n" });
      visual.push(...own);
    }
    return { id, audioText: nativeHtml(audio), visualText: nativeHtml(visual), fields: this.beats.get(id)?.toJSON() as Record<string, unknown> ?? {} };
  }

  private project(): Map<string, NativeRow> {
    const blocks = this.blocks().filter(block => block.kind === "b"), byId = new Map(blocks.map(block => [block.id, block]));
    const members = new Map<string, NativeBlock[]>();
    this.groups.clear(); this.owner.clear();
    for (const block of blocks) {
      const target = this.target(block.id, byId);
      if (target === null) continue;
      members.set(target, [...(members.get(target) ?? []), block]);
      this.groups.set(target, [...(this.groups.get(target) ?? []), block.id]);
      this.owner.set(block.id, target);
    }
    return new Map([...members].map(([id, group]) => [id, this.row(id, group)]));
  }

  rows(): NativeRow[] {
    this.changes();
    return [...this.shown.values()];
  }

  changes(): NativeChanges {
    const text = this.textChanges, touched = new Set(this.dirtyBeats), records = [...this.dirtyRecords];
    let structural = this.structureChanged;
    for (const segment of this.dirtySegments) {
      const after = this.view(segment), signature = after.map(block => `${block.kind}:${block.id}`).join("|");
      if (this.layout.get(segment) !== signature) structural = true;
      this.layout.set(segment, signature);
      for (const block of after) touched.add(block.id);
    }
    this.textChanges = []; this.structureChanged = false;
    this.dirtySegments.clear(); this.dirtyBeats.clear(); this.dirtyRecords.clear();
    const rows: NativeRow[] = [], gone: string[] = [];
    const differs = (row: NativeRow, before: NativeRow | undefined): boolean => !before || before.audioText !== row.audioText
      || before.visualText !== row.visualText || JSON.stringify(before.fields) !== JSON.stringify(row.fields);
    if (structural) {
      const next = this.project();
      for (const [id, row] of next) if (differs(row, this.shown.get(id))) rows.push(row);
      for (const id of this.shown.keys()) if (!next.has(id)) gone.push(id);
      this.shown = next;
    } else {
      // why: no boundary, join or removal changed, so every touched beat still belongs to the row it belonged to
      const targets = new Set<string>();
      for (const id of touched) { const target = this.owner.get(id); if (target) targets.add(target); }
      for (const id of targets) {
        const row = this.row(id, (this.groups.get(id) ?? []).map(member => this.block(member)));
        if (!differs(row, this.shown.get(id))) continue;
        this.shown.set(id, row); rows.push(row);
      }
    }
    return { text, rows, gone, order: structural, records };
  }

  characterIdentity(text: Y.Text, index: number): { client: number; clock: number } {
    const item = Y.createRelativePositionFromTypeIndex(text, index, 0).item;
    if (!item) throw new Error(`No character at ${index}`);
    return { client: item.client, clock: item.clock };
  }

  recovery(): NativeRecovery[] {
    this.changes();
    const result: NativeRecovery[] = [];
    for (const block of this.blocks()) {
      const removal = block.kind === "b" ? this.removal(block.id) : null;
      if (!removal) continue;
      const text = this.segments.get(block.segment)?.get("text") as Y.Text, unseen: string[] = [];
      let index = block.start, open = false;
      for (const item of block.delta) {
        const length = typeof item.insert === "string" ? item.insert.length : 1;
        for (let offset = 0; offset < length; offset++, index++) {
          const id = this.characterIdentity(text, index), late = id.clock >= (removal.seen[String(id.client)] ?? 0);
          if (late) {
            const value = typeof item.insert === "string" ? item.insert.charAt(offset) : "￼";
            if (open) unseen[unseen.length - 1] += value; else unseen.push(value);
          }
          open = late;
        }
      }
      result.push({ beat: block.id, kept: nativeHtml(block.delta), unseen });
    }
    return result;
  }

  encode(): Uint8Array { return Y.encodeStateAsUpdate(this.doc); }

  destroy(): void { this.undo.destroy(); this.doc.destroy(); }
}

export function nativeCopy(source: NativeReplica, client: number, captureTimeout = 0): NativeReplica {
  const replica = new NativeReplica(client, captureTimeout, source.scheme);
  Y.applyUpdate(replica.doc, source.encode(), "remote");
  replica.changes();
  return replica;
}
