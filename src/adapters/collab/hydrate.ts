import * as Y from "yjs";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { videoLinkKey } from "../../core/document/gallery.ts";
import type { VideoLink } from "../../core/document/gallery.ts";
import { brollPropKey } from "../../core/document/broll.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { transactSharedDocument } from "./document.ts";
import { collabState } from "./state.ts";
import { insertSharedHtml } from "./text-import.ts";

type ImportBag = Record<string, unknown>;

const metaFields = ["docId", "wordsPerMinute", "targetSeconds", "paragraphsDecided", "schema"];
const captureFields = ["rev", "lastEditedBy", "lastEditedAt", "personColors"];
const beatFields = ["id", "status", "lengthSeconds", "paragraphStart"];
const rowSpecial = ["audioText", "visualText", "updatedAt", "updatedBy", "imageRef", "imageName", "imageAnnotation", "imageLinks", "moreImages", "visualImage"];
const commentFields = ["id", "rowId", "field", "anchorId", "author", "createdAt", "updatedAt", "assignee", "kind", "imageValue", "conflictField", "emptyValue", "titleValue"];
const commentSpecial = ["body", "quotedText", "resolved", "resolvedAt", "resolvedBy", "replies"];

function records(value: unknown): ImportBag[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Expected document records");
  const out: ImportBag[] = [];
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Expected a document record");
    out.push(item as ImportBag);
  }
  return out;
}

function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function selected(source: ImportBag, keys: readonly string[]): ImportBag {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key) && source[key] !== undefined).map(key => [key, json(source[key])]));
}

function write(target: Y.Map<unknown>, source: ImportBag, fields: readonly string[], excluded: readonly string[] = []): void {
  for (const key of fields) if (Object.hasOwn(source, key) && source[key] !== undefined) target.set(key, json(source[key]));
  target.set("extra", JSON.stringify(selected(source, Object.keys(source).filter(key => !fields.includes(key) && !excluded.includes(key)).sort())));
}

function rank(index: number): string { return String(index).padStart(10, "0"); }

function unique(entries: readonly ImportBag[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) throw new Error("Duplicated or missing document identity");
    seen.add(entry.id);
  }
}

export function hydrateSharedDocument(handle: SharedDocumentHandle, source: ValidatedDocument): void {
  const state = collabState(handle);
  if (!state.fresh || Y.encodeStateAsUpdate(state.doc).length !== 2) throw new Error("Hydration requires a fresh empty shared document");
  const sections = records(source.sections);
  const tags = records(source.productionTags);
  for (const entries of [source.rows, sections, source.comments, source.people, tags, source.brollShots]) unique(entries);
  for (const comment of source.comments) unique(records(comment.replies));
  const roots = state.roots;
  transactSharedDocument(handle, "hydration", () => {
    write(roots.meta, source, metaFields, ["title", "titleOrigin", "titleVersion", "rows", "sections", "comments", "people", "productionTags", "brollShots", ...captureFields]);
    roots.meta.set("fileTitle", selected(source, ["titleOrigin", "titleVersion"]));
    roots.meta.set("capture", selected(source, captureFields));
    const title = new Y.Text();
    roots.meta.set("title", title);
    title.insert(0, source.title, {});
    for (const [root, entries, fields] of [
      [roots.people, source.people, ["id", "name"]],
      [roots.tags, tags, ["id", "cat", "name", "owner", "notes", "status"]],
      [roots.shots, source.brollShots, ["id", "name", "desc", "status", "reshoot", "notes", "audioRef", "location", "owner", "origin"]]
    ] as const) {
      entries.forEach((entry, index) => {
        const record = new Y.Map<unknown>();
        root.set(String(entry.id), record);
        write(record, entry, fields, root === roots.shots ? ["props"] : []);
        record.set("rank", rank(index));
        if (root === roots.shots) {
          const props = new Y.Map<unknown>();
          record.set("props", props);
          records(entry.props).forEach((prop, position) => {
            const value = new Y.Map<unknown>();
            props.set(brollPropKey(String(prop.id ?? ""), String(prop.name ?? "")), value);
            value.set("value", json(prop));
            value.set("rank", rank(position));
          });
        }
      });
    }
    function textSegment(id: string, kind: "b" | "h", html: string): void {
      const key = `${kind}:${id}`;
      const segment = new Y.Map<unknown>();
      roots.segments.set(key, segment);
      segment.set("head", { [kind]: id });
      const text = new Y.Text();
      segment.set("text", text);
      roots.order.push([key]);
      if (kind === "h") text.insert(0, html, {});
      else insertSharedHtml(text, html, tags, source.comments, `${key}:audioText`);
    }
    for (const row of source.rows) {
      for (const section of sections) if (section.firstSceneId === row.id) {
        textSegment(String(section.id), "h", String(section.name));
        const heading = new Y.Map<unknown>();
        roots.headings.set(String(section.id), heading);
        write(heading, section, ["id"], ["name", "firstSceneId"]);
      }
      textSegment(row.id, "b", row.audioText ?? "");
      const beat = new Y.Map<unknown>();
      roots.beats.set(row.id, beat);
      write(beat, row, beatFields, rowSpecial);
      beat.set("stamp", Object.fromEntries([["at", row.updatedAt], ["by", row.updatedBy]].filter(([, value]) => value !== undefined)));
      beat.set("joins", new Y.Map<unknown>());
      beat.set("removals", new Y.Map<unknown>());
      const visual = new Y.Map<unknown>();
      roots.visuals.set(row.id, visual);
      visual.set("beat", row.id);
      visual.set("rank", rank(0));
      const text = new Y.Text();
      visual.set("text", text);
      insertSharedHtml(text, row.visualText ?? "", tags, source.comments, `${row.id}:visualText`);
      const first = selected(row, ["imageRef", "imageLinks"]);
      if (Object.hasOwn(row, "imageName")) first.name = row.imageName;
      if (Object.hasOwn(row, "imageAnnotation")) first.annotation = row.imageAnnotation;
      first.links = first.imageLinks;
      delete first.imageLinks;
      [first, ...records(row.moreImages)].forEach((slot, index) => {
        const record = new Y.Map<unknown>();
        roots.gallery.set(`${row.id}:slot:${index}`, record);
        record.set("beat", row.id);
        record.set("rank", rank(index));
        record.set("picture", selected(slot, ["imageRef", "name", "annotation"]));
        write(record, slot, [], ["imageRef", "name", "annotation", "links"]);
        const links = new Y.Map<unknown>();
        record.set("links", links);
        records(slot.links).forEach((link, position) => {
          const value = new Y.Map<unknown>();
          links.set(videoLinkKey(link as VideoLink), value);
          write(value, link, ["href", "name", "size", "duration", "poster"], ["location"]);
          value.set("rank", rank(position));
        });
      });
    }
    source.comments.forEach((comment, index) => {
      const record = new Y.Map<unknown>();
      roots.comments.set(comment.id, record);
      write(record, comment, commentFields, commentSpecial);
      record.set("rank", rank(index));
      record.set("resolution", selected(comment, ["resolved", "resolvedAt", "resolvedBy"]));
      if (Object.hasOwn(comment, "body")) record.set("text", json(comment.body));
      if (Object.hasOwn(comment, "quotedText")) record.set("quote", json(comment.quotedText));
      records(comment.replies).forEach((reply, position) => {
        const value = new Y.Map<unknown>();
        roots.replies.set(JSON.stringify([comment.id, reply.id]), value);
        write(value, reply, ["id", "author", "createdAt"], ["body"]);
        value.set("commentId", comment.id);
        value.set("text", json(reply.body));
        value.set("rank", rank(position));
      });
    });
  });
}
