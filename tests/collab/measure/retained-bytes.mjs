import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as Y from "yjs";
import { createEncoder, length, writeVarString, writeAny } from "lib0/encoding";

export const retainedCategories = Object.freeze([
  "text content", "text identity", "birth range", "birth observed marks", "birth stamp or author",
  "birth keys and framing", "mark additions", "mark removals", "mark copies", "deletions",
  "split objects", "retirement observations", "removal marks", "structure",
  "undo heading observations", "undo beat observations", "undo replacement observations", "undo keying observations",
  "people", "shots", "tags", "comments", "rest", "update framing"
]);

function pathOf(type, doc) {
  if (!type._item) return [[...doc.share].find(([, value]) => value === type)?.[0] ?? "unknown"];
  return [...pathOf(type._item.parent, doc), type._item.parentSub ?? "[]"];
}

function fieldBytes(key, value) {
  const encoder = createEncoder();
  writeVarString(encoder, key); writeAny(encoder, value);
  return length(encoder);
}

function anyBytes(value) {
  const encoder = createEncoder(); writeAny(encoder, value); return length(encoder);
}

function categoryOf(path, item) {
  const root = path[0], key = item.parentSub ?? "";
  if (root === "creationRetired") {
    const value = item.content.getContent()[0];
    return value?.segment ? "undo heading observations" : "undo beat observations";
  }
  if (key === "creationRetired") return "undo beat observations";
  if (key === "deletion") return "removal marks";
  if (root === "removalRecords") return "removal marks";
  if (root === "retiredJoins" || key.startsWith("splitRetired:") || key === "retired") return "retirement observations";
  if (root === "meta" && key.startsWith("split")) return "split objects";
  if (root === "beats" && (key.startsWith("split") || item.parent instanceof Y.Map && item.parent.has("splitBy"))) return "split objects";
  if (["people", "shots", "tags"].includes(root)) return root;
  if (["comments", "replies"].includes(root)) return "comments";
  if (["segments", "beats", "visuals", "gallery", "order", "headings"].includes(root)) return "structure";
  return "rest";
}

export function retainedBytes(doc) {
  assert.equal(doc.store.pendingStructs, null, "account complete causal checkpoints only");
  assert.equal(doc.store.pendingDs, null, "account complete causal checkpoints only");
  const categories = Object.fromEntries(retainedCategories.map(key => [key, 0]));
  const observationReferences = { insertionBound: { count: 0, bytes: 0 }, range: { count: 0, bytes: 0 },
    unknown: { count: 0, bytes: 0 }, keysAndArrayFraming: 0 };
  let itemBytes = 0, structs = 0;
  for (const group of doc.store.clients.values()) for (const item of group) {
    const encoder = new Y.UpdateEncoderV1(); item.write(encoder, 0);
    const bytes = encoder.toUint8Array().length;
    itemBytes += bytes; structs++;
    if (!(item instanceof Y.Item) || item.content instanceof Y.ContentDeleted) {
      categories.deletions += bytes; continue;
    }
    const path = pathOf(item.parent, doc), value = item.content.getContent()[0];
    const markStore = ["markRecords", "titleMarks"].includes(path.at(-1));
    if (markStore && value?.type === "birth") {
      let fields = 0;
      let references = 0;
      for (const reference of value.observed) {
        const addition = item.parent.get(reference), count = anyBytes(reference);
        const part = addition?.type === "add" ? addition.born === null ? observationReferences.range : observationReferences.insertionBound
          : observationReferences.unknown;
        part.count++; part.bytes += count; references += count;
      }
      observationReferences.keysAndArrayFraming += fieldBytes("observed", value.observed) - references;
      for (const [key, part] of Object.entries(value)) {
        const count = fieldBytes(key, part); fields += count;
        const category = ["start", "end", "born"].includes(key) ? "birth range"
          : key === "observed" ? "birth observed marks" : ["writer", "by", "stamp"].includes(key)
            ? "birth stamp or author" : "birth keys and framing";
        categories[category] += count;
      }
      assert.ok(fields <= bytes);
      categories["birth keys and framing"] += bytes - fields;
    } else if (markStore && ["add", "remove"].includes(value?.type)) {
      const copied = value.operation?.includes('"mark-copy"');
      categories[copied ? "mark copies" : value.type === "add" ? "mark additions" : "mark removals"] += bytes;
    } else if (markStore && item.parentSub === "provenance") categories["mark copies"] += bytes;
    else if (item.parent instanceof Y.Text && item.content instanceof Y.ContentString) {
      const payload = Buffer.byteLength(item.content.str, "utf8");
      categories["text content"] += payload; categories["text identity"] += bytes - payload;
    } else if (item.parent instanceof Y.Text && item.content instanceof Y.ContentEmbed && !value?.b && !value?.h) {
      const content = new Y.UpdateEncoderV1(); item.content.write(content, 0);
      const payload = content.toUint8Array().length;
      categories["text content"] += payload; categories["text identity"] += bytes - payload;
    } else if (item.parent instanceof Y.Text && item.content instanceof Y.ContentFormat) {
      categories["mark additions"] += bytes;
    } else if (item.parent instanceof Y.Text && (value?.b || value?.h)) categories["split objects"] += bytes;
    else categories[categoryOf(path, item)] += bytes;
  }
  const encoded = Y.encodeStateAsUpdate(doc), decoded = Y.decodeUpdate(encoded), deletion = new Y.UpdateEncoderV1();
  deletion.writeLen(decoded.ds.clients.size);
  for (const [client, ranges] of decoded.ds.clients) {
    deletion.writeClient(client); deletion.writeLen(ranges.length);
    for (const range of ranges) { deletion.writeDsClock(range.clock); deletion.writeDsLen(range.len); }
  }
  const deleteSetBytes = deletion.toUint8Array().length;
  categories.deletions += deleteSetBytes;
  categories["update framing"] = encoded.length - itemBytes - deleteSetBytes;
  assert.ok(categories["update framing"] >= 0);
  assert.equal(Object.values(categories).reduce((sum, value) => sum + value, 0), encoded.length);
  assert.equal(observationReferences.insertionBound.bytes + observationReferences.range.bytes + observationReferences.unknown.bytes
    + observationReferences.keysAndArrayFraming, categories["birth observed marks"]);
  return { encodedBytes: encoded.length, categories, observationReferences, structs, deleteSetBytes };
}
