import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DocumentShape, ValidatedDocument } from "../../../src/core/document/validated.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { destroySharedDocument, encodeSharedState, applySharedUpdate } from "../../../src/adapters/collab/document.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";

export const projectionReferences = (JSON.parse(readFileSync(new URL("../../collab/fixtures/projection-reference.json", import.meta.url), "utf8")) as {
  fixtures: { name: string; document: DocumentShape; appSaved: { sha256: string } }[];
}).fixtures;

const keyOrders: Record<string, readonly string[]> = {
  document: ["schema", "title", "docId", "rows", "comments", "people", "productionTags", "brollShots", "wordsPerMinute", "rev", "lastEditedBy", "lastEditedAt"],
  row: ["id", "status", "visualText", "audioText", "imageRef", "updatedAt", "updatedBy"],
  comment: ["id", "rowId", "field", "anchorId", "quotedText", "author", "body", "resolved", "resolvedBy", "resolvedAt", "assignee", "createdAt", "updatedAt", "kind", "replies"],
  reply: ["id", "author", "body", "createdAt"], person: ["id", "name"], tag: ["id", "cat", "name", "owner", "notes", "status"],
  shot: ["id", "name", "desc", "status", "reshoot", "notes", "owner", "audioRef", "location", "props", "origin"],
  prop: ["id", "name"], section: ["id", "name", "firstSceneId"], gallery: ["imageRef", "name", "links", "annotation"],
  link: ["href", "name", "size", "location", "duration", "poster"], image: ["sha256", "width", "height", "mime"],
  annotation: ["imageRef", "marks"], mark: ["kind", "color", "width", "points", "size", "x", "y", "text"]
};
const children: Record<string, Record<string, string>> = {
  document: { rows: "row", comments: "comment", people: "person", productionTags: "tag", brollShots: "shot", sections: "section" },
  row: { imageRef: "image", moreImages: "gallery", imageLinks: "link", imageAnnotation: "annotation" },
  comment: { replies: "reply", imageValue: "image" }, shot: { props: "prop" },
  gallery: { imageRef: "image", links: "link", annotation: "annotation" }, annotation: { imageRef: "image", marks: "mark" }
};

export function rekeyLoadedDocument(input: unknown, kind = "document"): unknown {
  if (Array.isArray(input)) {
    const result = new Array<unknown>(input.length);
    for (let index = 0; index < input.length; index++) if (Object.hasOwn(input, index)) result[index] = rekeyLoadedDocument(input[index], kind);
    return result;
  }
  if (input === null || typeof input !== "object") return input;
  const source = input as Record<string, unknown>, known = Object.hasOwn(keyOrders, kind) ? keyOrders[kind] ?? [] : [];
  const keys = [...known.filter(key => Object.hasOwn(source, key)), ...Object.keys(source).filter(key => !known.includes(key)).sort()];
  const fields = Object.hasOwn(children, kind) ? children[kind] ?? {} : {};
  return Object.fromEntries(keys.map(key => [key, rekeyLoadedDocument(source[key], Object.hasOwn(fields, key) ? fields[key] : "unknown")]));
}

export function assertProjectionValues(actual: unknown, expected: unknown): void { assert.deepEqual(actual, expected); }

export function withFullProjectedFixture<T>(document: ValidatedDocument, read: (projected: DocumentShape) => T): T {
  const handle = createMonitoredSharedDocument(), late = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(handle, document); assert.equal(applySharedUpdate(late, encodeSharedState(handle)).ok, true);
    const projected = projectSharedDocument(late);
    assertReplicasAgree("full fixture encoded transfer", [{ order: "D1", replica: "A", output: projectSharedDocument(handle) }, { order: "late-C", replica: "C", output: projected }]);
    return read(projected);
  } finally { destroySharedDocument(handle); destroySharedDocument(late); }
}
