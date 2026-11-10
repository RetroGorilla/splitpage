import * as Y from "yjs";
import { videoLinkKey } from "../../../../src/core/document/gallery.ts";
import type { VideoLink } from "../../../../src/core/document/gallery.ts";
import { IdentityBook } from "../model.ts";
import { SchemaReplica, mapValue, textValue } from "../schema.ts";
import type { SchemaCandidate } from "../schema.ts";
import { deltaToHtml, insertHtml, readDelta } from "./richtext.ts";
import type { ProjectionDelta } from "./richtext.ts";
import { bag, copy, ordered, rank, ranked, readRecord, records, writeRecord } from "./value.ts";
import type { ProjectionBag } from "./value.ts";

const META = ["titleOrigin", "titleVersion", "docId", "wordsPerMinute", "targetSeconds", "paragraphsDecided", "schema"];
const CAPTURE = ["rev", "lastEditedBy", "lastEditedAt", "personColors"];
const BEAT = ["id", "status", "lengthSeconds", "paragraphStart"];
const COMMENT = ["id", "rowId", "field", "anchorId", "author", "createdAt", "updatedAt", "assignee", "kind", "imageValue", "conflictField", "emptyValue", "titleValue"];
const REPLY = ["id", "author", "createdAt"];
const PERSON = ["id", "name"];
const TAG = ["id", "cat", "name", "owner", "notes", "status"];
const SHOT = ["id", "name", "desc", "status", "reshoot", "notes", "audioRef", "location", "owner", "origin", "props"];
const ROW_SPECIAL = ["audioText", "visualText", "updatedAt", "updatedBy", "imageRef", "imageName", "imageAnnotation", "imageLinks", "moreImages", "visualImage"];
const COMMENT_SPECIAL = ["body", "quotedText", "resolved", "resolvedAt", "resolvedBy", "replies"];

export interface ProjectionOptions {
  deriveCue?: boolean;
}

function without(source: ProjectionBag, keys: readonly string[]): ProjectionBag {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
}

function setIf(source: ProjectionBag, sourceKey: string, target: ProjectionBag, targetKey = sourceKey): void {
  if (Object.hasOwn(source, sourceKey)) target[targetKey] = copy(source[sourceKey]);
}

function putRegistry(doc: Y.Doc, root: string, source: unknown, fields: readonly string[]): void {
  records(source).forEach((entry, index) => {
    const value = new Y.Map<unknown>();
    doc.getMap(root).set(String(entry.id), value);
    writeRecord(value, entry, fields);
    value.set("rank", rank(index));
  });
}

function gallerySlot(doc: Y.Doc, row: ProjectionBag, slot: ProjectionBag, index: number): void {
  const value = new Y.Map<unknown>();
  doc.getMap("gallery").set(`${String(row.id)}:slot:${index}`, value);
  value.set("beat", row.id);
  value.set("rank", rank(index));
  value.set("keys", Object.keys(slot));
  const picture: ProjectionBag = {};
  for (const key of ["imageRef", "name", "annotation"]) setIf(slot, key, picture);
  value.set("picture", picture);
  value.set("extra", without(slot, ["imageRef", "name", "annotation", "links"]));
  const links = new Y.Map<unknown>();
  value.set("links", links);
  records(slot.links).forEach((link, linkIndex) => {
    const record = new Y.Map<unknown>();
    const key = videoLinkKey(link as VideoLink);
    links.set(key, record);
    writeRecord(record, without(link, ["location"]), ["href", "name", "size", "duration", "poster"]);
    record.set("rank", rank(linkIndex));
  });
}

function addText(replica: SchemaReplica, id: string, kind: "b" | "h", value: string, source: ProjectionBag): void {
  let text: Y.Text;
  if (replica.candidate === "A") {
    text = replica.doc.getText("flow");
    text.insertEmbed(text.length, { [kind]: id }, {});
  } else {
    const segment = new Y.Map<unknown>();
    replica.doc.getMap("segments").set(`seg-${kind}-${id}`, segment);
    segment.set("head", { [kind]: id });
    text = new Y.Text();
    segment.set("text", text);
    replica.doc.getArray<string>("order").push([`seg-${kind}-${id}`]);
  }
  if (kind === "h") text.insert(text.length, value, {});
  else insertHtml(text, value, source.productionTags, source.comments);
}

export function fromDocument(source: ProjectionBag, candidate: SchemaCandidate, client = 10): SchemaReplica {
  const replica = new SchemaReplica(candidate, client, new IdentityBook());
  replica.doc.transact(() => {
    const meta = replica.doc.getMap("meta");
    writeRecord(meta, without(source, ["title", "rows", "sections", "comments", "people", "productionTags", "brollShots", ...CAPTURE]), META);
    meta.set("keys", Object.keys(source));
    meta.set("capture", Object.fromEntries(CAPTURE.filter(key => Object.hasOwn(source, key)).map(key => [key, copy(source[key])])));
    const title = new Y.Text();
    meta.set("title", title);
    title.insert(0, String(source.title ?? ""), {});
    putRegistry(replica.doc, "people", source.people, PERSON);
    putRegistry(replica.doc, "tags", source.productionTags, TAG);
    putRegistry(replica.doc, "shots", source.brollShots, SHOT);
    for (const heading of records(source.sections)) {
      const record = new Y.Map<unknown>();
      replica.doc.getMap("headings").set(String(heading.id), record);
      record.set("keys", Object.keys(heading));
    }
    for (const row of records(source.rows)) {
      for (const heading of records(source.sections).filter(value => value.firstSceneId === row.id)) {
        addText(replica, String(heading.id), "h", String(heading.name), source);
      }
      addText(replica, String(row.id), "b", String(row.audioText ?? ""), source);
      const beat = new Y.Map<unknown>();
      replica.doc.getMap("beats").set(String(row.id), beat);
      writeRecord(beat, without(row, ROW_SPECIAL), BEAT);
      beat.set("keys", Object.keys(row));
      const stamp: ProjectionBag = {};
      setIf(row, "updatedBy", stamp, "by");
      setIf(row, "updatedAt", stamp, "at");
      beat.set("stamp", stamp);
      beat.set("joins", new Y.Map<unknown>());
      beat.set("removals", new Y.Map<unknown>());
      const visual = new Y.Map<unknown>();
      replica.doc.getMap("visuals").set(`visual-${String(row.id)}`, visual);
      visual.set("beat", row.id);
      visual.set("rank", rank(0));
      const text = new Y.Text();
      visual.set("text", text);
      insertHtml(text, String(row.visualText ?? ""), source.productionTags, source.comments);
      const first: ProjectionBag = {};
      setIf(row, "imageRef", first);
      setIf(row, "imageName", first, "name");
      setIf(row, "imageAnnotation", first, "annotation");
      setIf(row, "imageLinks", first, "links");
      gallerySlot(replica.doc, row, first, 0);
      records(row.moreImages).forEach((slot, index) => gallerySlot(replica.doc, row, slot, index + 1));
    }
    records(source.comments).forEach((comment, index) => {
      const record = new Y.Map<unknown>();
      replica.doc.getMap("comments").set(String(comment.id), record);
      writeRecord(record, without(comment, COMMENT_SPECIAL), COMMENT);
      record.set("keys", Object.keys(comment));
      record.set("rank", rank(index));
      const resolution: ProjectionBag = {};
      for (const key of ["resolved", "resolvedAt", "resolvedBy"]) setIf(comment, key, resolution);
      record.set("resolution", resolution);
      if (Object.hasOwn(comment, "body")) record.set("text", comment.body);
      if (Object.hasOwn(comment, "quotedText")) record.set("quote", comment.quotedText);
      records(comment.replies).forEach((reply, replyIndex) => {
        const value = new Y.Map<unknown>();
        replica.doc.getMap("replies").set(`${String(comment.id)}:${String(reply.id)}`, value);
        writeRecord(value, without(reply, ["body"]), REPLY);
        value.set("keys", Object.keys(reply));
        value.set("commentId", comment.id);
        value.set("text", reply.body);
        value.set("rank", rank(replyIndex));
      });
    });
  }, "projection-import");
  return replica;
}

export interface ProjectionBlock {
  id: string;
  kind: "b" | "h";
  delta: ProjectionDelta[];
}

export function projectionBlocks(doc: Y.Doc, candidate: SchemaCandidate): ProjectionBlock[] {
  const result: ProjectionBlock[] = [];
  const seen = new Set<string>();
  let current: ProjectionBlock | null = null;
  function boundary(value: ProjectionBag): void {
    const kind = "b" in value ? "b" : "h";
    const id = String(value[kind]);
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    current = { id, kind, delta: [] };
    result.push(current);
  }
  function consume(text: Y.Text): void {
    for (const delta of readDelta(text)) {
      if (typeof delta.insert !== "string" && ("b" in delta.insert || "h" in delta.insert)) boundary(delta.insert);
      else {
        if (!current) throw new Error("Content outside a boundary");
        current.delta.push(delta);
      }
    }
  }
  if (candidate === "A") consume(doc.getText("flow"));
  else for (const id of new Set(doc.getArray<string>("order").toArray())) {
    const segment = mapValue(doc.getMap("segments").get(id));
    boundary(bag(segment.get("head")));
    consume(textValue(segment.get("text")));
  }
  return result;
}

function registry(doc: Y.Doc, root: string, fields: readonly string[]): ProjectionBag[] {
  return ranked(doc.getMap(root)).map(([, value]) => readRecord(value, fields));
}

function galleryFor(doc: Y.Doc, id: string): ProjectionBag[] {
  return ranked(doc.getMap("gallery")).filter(([, value]) => value.get("beat") === id).map(([, value]) => {
    const result = { ...copy(bag(value.get("extra") ?? {})), ...copy(bag(value.get("picture"))) };
    const links = ranked(mapValue(value.get("links"))).map(([, link]) => readRecord(link, ["href", "name", "size", "duration", "poster"]));
    if (links.length || (value.get("keys") as string[]).includes("links")) result.links = links;
    return ordered(result, value.get("keys"));
  });
}

export function toDocument(doc: Y.Doc, candidate: SchemaCandidate, options: ProjectionOptions = {}): ProjectionBag {
  const meta = doc.getMap("meta");
  const result = readRecord(meta, META);
  Object.assign(result, copy(bag(meta.get("capture"))));
  result.title = textValue(meta.get("title")).toString();
  result.people = registry(doc, "people", PERSON);
  result.productionTags = registry(doc, "tags", TAG);
  result.brollShots = registry(doc, "shots", SHOT);
  const comments = ranked(doc.getMap("comments")).map(([, value]) => {
    const comment = readRecord(value, COMMENT);
    Object.assign(comment, copy(bag(value.get("resolution"))));
    if (value.has("text")) comment.body = value.get("text");
    if (value.has("quote")) comment.quotedText = value.get("quote");
    comment.replies = ranked(doc.getMap("replies")).filter(([, reply]) => reply.get("commentId") === comment.id).map(([, reply]) => {
      const record = readRecord(reply, REPLY);
      record.body = reply.get("text");
      return ordered(record, reply.get("keys"));
    });
    return ordered(comment, value.get("keys"));
  });
  result.comments = comments;
  const rows: ProjectionBag[] = [];
  const sections: ProjectionBag[] = [];
  let heading: ProjectionBlock | null = null;
  for (const block of projectionBlocks(doc, candidate)) {
    if (block.kind === "h") { heading = block; continue; }
    const beat = mapValue(doc.getMap("beats").get(block.id));
    const row = readRecord(beat, BEAT);
    const stamp = bag(beat.get("stamp"));
    setIf(stamp, "by", row, "updatedBy");
    setIf(stamp, "at", row, "updatedAt");
    row.audioText = deltaToHtml(block.delta, result.productionTags, comments, options.deriveCue);
    row.visualText = ranked(doc.getMap("visuals")).filter(([, value]) => value.get("beat") === block.id)
      .map(([, value]) => deltaToHtml(readDelta(textValue(value.get("text"))), result.productionTags, comments, options.deriveCue)).filter(Boolean).join("<br>");
    const slots = galleryFor(doc, block.id);
    const first = slots[0] ?? {};
    setIf(first, "imageRef", row);
    setIf(first, "name", row, "imageName");
    setIf(first, "annotation", row, "imageAnnotation");
    setIf(first, "links", row, "imageLinks");
    if (slots.length > 1 || (beat.get("keys") as string[]).includes("moreImages")) row.moreImages = slots.slice(1);
    rows.push(ordered(row, beat.get("keys")));
    if (heading) {
      const name = heading.delta.map(item => typeof item.insert === "string" ? item.insert : "").join("");
      if (name) sections.push(ordered({ id: heading.id, name, firstSceneId: block.id }, mapValue(doc.getMap("headings").get(heading.id)).get("keys")));
      heading = null;
    }
  }
  result.rows = rows;
  if (sections.length || (meta.get("keys") as string[]).includes("sections")) result.sections = sections;
  return ordered(result, meta.get("keys"));
}
