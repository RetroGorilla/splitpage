import * as Y from "yjs";
import type { DocumentShape } from "../../../core/document/validated.ts";
import type { Run } from "../../../core/text/runs.ts";
import { writeNativeRuns } from "./inline.ts";
import { NATIVE_FORMAT_VERSION } from "./roots.ts";
import type { NativeScript } from "./script.ts";

export interface NativeConversionPorts {
  readonly cells: (html: string) => readonly Run[];
  readonly creation: string;
  readonly at: string;
  readonly by: string;
}

type Bag = Record<string, unknown>;

export const NATIVE_SEGMENT_BEATS = 30;

const COLLECTIONS = ["rows", "sections", "comments", "people", "productionTags", "brollShots"];
const META_FIELDS = ["docId", "schema", "wordsPerMinute", "targetSeconds"];
const BEAT_FIELDS = ["status", "lengthSeconds", "paragraphStart"];
const ROW_TEXT = ["id", "audioText", "visualText", "updatedAt", "updatedBy"];
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

function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function unique(entries: readonly Bag[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) throw new Error("Duplicated or missing document identity");
    seen.add(entry.id);
  }
}

function rest(source: Bag, skip: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(Object.keys(source).filter(key => !skip.includes(key) && source[key] !== undefined).sort().map(key => [key, json(source[key])])));
}

function withoutLocations(links: unknown): unknown {
  if (!Array.isArray(links)) return links;
  return (links as unknown[]).map(link => link && typeof link === "object" && !Array.isArray(link)
    ? Object.fromEntries(Object.entries(link as Bag).filter(([key]) => key !== "location"))
    : link);
}

function rowExtra(row: Bag): string {
  const kept: Bag = { ...row };
  if (Object.hasOwn(kept, "imageLinks")) kept.imageLinks = withoutLocations(kept.imageLinks);
  if (Array.isArray(kept.moreImages)) kept.moreImages = (kept.moreImages as unknown[]).map(slot =>
    slot && typeof slot === "object" && !Array.isArray(slot) && Object.hasOwn(slot, "links") ? { ...slot as Bag, links: withoutLocations((slot as Bag).links) } : slot);
  return rest(kept, [...ROW_TEXT, ...BEAT_FIELDS]);
}

function fieldsRecord(source: Bag, skip: readonly string[], rank: string): Y.Map<unknown> {
  const record = new Y.Map<unknown>();
  for (const key of Object.keys(source).sort()) if (!skip.includes(key) && source[key] !== undefined) record.set(key, json(source[key]));
  record.set("rank", rank);
  return record;
}

function cleanText(value: string): string {
  return value.replace(/\p{Cs}/gu, "�");
}

export function convertToNativeScript(script: NativeScript, source: DocumentShape, ports: NativeConversionPorts): void {
  const roots = script.roots, sections = bags(source.sections), tags = bags(source.productionTags);
  if (script.doc.store.clients.size) throw new Error("Conversion needs an empty shared script");
  for (const entries of [source.rows, sections, source.comments, source.people, tags, source.brollShots] as Bag[][]) unique(entries);
  for (const comment of source.comments) unique(bags(comment.replies));
  const narration = source.rows.map(row => ports.cells(row.audioText ?? "")), visuals = source.rows.map(row => ports.cells(row.visualText ?? ""));
  const headingsBefore = new Map<string, Bag[]>();
  for (const section of sections) {
    const list = headingsBefore.get(String(section.firstSceneId)) ?? [];
    list.push(section);
    headingsBefore.set(String(section.firstSceneId), list);
  }
  script.doc.transact(() => {
    const meta = roots.meta;
    meta.set("format", NATIVE_FORMAT_VERSION);
    for (const key of META_FIELDS) if (source[key] !== undefined) meta.set(key, json(source[key]));
    meta.set("extra", rest(source, [...COLLECTIONS, ...META_FIELDS, "title"]));
    const title = new Y.Text();
    meta.set("title", title);
    title.insert(0, cleanText(source.title), {});
    roots.births.set(ports.creation, { at: ports.at, by: ports.by });
    let rank = 0, segment: { text: Y.Text; at: number; beats: number } | null = null;
    const open = (kind: "b" | "h", id: string): { text: Y.Text; at: number; beats: number } => {
      const record = new Y.Map<unknown>(), text = new Y.Text(), key = kind + ":" + id;
      roots.segments.set(key, record);
      record.set("head", { [kind]: id });
      record.set("text", text);
      roots.order.push([key]);
      return { text, at: 0, beats: 0 };
    };
    source.rows.forEach((row, index) => {
      for (const section of headingsBefore.get(row.id) ?? []) {
        const id = String(section.id);
        roots.headings.set(id, fieldsRecord(section, ["id", "name", "firstSceneId"], nativeInitialRank(rank++)));
        const name = new Y.Text();
        roots.names.set(id, name);
        name.insert(0, cleanText(String(section.name ?? "")), {});
        segment = open("h", id);
      }
      if (!segment || segment.beats >= NATIVE_SEGMENT_BEATS) segment = open("b", row.id);
      else { segment.text.insertEmbed(segment.at, { b: row.id }, {}); segment.at += 1; }
      segment.beats++;
      segment.at = writeNativeRuns(script.doc, segment.text, segment.at, narration[index] ?? [], null);
      const beat = new Y.Map<unknown>();
      roots.beats.set(row.id, beat);
      beat.set("rank", nativeInitialRank(rank++));
      for (const key of BEAT_FIELDS) if (row[key] !== undefined) beat.set(key, json(row[key]));
      beat.set("extra", rowExtra(row));
      const visual = new Y.Text();
      roots.visuals.set(row.id, visual);
      writeNativeRuns(script.doc, visual, 0, visuals[index] ?? [], null);
      const stamp: Bag = {};
      if (row.updatedAt !== undefined) stamp.at = json(row.updatedAt);
      if (row.updatedBy !== undefined) stamp.by = json(row.updatedBy);
      if (Object.keys(stamp).length) roots.edited.set(row.id, stamp);
    });
    for (const [root, entries] of [[roots.people, source.people], [roots.tags, tags], [roots.shots, source.brollShots]] as const) {
      (entries as Bag[]).forEach((entry, index) => { root.set(String(entry.id), fieldsRecord(entry, ["id"], nativeInitialRank(index))); });
    }
    source.comments.forEach((comment, index) => {
      roots.comments.set(comment.id, fieldsRecord(comment, ["id", "replies"], nativeInitialRank(index)));
      bags(comment.replies).forEach((reply, position) => {
        const record = fieldsRecord(reply, ["id"], nativeInitialRank(position));
        record.set("commentId", comment.id);
        roots.replies.set(JSON.stringify([comment.id, reply.id]), record);
      });
    });
  }, "conversion");
}
