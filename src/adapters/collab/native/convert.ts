import * as Y from "yjs";
import { normalizeBrollProps } from "../../../core/document/broll.ts";
import type { ValidatedDocument } from "../../../core/document/validated.ts";
import { tagStack, withTagStack } from "../../../core/text/runs.ts";
import type { Run } from "../../../core/text/runs.ts";
import { encodeNativeGallery, normalizeNativeGallery } from "./gallery.ts";
import { prepareNativeRuns, writeNativeRuns } from "./inline.ts";
import type { NativePreparedRun } from "./inline.ts";
import { NATIVE_FORMAT_VERSION } from "./roots.ts";
import type { NativeRoots } from "./roots.ts";
import { openNativeScript, transactNativeCommand } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { NATIVE_SHOT_PROPS, newNativeShotProps } from "./shot-props.ts";
import {
  NATIVE_BEAT_FIELDS, NATIVE_GALLERY_KEY, encodeNativeValue, isNativeBeatExtra, nativeFieldKey, nativeGalleryOf, nativeWellFormed
} from "./values.ts";

export interface NativeConversionPorts {
  readonly cells: (html: string) => readonly Run[];
  readonly creation: string;
  readonly at: string;
  readonly by: string;
}

type Bag = Record<string, unknown>;
type Entries = readonly (readonly [string, string])[];

interface PreparedBeat { readonly id: string; readonly heads: readonly PreparedHeading[]; readonly entries: Entries; readonly narration: readonly NativePreparedRun[]; readonly visual: readonly NativePreparedRun[]; readonly edited: Entries }
interface PreparedHeading { readonly id: string; readonly name: string; readonly entries: Entries }
interface PreparedRecord { readonly id: string; readonly key: string; readonly entries: Entries; readonly comment?: string }

export const NATIVE_SEGMENT_BEATS = 30;

const CONVERTING = new WeakSet<Y.Doc>();

const COLLECTIONS = ["rows", "sections", "comments", "people", "productionTags", "brollShots"];
const META_FIELDS = ["docId", "schema", "wordsPerMinute", "targetSeconds"];
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function nativeInitialRank(index: number): string {
  let value = (index + 1) * 32, result = "";
  for (let place = 0; place < 6; place++) { result = DIGITS[value % DIGITS.length] + result; value = Math.floor(value / DIGITS.length); }
  if (value !== 0) throw new RangeError("The script holds more blocks than a first rank can number");
  return result + "V";
}

function bags(value: unknown): Bag[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Expected document records");
  return (value as unknown[]).map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Expected a document record");
    return item as Bag;
  });
}

function unique(entries: readonly Bag[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!nativeWellFormed(entry.id) || !entry.id || seen.has(entry.id)) throw new Error("Duplicated, missing or malformed document identity");
    seen.add(entry.id);
  }
}

function present(source: Bag, skip: readonly string[]): string[] {
  return Object.keys(source).filter(key => !skip.includes(key) && source[key] !== undefined).sort();
}

function fileEntries(source: Bag, skip: readonly string[]): Entries {
  return present(source, skip).map(key => [nativeFieldKey(key), encodeNativeValue(source[key])] as const);
}

function namedEntries(source: Bag, names: readonly string[]): [string, string][] {
  return names.filter(name => source[name] !== undefined).map(name => [name, encodeNativeValue(source[name])]);
}

export function nativeBeatEntries(row: Readonly<Bag>): Entries {
  const extras = Object.keys(row).filter(name => isNativeBeatExtra(name) && row[name] !== undefined).sort();
  const gallery = nativeGalleryOf(row);
  const entries = namedEntries(row, NATIVE_BEAT_FIELDS);
  if (Object.keys(gallery).length) entries.push([NATIVE_GALLERY_KEY, encodeNativeGallery(normalizeNativeGallery(gallery))]);
  for (const name of extras) entries.push([nativeFieldKey(name), encodeNativeValue(row[name])]);
  return entries;
}

function metaEntries(source: Bag): Entries {
  const extra = Object.fromEntries(present(source, [...COLLECTIONS, "title", ...META_FIELDS]).map(key => [key, source[key]]));
  return [...namedEntries(source, META_FIELDS), ["extra", encodeNativeValue(extra)]];
}

// why: Y.Text stores UTF-16 but updates carry UTF-8, so a lone surrogate would arrive on another copy as U+FFFD
function wellFormed(value: string): string {
  return value.replace(/\p{Cs}/gu, "�");
}

// why: a file can nest a tag inside itself; one key per tag and unit keeps the inner application on those units,
// so from the first repeated tag down they share no key with a neighbour
function oneLevel(run: Run): { readonly run: Run; readonly shared?: number } {
  if (run.atom) return { run };
  const stack = tagStack(run.marks), kept = [...new Set(stack)];
  if (kept.length === stack.length) return { run };
  const repeated = stack.find((id, depth) => stack.indexOf(id) !== depth) as string;
  return { run: { ...run, marks: withTagStack(run.marks, kept) }, shared: kept.indexOf(repeated) };
}

function cell(cells: NativeConversionPorts["cells"], html: unknown, where: string): NativePreparedRun[] {
  return cells(typeof html === "string" ? html : "").flatMap(source => {
    const { run, shared } = oneLevel(source), prepared = prepareNativeRuns([run]);
    if (!prepared) throw new Error("The rich-text reader returned a cell the shared script cannot hold: " + where);
    return shared === undefined ? prepared : prepared.map(item => ({ ...item, shared }));
  });
}

function emptyDocument(doc: Y.Doc): boolean {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).size === 0;
}

function writeRecord(map: Y.Map<Y.Map<unknown>>, key: string, entries: Entries, rank: string, extra: readonly (readonly [string, string])[] = []): Y.Map<unknown> {
  const record = new Y.Map<unknown>();
  map.set(key, record);
  for (const [field, value] of [...entries, ...extra]) record.set(field, value);
  record.set("rank", rank);
  return record;
}

function write(script: NativeScript, roots: NativeRoots, plan: ReturnType<typeof prepare>): void {
  const meta = roots.meta;
  meta.set("format", NATIVE_FORMAT_VERSION);
  for (const [key, value] of plan.meta) meta.set(key, value);
  const title = new Y.Text();
  meta.set("title", title);
  title.insert(0, plan.title, {});
  roots.births.set(plan.creation[0], plan.creation[1]);
  let rank = 0, segment: { text: Y.Text; at: number; beats: number } | null = null;
  const open = (kind: "b" | "h", id: string): { text: Y.Text; at: number; beats: number } => {
    const record = new Y.Map<unknown>(), text = new Y.Text(), key = kind + ":" + id;
    roots.segments.set(key, record);
    record.set("head", { [kind]: id });
    record.set("text", text);
    roots.order.push([key]);
    return { text, at: 0, beats: 0 };
  };
  for (const beat of plan.beats) {
    for (const heading of beat.heads) {
      writeRecord(roots.headings, heading.id, heading.entries, nativeInitialRank(rank++));
      const name = new Y.Text();
      roots.names.set(heading.id, name);
      name.insert(0, heading.name, {});
      segment = open("h", heading.id);
    }
    if (!segment || segment.beats >= NATIVE_SEGMENT_BEATS) segment = open("b", beat.id);
    else { segment.text.insertEmbed(segment.at, { b: beat.id }, {}); segment.at += 1; }
    segment.beats++;
    segment.at = writeNativeRuns(script.doc, segment.text, segment.at, beat.narration, null);
    writeRecord(roots.beats, beat.id, beat.entries, nativeInitialRank(rank++));
    const visual = new Y.Text();
    roots.visuals.set(beat.id, visual);
    writeNativeRuns(script.doc, visual, 0, beat.visual, null);
    if (beat.edited.length) roots.edited.set(beat.id, Object.fromEntries(beat.edited));
  }
  for (const [map, records] of [[roots.people, plan.people], [roots.tags, plan.tags]] as const) {
    records.forEach((record, index) => { writeRecord(map, record.key, record.entries, nativeInitialRank(index)); });
  }
  plan.shots.forEach((shot, index) => {
    const record = writeRecord(roots.shots, shot.key, shot.entries, nativeInitialRank(index));
    record.set(NATIVE_SHOT_PROPS, newNativeShotProps(shot.props));
  });
  plan.comments.forEach((record, index) => { writeRecord(roots.comments, record.key, record.entries, nativeInitialRank(index)); });
  for (const reply of plan.replies) writeRecord(roots.replies, reply.key, reply.entries, reply.rank, [["commentId", reply.comment]]);
}

function prepare(source: ValidatedDocument, ports: NativeConversionPorts) {
  const { cells, creation, at, by } = ports;
  for (const value of [creation, at, by]) if (!nativeWellFormed(value) || !value) throw new Error("Conversion needs a creation id, a time and a writer");
  if (typeof cells !== "function") throw new Error("Conversion needs the rich-text reader");
  if (typeof source.title !== "string" || !Array.isArray(source.rows)) throw new Error("Conversion needs a validated script");
  const sections = bags(source.sections), tags = bags(source.productionTags), comments = bags(source.comments);
  for (const entries of [bags(source.rows), sections, comments, bags(source.people), tags, bags(source.brollShots)]) unique(entries);
  const rowIds = new Set(source.rows.map(row => row.id)), headsOf = new Map<string, PreparedHeading[]>();
  for (const section of sections) {
    const anchor = section.firstSceneId;
    if (typeof anchor !== "string" || !rowIds.has(anchor)) throw new Error("A heading names no row of this script: " + String(section.id));
    if (headsOf.has(anchor)) throw new Error("Two headings name the same row: " + anchor);
    headsOf.set(anchor, [{ id: String(section.id), name: wellFormed(typeof section.name === "string" ? section.name : ""), entries: fileEntries(section, ["id", "name", "firstSceneId"]) }]);
  }
  const beats: PreparedBeat[] = source.rows.map(row => ({
    id: row.id, heads: headsOf.get(row.id) ?? [],
    entries: nativeBeatEntries(row),
    narration: cell(cells, row.audioText, row.id + " narration"), visual: cell(cells, row.visualText, row.id + " visual"),
    edited: [["at", row.updatedAt] as const, ["by", row.updatedBy] as const].filter(([, value]) => value !== undefined).map(([key, value]) => [key, encodeNativeValue(value)] as const)
  }));
  const records = (list: readonly Bag[]): PreparedRecord[] => list.map(entry => ({ id: String(entry.id), key: String(entry.id), entries: fileEntries(entry, ["id"]) }));
  const replies = comments.flatMap(comment => {
    const list = bags(comment.replies);
    unique(list);
    return list.map((reply, position) => ({ key: JSON.stringify([comment.id, reply.id]), comment: String(comment.id), rank: nativeInitialRank(position), entries: fileEntries(reply, ["id"]) }));
  });
  return {
    meta: metaEntries(source), title: wellFormed(source.title),
    creation: [creation, { at, by }] as const, beats,
    people: records(bags(source.people)), tags: records(tags),
    shots: bags(source.brollShots).map(shot => ({ key: String(shot.id), entries: fileEntries(shot, ["id", "props"]),
      props: normalizeBrollProps(shot.props, []) })),
    comments: comments.map(comment => ({ id: String(comment.id), key: String(comment.id), entries: fileEntries(comment, ["id", "replies"]) })), replies
  };
}

export function convertToNativeScript(script: NativeScript, source: ValidatedDocument, ports: NativeConversionPorts): void {
  if (script.closed() || script.busy()) throw new Error("Conversion needs an open script outside any transaction");
  if (!emptyDocument(script.doc) || CONVERTING.has(script.doc)) throw new Error("Conversion needs an empty shared script");
  CONVERTING.add(script.doc);
  try {
    const plan = prepare(source, ports);
    transactNativeCommand(script, () => {
      if (!emptyDocument(script.doc)) throw new Error("Conversion needs an empty shared script");
      write(script, script.roots, plan);
    }, "conversion");
  } finally { CONVERTING.delete(script.doc); }
}

export function createNativeShareSnapshot(source: ValidatedDocument, ports: NativeConversionPorts): Uint8Array {
  const doc = new Y.Doc();
  try {
    convertToNativeScript(openNativeScript(doc), source, ports);
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}
