import assert from "node:assert/strict";
import * as Y from "yjs";
import { length } from "lib0/encoding";
import { mapValue, textValue } from "../../schema.ts";
import type { SchemaReplica } from "../../schema.ts";

export const lifetimeCategories = ["live text items", "deleted text tombstones", "soft-removed beat content", "removal records", "join records and retired ids", "status events", "marks", "order array", "other"] as const;
export type LifetimeByteCategory = typeof lifetimeCategories[number];

export function lifetimeRoot(type: Pick<Y.AbstractType<unknown>, "_item" | "doc">): string {
  let current = type;
  while (current._item) {
    const parent = current._item.parent;
    if (!(parent instanceof Y.AbstractType)) break;
    current = parent;
  }
  for (const [name, value] of type.doc?.share ?? []) if (value === current) return name;
  return "unknown";
}

export function attributeLifetimeBytes(replica: SchemaReplica) {
  const categories = Object.fromEntries(lifetimeCategories.map(key => [key, 0])) as Record<LifetimeByteCategory, number>;
  const removed = new Set([...replica.doc.getMap("beats")].filter(([, value]) => mapValue(mapValue(value).get("removals")).size).map(([id]) => id));
  const soft = new Set<Y.Item>();
  const softParents = new WeakSet<object>();
  const retain = (type: Y.Map<unknown>): void => {
    softParents.add(type);
    for (const value of type.values()) if (value instanceof Y.Map) retain(value); else if (value instanceof Y.Text) softParents.add(value);
  };
  for (const id of removed) retain(mapValue(replica.doc.getMap("beats").get(id)));
  for (const root of ["visuals", "gallery"]) for (const value of replica.doc.getMap(root).values()) {
    const record = mapValue(value); if (removed.has(String(record.get("beat")))) retain(record);
  }
  const scan = (text: Y.Text, initial?: string): void => {
    let beat = initial;
    for (let item = text._start; item; item = item.right) {
      const content = item.content.getContent()[0] as { b?: string } | undefined;
      if (!item.deleted && content && typeof content === "object" && content.b) beat = content.b;
      if (beat && removed.has(beat)) soft.add(item);
    }
  };
  for (const value of replica.doc.getMap("segments").values()) {
    const segment = mapValue(value); scan(textValue(segment.get("text")), (segment.get("head") as { b?: string }).b);
  }
  for (const value of replica.doc.getMap("visuals").values()) {
    const visual = mapValue(value); scan(textValue(visual.get("text")), String(visual.get("beat")));
  }
  const classify = (item: Y.Item): LifetimeByteCategory => {
    if (!(item.parent instanceof Y.AbstractType)) return "other";
    const root = lifetimeRoot(item.parent);
    if (root === "removalRecords") return "removal records";
    if (root === "retiredJoins" || (root === "beats" && item.parent._item?.parentSub === "joins")) return "join records and retired ids";
    if (["statusEvents", "retiredStatus"].includes(root)) return "status events";
    if (root === "order") return "order array";
    if (soft.has(item) || softParents.has(item.parent) || (item.content instanceof Y.ContentType && softParents.has(item.content.type))) return "soft-removed beat content";
    if (item.parent instanceof Y.Text) {
      if (item.deleted) return "deleted text tombstones";
      if (item.content instanceof Y.ContentFormat) return "marks";
      if (item.content instanceof Y.ContentString || item.content instanceof Y.ContentEmbed) return "live text items";
    }
    return "other";
  };
  const write = Y.Item.prototype.write;
  const otherRoots: Record<string, number> = {};
  let itemBytes = 0, items = 0;
  Y.Item.prototype.write = function (encoder, offset): void {
    const start = length(encoder.restEncoder);
    write.call(this, encoder, offset);
    const bytes = length(encoder.restEncoder) - start;
    const category = classify(this);
    categories[category] += bytes; itemBytes += bytes; items++;
    if (category === "other") {
      const root = this.parent instanceof Y.AbstractType ? lifetimeRoot(this.parent) : "unknown";
      otherRoots[root] = (otherRoots[root] ?? 0) + bytes;
    }
  };
  let encoded: Uint8Array;
  try { encoded = Y.encodeStateAsUpdate(replica.doc); } finally { Y.Item.prototype.write = write; }
  const framingDeleteSetAndGcBytes = encoded.length - itemBytes;
  categories.other += framingDeleteSetAndGcBytes;
  assert.equal(Object.values(categories).reduce((sum, value) => sum + value, 0), encoded.length);
  return { encodedBytes: encoded.length, categories, otherRoots, items, framingDeleteSetAndGcBytes };
}
