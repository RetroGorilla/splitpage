export type SharedProjectionKind = "document" | "row" | "comment" | "reply" | "person" | "tag" | "shot" | "prop" | "section" | "gallery" | "link" | "image" | "annotation" | "mark" | "unknown";

import { cleanId } from "../../document/text-policy.ts";

function fieldOrder(kind: SharedProjectionKind): readonly string[] {
  const orders: Record<SharedProjectionKind, readonly string[]> = {
    document: ["schema", "title", "docId", "rows", "comments", "people", "productionTags", "brollShots", "wordsPerMinute", "rev", "lastEditedBy", "lastEditedAt"],
    row: ["id", "status", "visualText", "audioText", "imageRef", "updatedAt", "updatedBy"],
    comment: ["id", "rowId", "field", "anchorId", "quotedText", "author", "body", "resolved", "resolvedBy", "resolvedAt", "assignee", "createdAt", "updatedAt", "kind", "replies"],
    reply: ["id", "author", "body", "createdAt"], person: ["id", "name"],
    tag: ["id", "cat", "name", "owner", "notes", "status"],
    shot: ["id", "name", "desc", "status", "reshoot", "notes", "owner", "audioRef", "location", "props", "origin"],
    prop: ["id", "name"], section: ["id", "name", "firstSceneId"], gallery: ["imageRef", "name", "links", "annotation"],
    link: ["href", "name", "size", "location", "duration", "poster"], image: ["sha256", "width", "height", "mime"],
    annotation: ["imageRef", "marks"], mark: ["kind", "color", "width", "points", "size", "x", "y", "text"], unknown: []
  };
  return orders[kind];
}

function child(kind: SharedProjectionKind, key: string): SharedProjectionKind {
  if (kind === "document") {
    const kinds: Record<string, SharedProjectionKind> = { rows: "row", comments: "comment", people: "person", productionTags: "tag", brollShots: "shot", sections: "section" };
    return Object.hasOwn(kinds, key) ? kinds[key] ?? "unknown" : "unknown";
  }
  if (kind === "comment" && key === "replies") return "reply";
  if (kind === "shot" && key === "props") return "prop";
  if (kind === "row" && key === "moreImages") return "gallery";
  if ((kind === "row" && key === "imageLinks") || kind === "gallery" && key === "links") return "link";
  if ((kind === "row" && key === "imageAnnotation") || kind === "gallery" && key === "annotation") return "annotation";
  if (["row", "gallery", "annotation", "comment"].includes(kind) && ["imageRef", "imageValue"].includes(key)) return "image";
  return kind === "annotation" && key === "marks" ? "mark" : "unknown";
}

export function canonicalSharedProjection(value: unknown, kind: SharedProjectionKind = "document",
  reuse?: (source: object, context: SharedProjectionKind, build: () => unknown) => unknown): unknown {
  if (value !== null && typeof value === "object" && reuse) return reuse(value, kind, () => canonicalSharedProjectionBody(value, kind, reuse));
  return canonicalSharedProjectionBody(value, kind, reuse);
}

function canonicalSharedProjectionBody(value: unknown, kind: SharedProjectionKind,
  reuse?: (source: object, context: SharedProjectionKind, build: () => unknown) => unknown): unknown {
  if (Array.isArray(value)) return Array.from(value, item => canonicalSharedProjection(item, kind, reuse));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>, known = fieldOrder(kind);
  const keys = [...known.filter(key => Object.hasOwn(source, key)), ...Object.keys(source).filter(key => !known.includes(key)).sort()];
  return Object.fromEntries(keys.map(key => {
    const value = source[key], beatId = kind === "row" && key === "id" || kind === "section" && key === "firstSceneId" || kind === "comment" && key === "rowId";
    return [key, canonicalSharedProjection(beatId && typeof value === "string" ? cleanId(value) : value, child(kind, key), reuse)];
  }));
}
