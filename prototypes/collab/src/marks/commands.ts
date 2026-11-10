import { identityEntries, identityGet, identityHas, wireIdentity } from "../readers/identity.ts";
import * as Y from "yjs";
import { mapValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import type { CollabMarks } from "../model.ts";
import type { ReplicaCaretAnchor } from "../reader.ts";
import type { StructuralRangeCapture } from "../structure-selection.ts";
import { restoreStructuralAnchor } from "../structure-selection.ts";
import { undoOne } from "../structure.ts";
import { readStatusEvent, resolveBeatStatus, statusHeads } from "./status-resolution.ts";
import type { BeatStatusEvent } from "./status-resolution.ts";
import { readBeatRecord, readMarkRecord, rootMap } from "../readers/records.ts";

export function formatCapturedMarks(replica: SchemaReplica, selection: StructuralRangeCapture, marks: CollabMarks): void {
  marks = readMarkRecord(marks);
  const start = Y.createAbsolutePositionFromRelativePosition(selection.selection.position, replica.doc, false);
  const end = Y.createAbsolutePositionFromRelativePosition(selection.selection.selectionEnd ?? selection.selection.position, replica.doc, false);
  if (!start || !end || !(start.type instanceof Y.Text) || start.type !== end.type) throw new Error("Format selection unavailable");
  const text = start.type;
  replica.doc.transact(() => text.format(start.index, end.index - start.index, marks), replica.localOrigin);
}

export function undoCapturedMarks(replica: SchemaReplica, manager: Y.UndoManager, selection: StructuralRangeCapture): ReplicaCaretAnchor {
  undoOne(manager);
  return restoreStructuralAnchor(replica, selection.selection);
}

export function addComment(replica: SchemaReplica, id: string, beat: string, offset: number, length: number, author: string): void {
  id = wireIdentity(id); beat = wireIdentity(beat);
  replica.doc.transact(() => {
    replica.format(beat, offset, length, { [`c:${id}`]: true });
    const comment = new Y.Map<unknown>();
    replica.doc.getMap("comments").set(id, comment);
    for (const [key, value] of Object.entries({ author, createdAt: 0, text: "", rowId: beat, field: "audioText" })) comment.set(key, value);
  }, replica.localOrigin);
}

export function addReply(replica: SchemaReplica, id: string, commentId: string, author: string, createdAt = 0): void {
  id = wireIdentity(id); commentId = wireIdentity(commentId);
  replica.doc.transact(() => {
    const reply = new Y.Map<unknown>();
    replica.doc.getMap("replies").set(id, reply);
    for (const [key, value] of Object.entries({ commentId, author, createdAt, text: "" })) reply.set(key, value);
  }, replica.localOrigin);
}

export function editAuthoredRecord(replica: SchemaReplica, collection: "comments" | "replies", id: string, author: string, text: string): boolean {
  id = wireIdentity(id);
  const item = mapValue(identityGet(replica.doc.getMap(collection), id));
  if (item.get("author") !== author) return false;
  replica.doc.transact(() => item.set("text", text), replica.localOrigin);
  return true;
}

export function ensureTag(replica: SchemaReplica, kind: string, name: string): string {
  kind = wireIdentity(kind); name = wireIdentity(name);
  const id = `tag-${kind}-${Array.from(new TextEncoder().encode(name), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  if (!replica.doc.getMap("tags").has(id)) replica.doc.transact(() => replica.doc.getMap("tags").set(id, { kind, name }), replica.localOrigin);
  return id;
}

function statusEvents(replica: SchemaReplica, target: string): [string, BeatStatusEvent][] {
  const result: [string, BeatStatusEvent][] = [];
  for (const [id, raw] of identityEntries(rootMap(replica.doc, "statusEvents"))) {
    const event = readStatusEvent(raw); if (event?.target === target) result.push([id, event]);
  }
  return result;
}

export function statusFrontier(replica: SchemaReplica, target: string): [string, BeatStatusEvent][] {
  target = wireIdentity(target);
  const events = new Map(statusEvents(replica, target));
  const heads = new Set(statusHeads(events));
  return [...events].filter(([id]) => heads.has(id));
}

export function statusValue(replica: SchemaReplica, target: string): string {
  target = wireIdentity(target);
  return resolveBeatStatus(new Map(statusEvents(replica, target)), { has: (id: string) => identityHas(rootMap(replica.doc, "retiredStatus"), id) },
    readBeatRecord(identityGet(rootMap(replica.doc, "beats"), target)).status ?? "undefined");
}

export function changeStatus(replica: SchemaReplica, manager: Y.UndoManager, target: string, id: string, value: string, by: string): void {
  id = wireIdentity(id); target = wireIdentity(target);
  const frontier = statusFrontier(replica, target);
  const validated = readStatusEvent({ target, value, parents: frontier.map(([key]) => key).sort(), by });
  if (!validated) throw new Error("Invalid status command");
  const event = { target: validated.target, value: validated.value, prior: statusValue(replica, target), parents: validated.parents, by: validated.by };
  manager.stopCapturing();
  replica.doc.transact(() => replica.doc.getMap("statusEvents").set(id, event), replica.localOrigin);
  const item = manager.undoStack.at(-1);
  if (!item) throw new Error("Status command was not captured");
  item.meta.set("statusEvent", id);
  manager.stopCapturing();
}

export function undoStatus(replica: SchemaReplica, manager: Y.UndoManager): void {
  const id: unknown = manager.undoStack.at(-1)?.meta.get("statusEvent");
  if (typeof id !== "string") throw new Error("Top undo item is not a status command");
  const event = readStatusEvent(identityGet(replica.doc.getMap("statusEvents"), id));
  if (!event) throw new Error("Missing local status command");
  const frontier = statusFrontier(replica, event.target);
  if (frontier.some(([key]) => key === id)) {
    replica.doc.transact(() => {
      for (const [key] of frontier) if (!identityHas(replica.doc.getMap("retiredStatus"), key)) replica.doc.getMap("retiredStatus").set(key, true);
    }, "semantic-undo");
  }
  manager.undoStack.pop();
}
