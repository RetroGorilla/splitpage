import * as Y from "yjs";
import { identityAt, mapValue, textValue } from "./schema.ts";
import type { SchemaReplica } from "./schema.ts";

export function structureManager(replica: SchemaReplica): Y.UndoManager {
  return new Y.UndoManager([
    replica.doc.getText("flow"), replica.doc.getMap("segments"), replica.doc.getArray("order"),
    replica.doc.getMap("beats"), replica.doc.getMap("comments"), replica.doc.getMap("replies")
  ] as Y.AbstractType<unknown>[], { trackedOrigins: new Set([replica.localOrigin]), captureTimeout: 1000 });
}

export function undoOne(manager: Y.UndoManager): void {
  const earlier = manager.undoStack.splice(0, Math.max(0, manager.undoStack.length - 1));
  try {
    manager.undo();
  } finally {
    manager.undoStack.unshift(...earlier);
  }
}

export function undoJoin(replica: SchemaReplica, manager: Y.UndoManager, from: string, into: string): void {
  const joins = mapValue(mapValue(replica.doc.getMap("beats").get(from)).get("joins"));
  replica.doc.transact(() => {
    for (const [id, value] of joins) {
      if ((value as { into: string }).into === into) replica.doc.getMap("retiredJoins").set(id, true);
    }
  }, "semantic-undo");
  manager.undoStack.pop();
}

export function clearGlue(replica: SchemaReplica, from: string): void {
  replica.doc.transact(() => {
    const joins = mapValue(mapValue(replica.doc.getMap("beats").get(from)).get("joins"));
    for (const [id, value] of joins) joins.set(id, { ...(value as object), glue: "" });
  }, replica.localOrigin);
}

function replaceBoundary(replica: SchemaReplica, id: string, head: { b: string } | { h: string }): void {
  const { text, start } = replica.locate(id);
  if (start === 0 && replica.candidate === "B") {
    for (const value of replica.doc.getMap("segments").values()) {
      const segment = mapValue(value);
      if (textValue(segment.get("text")) === text) segment.set("head", head);
    }
  } else {
    text.delete(start - 1, 1);
    text.insertEmbed(start - 1, head, {});
  }
}

function addRecord(replica: SchemaReplica, id: string): void {
  const record = new Y.Map<unknown>();
  replica.doc.getMap("beats").set(id, record);
  record.set("joins", new Y.Map());
  record.set("removals", new Y.Map());
}

export function removeHeading(replica: SchemaReplica, heading: string, newBeat: string, next: string): void {
  replica.doc.transact(() => {
    replaceBoundary(replica, heading, { b: newBeat });
    addRecord(replica, newBeat);
    mapValue(replica.doc.getMap("beats").get(next)).set("paragraphStart", true);
  }, replica.localOrigin);
}

export function createHeading(replica: SchemaReplica, beat: string, heading: string, nameLength: number, follows: boolean, names: readonly string[]): void {
  replica.doc.transact(() => {
    const location = replica.locate(beat);
    location.text.delete(location.start, 2);
    if (follows) location.text.delete(location.start + nameLength, 1);
    replaceBoundary(replica, beat, { h: heading });
    addRecord(replica, heading);
    const converted = replica.locate(heading);
    if (converted.start > 0) replica.identities.bind(names[0] ?? "heading", identityAt(converted.text, converted.start - 1));
    if (follows) {
      converted.text.insertEmbed(converted.start + nameLength, { b: beat }, {});
      replica.identities.bind(names[1] ?? "boundary", identityAt(converted.text, converted.start + nameLength));
    } else {
      mapValue(mapValue(replica.doc.getMap("beats").get(beat)).get("removals")).set(`became-${heading}`, true);
      const removal = new Y.Map<unknown>();
      replica.doc.getMap("removalRecords").set(`became-${heading}`, removal);
      removal.set("kind", "became-heading");
    }
  }, replica.localOrigin);
}

export function moveBeat(replica: SchemaReplica, beat: string, before: string | null): boolean {
  if (replica.candidate === "A") return false;
  const order = replica.doc.getArray<string>("order");
  const segmentId = `seg-${beat}`;
  const segment = mapValue(replica.doc.getMap("segments").get(segmentId));
  const text = textValue(segment.get("text"));
  if (text.toDelta().some((delta: { insert: unknown }) => typeof delta.insert !== "string")) return false;
  replica.doc.transact(() => {
    for (let index = order.length - 1; index >= 0; index--) if (order.get(index) === segmentId) order.delete(index, 1);
    const index = before === null ? order.length : order.toArray().indexOf(`seg-${before}`);
    if (index < 0) throw new Error("Missing move destination");
    order.insert(index, [segmentId]);
  }, replica.localOrigin);
  return true;
}

export function cutPaste(): boolean {
  return false;
}

export function seedJoinMetadata(replica: SchemaReplica): void {
  replica.doc.transact(() => {
    mapValue(replica.doc.getMap("beats").get("R1")).set("status", "todo");
    mapValue(replica.doc.getMap("beats").get("R2")).set("status", "ready");
    for (const [id, beat, value, notation] of [["V1", "R1", "v", "v1"], ["V2", "R2", "w", "w1"]]) {
      if (!id || !beat || !value || !notation) throw new Error("Incomplete visual seed");
      const component = new Y.Map<unknown>();
      replica.doc.getMap("visuals").set(id, component);
      component.set("beat", beat);
      component.set("rank", "0");
      const text = new Y.Text();
      component.set("text", text);
      text.insert(0, value, {});
      replica.identities.bind(notation, identityAt(text, 0));
    }
    const items = [
      { id: "gP1", beat: "R1", rank: "0", ref: "P", name: "", annotation: "", links: [{ href: "https://v/1" }] },
      { id: "gP2", beat: "R2", rank: "0", ref: "P", name: "wide", annotation: "", links: [{ href: "https://v/1", poster: "poster" }, { href: "https://v/2" }] },
      { id: "gQ", beat: "R2", rank: "1", ref: "Q", name: "", annotation: "", links: [] }
    ];
    for (const item of items) replica.doc.getMap("gallery").set(item.id, item);
  }, "fixture");
}

export function visualInsert(replica: SchemaReplica, component: string, offset: number, value: string, notation: string): Y.RelativePosition {
  const text = textValue(mapValue(replica.doc.getMap("visuals").get(component)).get("text"));
  replica.doc.transact(() => {
    text.insert(offset, value, {});
    replica.identities.bind(notation, identityAt(text, offset));
  }, replica.localOrigin);
  return Y.createRelativePositionFromTypeIndex(text, offset + value.length, -1);
}
