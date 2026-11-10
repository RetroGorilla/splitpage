import { assembleReaderBlocks, readerBlockDelta, readerBlockStreams } from "../readers/blocks.ts";
import { literalRecord, mergeLiteralFields } from "../readers/output.ts";
import { identityEntries, identityGet, normalizeIdentityTree, wireIdentity } from "../readers/identity.ts";
import * as Y from "yjs";
import { videoLinkKey } from "../../../../src/core/document/gallery.ts";
import type { VideoLink } from "../../../../src/core/document/gallery.ts";
import { brollPropKey } from "../../../../src/core/document/broll.ts";
import { IdentityBook } from "../model.ts";
import { SchemaReplica } from "../schema.ts";
import type { SchemaCandidate } from "../schema.ts";
import { deltaToHtml, insertHtml, readDelta } from "./richtext.ts";
import type { ProjectionDelta } from "./richtext.ts";
import { bag, copy, rank, ranked, readRecord, records, writeRecord } from "./value.ts";
import { readVisualRecord, readWireRecord, readWireValue, rootMap, sharedMapRecord, stringKeys } from "../readers/records.ts";
import { compareCodeUnits } from "../readers/order.ts";
import type { ProjectionBag } from "./value.ts";

const META = ["titleOrigin", "titleVersion", "docId", "wordsPerMinute", "targetSeconds", "paragraphsDecided", "schema"];
const CAPTURE = ["rev", "lastEditedBy", "lastEditedAt", "personColors"];
const BEAT = ["id", "status", "lengthSeconds", "paragraphStart"];
const COMMENT = ["id", "rowId", "field", "anchorId", "author", "createdAt", "updatedAt", "assignee", "kind", "imageValue", "conflictField", "emptyValue", "titleValue"];
const REPLY = ["id", "author", "createdAt"];
const PERSON = ["id", "name"];
const TAG = ["id", "cat", "name", "owner", "notes", "status"];
const SHOT = ["id", "name", "desc", "status", "reshoot", "notes", "audioRef", "location", "owner", "origin"];
const ROW_SPECIAL = ["audioText", "visualText", "updatedAt", "updatedBy", "imageRef", "imageName", "imageAnnotation", "imageLinks", "moreImages", "visualImage"];
const COMMENT_SPECIAL = ["body", "quotedText", "resolved", "resolvedAt", "resolvedBy", "replies"];

export interface ProjectionOptions {
  deriveCue?: boolean;
  blocks?: readonly ProjectionBlock[];
  sectionBlocks?: readonly ProjectionBlock[];
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
    writeRecord(value, root === "shots" ? without(entry, ["props"]) : entry, fields);
    value.set("keys", Object.keys(entry));
    value.set("rank", rank(index));
    if (root === "shots") {
      const props = new Y.Map<unknown>();
      value.set("props", props);
      records(entry.props).forEach((prop, propIndex) => {
        addProjectionProp(props, prop, propIndex);
      });
    }
  });
}

export function addProjectionProp(props: Y.Map<unknown>, prop: ProjectionBag, index: number): void {
  const record = new Y.Map<unknown>();
  props.set(wireIdentity(brollPropKey(String(prop.id ?? ""), String(prop.name ?? ""))), record);
  record.set("value", copy(prop));
  record.set("rank", rank(index));
}

export function addProjectionGallerySlot(doc: Y.Doc, row: string, slot: ProjectionBag, index: number, id = `${row}:slot:${index}`): void {
  const value = new Y.Map<unknown>();
  row = wireIdentity(row); id = wireIdentity(id);
  doc.getMap("gallery").set(id, value);
  value.set("beat", row);
  value.set("rank", rank(index));
  value.set("keys", Object.keys(slot));
  const picture: ProjectionBag = {};
  for (const key of ["imageRef", "name", "annotation"]) setIf(slot, key, picture);
  value.set("picture", picture);
  value.set("extra", JSON.stringify(without(slot, ["imageRef", "name", "annotation", "links"])));
  const links = new Y.Map<unknown>();
  value.set("links", links);
  records(slot.links).forEach((link, linkIndex) => {
    const record = new Y.Map<unknown>();
    const key = wireIdentity(videoLinkKey(link as VideoLink));
    links.set(key, record);
    writeRecord(record, without(link, ["location"]), ["href", "name", "size", "duration", "poster"]);
    record.set("rank", rank(linkIndex));
  });
}

function addText(replica: SchemaReplica, id: string, kind: "b" | "h", value: string, source: ProjectionBag): void {
  id = wireIdentity(id);
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
  else insertHtml(text, value, source.productionTags, source.comments, `${id}:audioText`);
}

export function createProjectionReplica(candidate: SchemaCandidate, client = 10): SchemaReplica {
  const replica = new SchemaReplica(candidate, client, new IdentityBook());
  replica.doc.getMap("headings");
  return replica;
}

export function fromDocument(source: ProjectionBag, candidate: SchemaCandidate, client = 10): SchemaReplica {
  source = bag(normalizeIdentityTree(source));
  const replica = createProjectionReplica(candidate, client);
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
      insertHtml(text, String(row.visualText ?? ""), source.productionTags, source.comments, `${String(row.id)}:visualText`);
      const first: ProjectionBag = {};
      setIf(row, "imageRef", first);
      setIf(row, "imageName", first, "name");
      setIf(row, "imageAnnotation", first, "annotation");
      setIf(row, "imageLinks", first, "links");
      addProjectionGallerySlot(replica.doc, String(row.id), first, 0);
      records(row.moreImages).forEach((slot, index) => addProjectionGallerySlot(replica.doc, String(row.id), slot, index + 1));
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
  return assembleReaderBlocks(readerBlockStreams(doc, candidate, readerBlockDelta)).map(span => span.block);
}

function registry(doc: Y.Doc, root: string, fields: readonly string[]): ProjectionBag[] {
  return ranked(rootMap(doc, root)).map(([, value]) => {
    const record = readRecord(value, fields);
    if (root === "shots") {
      const props = ranked(value.get("props")).flatMap(([, prop]) => { const data = readWireRecord(prop.get("value")); return data ? [literalRecord(data, ["id", "name"])] : []; });
      if (props.length || stringKeys(value.get("keys")).includes("props")) record.props = props;
    }
    return literalRecord(record, root === "people" ? PERSON : root === "tags" ? TAG : [...SHOT, "props"], stringKeys(value.get("keys")));
  });
}

function galleryFor(doc: Y.Doc, id: string): ProjectionBag[] {
  return ranked(rootMap(doc, "gallery")).filter(([, value]) => readWireValue(value.get("beat")) === id).map(([, value]) => {
    const result = readRecord(value, []), picture = bag(readWireValue(value.get("picture")));
    mergeLiteralFields(result, picture, ["imageRef", "name", "annotation"]);
    const links = ranked(value.get("links")).map(([, link]) => readRecord(link, ["href", "name", "size", "duration", "poster"]));
    if (links.length || stringKeys(value.get("keys")).includes("links")) result.links = links;
    return literalRecord(result, ["imageRef", "name", "annotation", "links"], stringKeys(value.get("keys")));
  });
}

function projectionSections(doc: Y.Doc, blocks: readonly ProjectionBlock[]): ProjectionBag[] {
  const sections: ProjectionBag[] = [];
  let heading: ProjectionBlock | undefined;
  for (const block of blocks) {
    if (block.kind === "h") heading = block;
    else if (heading) {
      const name = heading.delta.map(item => typeof item.insert === "string" ? item.insert : "").join("");
      if (name) sections.push(literalRecord({ id: heading.id, name, firstSceneId: block.id }, ["id", "name", "firstSceneId"], stringKeys(sharedMapRecord(identityGet(rootMap(doc, "headings"), heading.id))?.get("keys"))));
      heading = undefined;
    }
  }
  return sections;
}

export function toDocument(doc: Y.Doc, candidate: SchemaCandidate, options: ProjectionOptions = {}): ProjectionBag {
  const meta = rootMap(doc, "meta") ?? new Map<string, unknown>();
  const result = readRecord(meta, META);
  const capture = bag(readWireValue(meta.get("capture")));
  mergeLiteralFields(result, capture, CAPTURE);
  const title = meta.get("title"); result.title = title instanceof Y.Text ? readWireValue(title.toString()) : "";
  result.people = registry(doc, "people", PERSON);
  result.productionTags = registry(doc, "tags", TAG);
  result.brollShots = registry(doc, "shots", SHOT);
  const comments = ranked(rootMap(doc, "comments")).map(([, value]) => {
    const comment = readRecord(value, COMMENT);
    const resolution = bag(readWireValue(value.get("resolution")));
    mergeLiteralFields(comment, resolution, ["resolved", "resolvedAt", "resolvedBy"]);
    if (value.has("text")) comment.body = readWireValue(value.get("text"));
    if (value.has("quote")) comment.quotedText = readWireValue(value.get("quote"));
    comment.replies = ranked(rootMap(doc, "replies")).filter(([, reply]) => readWireValue(reply.get("commentId")) === comment.id).map(([, reply]) => {
      const record = readRecord(reply, REPLY);
      record.body = readWireValue(reply.get("text"));
      return literalRecord(record, [...REPLY, "body"], stringKeys(reply.get("keys")));
    });
    return literalRecord(comment, [...COMMENT, ...COMMENT_SPECIAL], stringKeys(value.get("keys")));
  });
  result.comments = comments;
  const rows: ProjectionBag[] = [];
  const blocks = options.blocks ?? projectionBlocks(doc, candidate), sections = projectionSections(doc, options.sectionBlocks ?? blocks);
  const anchors = new Map<string, { rowId: string; field: string }>();
  function collectAnchors(delta: readonly ProjectionDelta[], rowId: string, field: string): void {
    for (const item of delta) for (const [key, value] of Object.entries(item.attributes ?? {})) {
      if (value && key.startsWith("c:") && !anchors.has(key.slice(2))) anchors.set(key.slice(2), { rowId, field });
    }
  }
  for (const block of blocks) {
    if (block.kind === "h") continue;
    const beat = sharedMapRecord(identityGet(rootMap(doc, "beats"), block.id)) ?? new Map<string, unknown>();
    const row = readRecord(beat, BEAT);
    row.id = block.id;
    const stamp = bag(readWireValue(beat.get("stamp")));
    setIf(stamp, "by", row, "updatedBy");
    setIf(stamp, "at", row, "updatedAt");
    row.audioText = deltaToHtml(block.delta, result.productionTags, comments, options.deriveCue);
    row.visualText = identityEntries(rootMap(doc, "visuals")).flatMap(([id, raw]) => { const value = readVisualRecord(raw); return value ? [{ id, beat: value.beat, rank: value.rank, text: value.text }] : []; })
      .filter(value => value.beat === block.id).sort((a, b) => compareCodeUnits(a.rank, b.rank) || compareCodeUnits(a.id, b.id)).map(value => {
        const delta = readDelta(value.text);
        collectAnchors(delta, block.id, "visualText");
        return deltaToHtml(delta, result.productionTags, comments, options.deriveCue);
      }).filter(Boolean).join("<br>");
    collectAnchors(block.delta, block.id, "audioText");
    const slots = galleryFor(doc, block.id);
    const first = slots[0] ?? {};
    setIf(first, "imageRef", row);
    setIf(first, "name", row, "imageName");
    setIf(first, "annotation", row, "imageAnnotation");
    setIf(first, "links", row, "imageLinks");
    if (slots.length > 1 || stringKeys(beat.get("keys")).includes("moreImages")) row.moreImages = slots.slice(1);
    rows.push(literalRecord(row, ["id", "audioText", "visualText", "status", "lengthSeconds", "paragraphStart", ...ROW_SPECIAL], stringKeys(beat.get("keys"))));

  }
  result.rows = rows;
  for (const comment of comments) {
    const anchor = typeof comment.id === "string" ? anchors.get(comment.id) : undefined;
    if (anchor) { comment.rowId = anchor.rowId; comment.field = anchor.field; }
  }
  if (sections.length || stringKeys(meta.get("keys")).includes("sections")) result.sections = sections;
  return literalRecord(result, ["schema", "title", ...META, ...CAPTURE, "rows", "sections", "comments", "people", "productionTags", "brollShots"], stringKeys(meta.get("keys")));
}
