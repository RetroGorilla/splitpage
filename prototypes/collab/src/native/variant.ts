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
export interface NativePart { beat: string | null; length: number }
export interface NativeRow {
  id: string; audioText: string; visualText: string; fields: Record<string, unknown>; audio: NativeDeltaItem[]; visual: NativeDeltaItem[];
  members: string[]; parts: { audio: NativePart[]; visual: NativePart[] };
}
export interface NativeTextChange { segment: string; delta: unknown[] }
export interface NativeChanges { text: NativeTextChange[]; rows: NativeRow[]; gone: string[]; order: boolean; records: string[] }
export type NativeRecoveryReason = "removed" | "unplaced" | "loop";
export type NativeReading = "follow" | "contiguous";
export interface NativeRecovery {
  beat: string; kept: string; unseen: string[]; visual: string; reason: NativeRecoveryReason; members: string[];
  audio: NativeDeltaItem[]; visualItems: NativeDeltaItem[];
}
interface NativeHead { id: string; hidden: boolean }
export interface NativeDocumentSource { rows?: unknown; sections?: unknown; comments?: unknown; people?: unknown; productionTags?: unknown; brollShots?: unknown; [key: string]: unknown }

export type NativeScheme = "name" | "act" | "chosen";
export type NativeUndoOutcome = "undone" | "used-up" | "empty";
interface NativeFlagNote { beat: string; key: string; wrote: string | null; before: unknown; after: unknown }
interface NativeActNote { text: Y.Text; names: string[]; seen: string[]; minted: string[]; from: Y.RelativePosition; to: Y.RelativePosition }
interface NativeNote { flag?: NativeFlagNote; act?: NativeActNote }
type NativeStackItem = Y.UndoManager["undoStack"][number];

// why: two writes of one flag are the same change when they mean the same, whoever made them and whenever
function flagMeaning(key: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (key === "removed") return "removed";
  if (key === "joined" && value && typeof value === "object") return JSON.stringify([(value as NativeJoin).into, (value as NativeJoin).glue]);
  return JSON.stringify(value);
}
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

export function usesActionKey(scheme: NativeScheme, name: string): boolean {
  return scheme === "act" || (scheme === "chosen" && name.startsWith("t:"));
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

function runEnd(delta: readonly NativeDeltaItem[], key: string, at: number): number {
  let index = 0, end = at;
  for (const item of delta) {
    const next = index + (typeof item.insert === "string" ? item.insert.length : 1);
    if (next > at) { if (item.attributes?.[key] !== true) break; end = next; }
    index = next;
  }
  return end;
}

function deltaLength(delta: readonly NativeDeltaItem[]): number {
  return delta.reduce((sum, item) => sum + (typeof item.insert === "string" ? item.insert.length : 1), 0);
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
  private hiddenGroups = new Map<string, string[]>();
  private loops: string[] = [];
  private readonly dirtySegments = new Set<string>();
  private readonly dirtyBeats = new Set<string>();
  private readonly dirtyRecords = new Set<string>();
  private textChanges: NativeTextChange[] = [];
  private structureChanged = true;
  private readonly layout = new Map<string, string>();
  private pending: NativeNote[] = [];
  private depth = 0;
  keepCreated = true;
  private readingRule: NativeReading = "follow";
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
    // why: the library undoes a creation by deleting the created type with all that anyone wrote in it since; the
    // filter keeps a beat's record and visual cell whatever transaction made them, so only their placement is undone
    const deleteFilter = (item: Y.Item): boolean =>
      !(this.keepCreated && item.content instanceof Y.ContentType && (item.parent === this.beats || item.parent === this.visuals));
    this.undo = new Y.UndoManager([this.segments, this.order, this.beats, this.visuals, this.doc.getMap("comments")],
      { trackedOrigins: new Set([this.origin]), captureTimeout, deleteFilter });
    this.undo.on("stack-item-added", (event: { stackItem: { meta: Map<unknown, unknown> } }) => {
      if (this.pending.length) event.stackItem.meta.set("notes", this.pending);
      this.pending = [];
    });
  }

  get reading(): NativeReading { return this.readingRule; }
  set reading(value: NativeReading) { this.readingRule = value; this.structureChanged = true; }

  get segments(): Y.Map<Y.Map<unknown>> { return this.doc.getMap("segments"); }
  get beats(): Y.Map<Y.Map<unknown>> { return this.doc.getMap("beats"); }
  get visuals(): Y.Map<Y.Text> { return this.doc.getMap("visuals"); }
  get order(): Y.Array<string> { return this.doc.getArray("order"); }

  // why: a compound command is one entry; the notes of its parts wait for that entry, which the library adds when
  // the outermost transaction ends, and notes of a command that changed nothing are dropped there
  transact(change: () => void): void {
    this.depth++;
    try { this.doc.transact(change, this.origin); } finally { if (--this.depth === 0) this.pending = []; }
  }

  // why: an act's key is its writer and that writer's clock when it began, so a reloaded copy never reuses one
  private actKey(name: string): string {
    const clock = Y.decodeStateVector(Y.encodeStateVector(this.doc)).get(this.doc.clientID) ?? 0;
    return `${name}${ACT}${this.doc.clientID.toString(36)}.${clock.toString(36)}`;
  }

  // why: turning a key off as far as its run goes and giving what follows the gap a new key writes no marker that turns
  // the old key on again; such a marker would format everything after it once the run's own end is removed elsewhere
  private retire(text: Y.Text, key: string, from: number, to: number): void {
    const tail = Math.max(to, runEnd(text.toDelta() as NativeDeltaItem[], key, to));
    if (tail > from) text.format(from, tail - from, { [key]: null });
    if (tail > to) text.format(to, tail - to, { [`${key.split(ACT).slice(0, 2).join(ACT)}${ACT}${this.actKey("").slice(1)}`]: true });
  }

  private readonly choose: KeyChoice = (wanted, beside) => {
    if (this.scheme === "name") return wanted;
    const result: NativeAttributes = {};
    for (const name of Object.keys(wanted)) {
      if (!usesActionKey(this.scheme, name)) { result[name] = true; continue; }
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
        bags(source[field]).forEach((record, index) => map.set(String(record.id), new Y.Map(Object.entries({ ...record, rank: index }))));
      }
      const sections = bags(source.sections);
      for (const row of bags(source.rows)) {
        const id = String(row.id);
        for (const heading of sections.filter(section => section.firstSceneId === id)) {
          const headingId = String(heading.id), record = new Y.Map<unknown>();
          this.doc.getMap("headings").set(headingId, record);
          for (const [key, value] of Object.entries(heading)) {
            if (key !== "id" && key !== "name" && key !== "firstSceneId") record.set(key, value);
          }
          this.addSegment(`seg-h-${headingId}`, { h: headingId }, [{ text: String(heading.name ?? ""), marks: {} }]);
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

  protected addSegment(id: string, head: Record<string, string>, runs: readonly Run[], at = this.order.length): void {
    const segment = new Y.Map<unknown>(), text = new Y.Text();
    this.segments.set(id, segment);
    segment.set("head", head);
    segment.set("text", text);
    writeRuns(text, 0, runs, this.choose, null);
    this.order.insert(at, [id]);
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
      const act = this.scheme !== "name" && insert.length > 0;
      const left = !act ? null : from > 0 ? attributesAt(this.cellDelta(beat, field), from - 1)
        : cell.start > 0 ? attributesAt(cell.text.toDelta() as NativeDeltaItem[], cell.start - 1) : null;
      // why: inserting before deleting keeps the typed text in its gap when another copy's text lands beside it
      const after = act ? this.typeAct(cell.text, cell.start + from, insert, left) : writeRuns(cell.text, cell.start + from, insert, this.choose, null);
      if (to > from) cell.text.delete(after, to - from);
    });
  }

  // why: text typed with marks that differ from those on its left makes the library write a marker that turns the left's
  // formatting on again after it. Typed with the left's keys and then changed, it writes none: see retire
  private typeAct(text: Y.Text, at: number, runs: readonly Run[], left: Record<string, unknown> | null): number {
    let index = at, beside = Object.keys(left ?? {}).filter(key => left?.[key] === true);
    beside = beside.filter(key => usesActionKey(this.scheme, nativeMarkName(key)));
    for (const run of runs) {
      const embed = embedOf(run), length = embed ? 1 : run.text.length, names = Object.keys(nativeAttributes(run.marks));
      if (!length) continue;
      const plain = names.filter(name => !usesActionKey(this.scheme, name));
      const action = names.filter(name => usesActionKey(this.scheme, name));
      const taken = Object.fromEntries([...beside, ...plain].map(key => [key, true]));
      if (embed) text.insertEmbed(index, embed, taken); else text.insert(index, run.text, taken);
      const kept = beside.filter(key => names.includes(nativeMarkName(key)));
      for (const key of beside) if (!kept.includes(key)) this.retire(text, key, index, index + length);
      const fresh = Object.fromEntries(action.filter(name => this.scheme === "chosen" || !kept.some(key => nativeMarkName(key) === name)).map(name => [this.actKey(name), true]));
      if (Object.keys(fresh).length) text.format(index, length, fresh);
      beside = [...kept, ...Object.keys(fresh)];
      index += length;
    }
    return index;
  }

  format(beat: string, field: NativeField, from: number, to: number, marks: Record<string, true | null>): void {
    this.undo.stopCapturing();
    this.transact(() => {
      const cell = this.cell(beat, field), held = new Set<string>();
      const attributes: Record<string, true | null> = {}, minted: string[] = [];
      let index = 0;
      for (const item of this.cellDelta(beat, field)) {
        const next = index + (typeof item.insert === "string" ? item.insert.length : 1);
        if (next > from && index < to) for (const [key, value] of Object.entries(item.attributes ?? {})) if (value === true) held.add(key);
        index = next;
      }
      for (const [name, value] of Object.entries(marks)) {
        if (!usesActionKey(this.scheme, name)) attributes[name] = value;
        else if (value) { const key = this.actKey(name); attributes[key] = true; minted.push(key); }
        else for (const key of held) if (nativeMarkName(key) === name) this.retire(cell.text, key, cell.start + from, cell.start + to);
      }
      this.pending.push({ act: { text: cell.text, names: Object.keys(marks).filter(name => marks[name]), seen: [...held], minted,
        from: Y.createRelativePositionFromTypeIndex(cell.text, cell.start + from, 0), to: Y.createRelativePositionFromTypeIndex(cell.text, cell.start + to, -1) } });
      if (Object.keys(attributes).length) cell.text.format(cell.start + from, to - from, attributes);
    });
    this.undo.stopCapturing();
  }

  private flagged(beat: string, key: string, write: (record: Y.Map<unknown>) => void): void {
    const record = this.beat(beat), before = record.get(key);
    this.undo.stopCapturing();
    this.transact(() => {
      write(record);
      const after = record.get(key);
      this.pending.push({ flag: { beat, key, wrote: flagMeaning(key, after), before, after } });
    });
    this.undo.stopCapturing();
  }

  private alone(stack: unknown[], run: () => boolean): boolean {
    const older = stack.splice(0, stack.length - 1);
    try { return run(); } finally { stack.unshift(...older); }
  }

  // why: plain undo() goes on to an older step when the top one changes nothing, and reverses a flag only when this
  // copy's write is the one that stands; this step takes one entry, and takes a change back by what it means
  undoStep(): NativeUndoOutcome { return this.step(this.undo.undoStack, this.undo.redoStack, () => this.undo.undo() !== null, true); }

  redoStep(): NativeUndoOutcome { return this.step(this.undo.redoStack, this.undo.undoStack, () => this.undo.redo() !== null, false); }

  private step(from: NativeStackItem[], to: NativeStackItem[], run: () => boolean, back: boolean): NativeUndoOutcome {
    const top = from.at(-1);
    if (!top) return "empty";
    const notes = (top.meta.get("notes") ?? []) as NativeNote[], grown = to.length;
    const flags = notes.flatMap(note => note.flag ? [note.flag] : []), acts = notes.flatMap(note => note.act ? [note.act] : []);
    const value = (flag: NativeFlagNote): unknown => this.beats.get(flag.beat)?.get(flag.key);
    // why: a flag is this entry's to change only while it still holds what the entry's last move left there
    const standing = flags.filter(flag => flagMeaning(flag.key, value(flag)) === (back ? flag.wrote : flagMeaning(flag.key, flag.before)));
    if (flags.length && flags.length === notes.length && !standing.length) { from.pop(); return "used-up"; }
    let done = false, forced = false;
    this.pending = notes;
    // why: an entry the guard moved across itself holds nothing the library can replay
    if (top.meta.get("carrier") === true) from.pop(); else done = this.alone(from, run);
    this.pending = [];
    for (const flag of standing) {
      const record = this.beats.get(flag.beat), target = back ? flag.before : flag.after;
      // why: an identical write by someone else still stands, or the library declined to put the value back
      if (!record || flagMeaning(flag.key, record.get(flag.key)) === flagMeaning(flag.key, target)) continue;
      this.doc.transact(() => { if (target === undefined) record.delete(flag.key); else record.set(flag.key, target); }, "takeback");
      forced = true;
    }
    for (const act of acts) if (back ? this.takeBack(act) : this.putBack(act)) forced = true;
    if (!done && !forced) return "used-up";
    // why: a move the library did not make left no entry on the other stack, so the entry itself goes there
    if (to.length === grown) { top.meta.set("carrier", true); to.push(top); }
    return "undone";
  }

  private putBack(act: NativeActNote): boolean {
    const start = Y.createAbsolutePositionFromRelativePosition(act.from, this.doc)?.index, end = Y.createAbsolutePositionFromRelativePosition(act.to, this.doc)?.index;
    if (start === undefined || end === undefined || end <= start) return false;
    const showing = new Set<string>();
    let index = 0;
    for (const item of act.text.toDelta() as NativeDeltaItem[]) {
      const next = index + (typeof item.insert === "string" ? item.insert.length : 1);
      if (next > start && index < end) for (const [key, shown] of Object.entries(item.attributes ?? {})) if (shown === true) showing.add(nativeMarkName(key));
      index = next;
    }
    const missing = act.names.filter(name => !showing.has(name));
    if (!missing.length) return false;
    this.doc.transact(() => { act.text.format(start, end - start, Object.fromEntries(missing.map(name => [usesActionKey(this.scheme, name) ? this.actKey(name) : name, true]))); }, "takeback");
    return true;
  }

  // why: the same mark over exactly the same characters, made by someone who had not seen this one, is one change
  private takeBack(act: NativeActNote): boolean {
    const start = Y.createAbsolutePositionFromRelativePosition(act.from, this.doc)?.index, end = Y.createAbsolutePositionFromRelativePosition(act.to, this.doc)?.index;
    const extents = new Map<string, { first: number; last: number; count: number }>();
    let index = 0;
    for (const item of act.text.toDelta() as NativeDeltaItem[]) {
      const length = typeof item.insert === "string" ? item.insert.length : 1;
      for (const [key, value] of Object.entries(item.attributes ?? {})) {
        if (value !== true || act.seen.includes(key) || !act.names.includes(nativeMarkName(key))) continue;
        const extent = extents.get(key) ?? { first: index, last: index, count: 0 };
        extent.last = index + length; extent.count += length;
        extents.set(key, extent);
      }
      index += length;
    }
    const off = new Map<string, { first: number; last: number }>();
    for (const [key, extent] of extents) {
      // why: a key that continues one of this act's keys after someone's unformatted gap is still this act
      if (act.minted.some(minted => key.startsWith(minted + ACT))) off.set(key, extent);
      else if (start !== undefined && end !== undefined && extent.first === start && extent.last === end && extent.count === end - start) off.set(key, extent);
    }
    if (!off.size) return false;
    this.doc.transact(() => { for (const [key, extent] of off) act.text.format(extent.first, extent.last - extent.first, { [key]: null }); }, "takeback");
    return true;
  }

  split(beat: string, offset: number, created: string, fields: Record<string, unknown> = {}): void {
    this.transact(() => {
      const cell = this.cell(beat, "audioText"), around = attributesAt(cell.text.toDelta() as NativeDeltaItem[], cell.start + offset - 1) ?? {};
      // why: given the formatting already in force at its place, the boundary writes no marker of its own, so a later
      // undo of that formatting cannot leave a marker that turns it on again after the boundary
      cell.text.insertEmbed(cell.start + offset, { b: created }, Object.fromEntries(Object.entries(around).filter(([, value]) => value === true)));
      const map = new Y.Map<unknown>();
      this.beats.set(created, map);
      for (const [key, value] of Object.entries(fields)) map.set(key, value);
      this.visuals.set(created, new Y.Text());
    });
  }

  join(from: string, into: string, glue: string): void {
    this.flagged(from, "joined", record => { record.set("joined", { into, glue } satisfies NativeJoin); });
  }

  unjoin(from: string): void {
    this.flagged(from, "joined", record => { record.delete("joined"); });
  }

  remove(beat: string, by: string, at = 0): void {
    const seen = Object.fromEntries([...Y.decodeStateVector(Y.encodeStateVector(this.doc))].map(([client, clock]) => [String(client), clock]));
    this.flagged(beat, "removed", record => { record.set("removed", { by, at, seen } satisfies NativeRemoval); });
  }

  restore(beat: string): void {
    this.flagged(beat, "removed", record => { record.delete("removed"); });
  }

  setField(beat: string, field: string, value: unknown): void {
    this.flagged(beat, field, record => { record.set(field, value); });
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

  // why: design section 7: a chain reads as one row, a loop breaks at its beat earliest in order, and a beat whose chain
  // meets a removed beat goes with the nearest one, so its text is listed in recovery instead of read by no one
  private heads(order: readonly string[]): Map<string, NativeHead> {
    const index = new Map(order.map((id, at) => [id, at])), parent = new Map<string, string | null>(), state = new Map<string, 1 | 2>();
    for (const id of order) {
      const into = this.joined(id)?.into;
      parent.set(id, into !== undefined && into !== id && index.has(into) ? into : null);
    }
    this.loops = [];
    for (const id of order) {
      const path: string[] = [];
      let current: string | null = id;
      while (current !== null && !state.has(current)) { state.set(current, 1); path.push(current); current = parent.get(current) ?? null; }
      if (current !== null && state.get(current) === 1) {
        const cycle = path.slice(path.indexOf(current));
        const first = cycle.reduce((best, next) => (index.get(next) ?? 0) < (index.get(best) ?? 0) ? next : best);
        parent.set(first, null); this.loops.push(first);
      }
      for (const passed of path) state.set(passed, 2);
    }
    this.loops.sort((left, right) => (index.get(left) ?? 0) - (index.get(right) ?? 0));
    const heads = new Map<string, NativeHead>();
    for (const id of order) {
      const path: string[] = [];
      let current = id, head: NativeHead | undefined;
      for (;;) {
        head = heads.get(current);
        if (head) break;
        path.push(current);
        if (this.removal(current)) { head = { id: current, hidden: true }; break; }
        const up = parent.get(current) ?? null;
        if (up === null) { head = { id: current, hidden: false }; break; }
        current = up;
      }
      for (const passed of path) heads.set(passed, head);
    }
    return heads;
  }

  protected breaksContiguousGroup?: (heading: string) => boolean;

  protected invalidateStructure(): void { this.structureChanged = true; }

  // why: the second reading: a join flag only hides the boundary above its beat, so a joined beat belongs to the nearest
  // visible row above it in stored order, and a removed joined beat to the removed beat directly above it
  private contiguousHeads(blocks: readonly NativeBlock[]): Map<string, NativeHead> {
    const heads = new Map<string, NativeHead>();
    let shown: string | null = null, hidden: string | null = null, above = false;
    this.loops = [];
    for (const block of blocks) {
      if (block.kind === "h") {
        if (this.breaksContiguousGroup?.(block.id)) { shown = null; hidden = null; above = false; }
        continue;
      }
      const id = block.id;
      const joined = this.joined(id) !== null;
      if (this.removal(id)) {
        if (!(joined && above && hidden !== null)) hidden = id;
        heads.set(id, { id: hidden, hidden: true }); above = true;
      } else {
        if (!(joined && shown !== null)) shown = id;
        heads.set(id, { id: shown, hidden: false }); above = false;
      }
    }
    return heads;
  }

  private row(id: string, members: readonly NativeBlock[]): NativeRow {
    const audio: NativeDeltaItem[] = [], visual: NativeDeltaItem[] = [], parts = { audio: [] as NativePart[], visual: [] as NativePart[] };
    for (const member of members) {
      const glue = member.id === id ? "" : this.joined(member.id)?.glue ?? "";
      if (glue && audio.length && member.delta.length) { audio.push({ insert: glue }); parts.audio.push({ beat: null, length: glue.length }); }
      audio.push(...member.delta);
      parts.audio.push({ beat: member.id, length: deltaLength(member.delta) });
      const own = this.visualDelta(member.id);
      if (visual.length && own.length) { visual.push({ insert: "\n" }); parts.visual.push({ beat: null, length: 1 }); }
      visual.push(...own);
      parts.visual.push({ beat: member.id, length: deltaLength(own) });
    }
    return { id, audioText: nativeHtml(audio), visualText: nativeHtml(visual), fields: this.beats.get(id)?.toJSON() as Record<string, unknown> ?? {}, audio, visual,
      members: members.map(member => member.id), parts };
  }

  private project(): Map<string, NativeRow> {
    const stored = this.blocks(), blocks = stored.filter(block => block.kind === "b");
    const heads = this.reading === "contiguous" ? this.contiguousHeads(stored) : this.heads(blocks.map(block => block.id));
    const members = new Map<string, NativeBlock[]>();
    this.groups.clear(); this.owner.clear(); this.hiddenGroups = new Map();
    for (const block of blocks) {
      const head = heads.get(block.id);
      if (!head) continue;
      if (head.hidden) { this.hiddenGroups.set(head.id, [...(this.hiddenGroups.get(head.id) ?? []), block.id]); continue; }
      members.set(head.id, [...(members.get(head.id) ?? []), block]);
      this.groups.set(head.id, [...(this.groups.get(head.id) ?? []), block.id]);
      this.owner.set(block.id, head.id);
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
    // why: a tag or comment the page has no record for changes the stored marks but not the HTML
    const differs = (row: NativeRow, before: NativeRow | undefined): boolean => !before || before.audioText !== row.audioText
      || before.visualText !== row.visualText || JSON.stringify(before.fields) !== JSON.stringify(row.fields)
      || JSON.stringify([before.audio, before.visual]) !== JSON.stringify([row.audio, row.visual]);
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
    const result: NativeRecovery[] = [], placed = new Set(this.blocks().filter(block => block.kind === "b").map(block => block.id));
    // why: a beat whose split was undone keeps its record and visual cell; what was typed there is listed
    for (const [beat, text] of this.visuals) {
      if (placed.has(beat) || !text.length) continue;
      const visualItems = text.toDelta() as NativeDeltaItem[];
      result.push({ beat, kept: "", unseen: [], visual: nativeHtml(visualItems), reason: "unplaced", members: [beat], audio: [], visualItems });
    }
    for (const [head, ids] of this.hiddenGroups) {
      const removal = this.removal(head), members = ids.map(id => this.block(id)), unseen: string[] = [];
      if (!removal) continue;
      for (const block of members) {
        const text = this.segments.get(block.segment)?.get("text") as Y.Text;
        let index = block.start, open = false;
        for (const item of block.delta) {
          const length = typeof item.insert === "string" ? item.insert.length : 1;
          for (let offset = 0; offset < length; offset++, index++) {
            const seen = (this.removal(block.id) ?? removal).seen, id = this.characterIdentity(text, index), late = id.clock >= (seen[String(id.client)] ?? 0);
            if (late) {
              const value = typeof item.insert === "string" ? item.insert.charAt(offset) : "￼";
              if (open) unseen[unseen.length - 1] += value; else unseen.push(value);
            }
            open = late;
          }
        }
      }
      const row = this.row(head, members);
      result.push({ beat: head, kept: row.audioText, unseen, visual: row.visualText, reason: "removed", members: row.members, audio: row.audio, visualItems: row.visual });
    }
    for (const beat of this.loops) result.push({ beat, kept: "", unseen: [], visual: "", reason: "loop", members: [beat], audio: [], visualItems: [] });
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
