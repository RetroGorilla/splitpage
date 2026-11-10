import * as Y from "yjs";
import type { CollabIdentity, CollabMarks } from "../model.ts";
import type { ReplicaCaretAnchor } from "../reader.ts";
import { identityAt, mapValue, textValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { caretAfterInserted, structuralCaret } from "../structure-selection.ts";
import { createHeading, removeHeading } from "../structure.ts";
import { normalizeIdentityTree } from "../readers/identity.ts";
import { writeStatusEvent } from "./history.ts";
import type { CommandHistory, CommandPart } from "./history.ts";
import { contentAt, itemAt, pointAt, resolveIdentity, selectionOf } from "./identity.ts";
import type { SelectionRecord, StoredContent } from "./identity.ts";

function caretBefore(text: Y.Text, index: number, start: number): SelectionRecord {
  return { start: index > start ? pointAt(text, index, -1) : pointAt(text, index, 0) };
}

function acceptCommand<Args extends unknown[], Result>(command: (history: CommandHistory, ...args: Args) => Result): (history: CommandHistory, ...args: Args) => Result {
  return (history, ...args) => command(history, ...normalizeIdentityTree(args) as Args);
}

export const insertText = acceptCommand(function (history: CommandHistory, beat: string, offset: number, value: string, names: readonly string[], marks: CollabMarks = {}): ReplicaCaretAnchor {
  const replica = history.replica;
  const before = replica.locate(beat);
  const selection = caretBefore(before.text, before.start + offset, before.start);
  replica.insert(beat, offset, value, names, marks);
  const { text, start } = replica.locate(beat);
  const part: CommandPart = history.defect === "positions"
    ? { kind: "positional", beat, offset, length: value.length }
    : { kind: "sequence", inserted: Array.from({ length: value.length }, (_, index) => identityAt(text, start + offset + index)), deleted: [] };
  history.record({ label: "insert", parts: [part], selection });
  return { position: Y.createRelativePositionFromTypeIndex(text, start + offset + value.length, -1) };
});

export const deleteRange = acceptCommand(function (history: CommandHistory, beat: string, from: number, to: number): ReplicaCaretAnchor {
  const replica = history.replica;
  const { text, start } = replica.locate(beat);
  const selection: SelectionRecord = { start: pointAt(text, start + from, 0), end: pointAt(text, start + to, -1) };
  const deleted: StoredContent[] = [];
  for (let index = start + from; index < start + to; index++) {
    deleted.push({ id: identityAt(text, index), ...contentAt(text, index) });
  }
  replica.doc.transact(() => text.delete(start + from, to - from), replica.localOrigin);
  history.record({ label: "delete", parts: [{ kind: "sequence", inserted: [], deleted }], selection });
  return { position: Y.createRelativePositionFromTypeIndex(text, start + from, -1) };
});

function formatParts(text: Y.Text, from: number, to: number, marks: CollabMarks): CommandPart[] {
  const first = itemAt(text, from);
  const last = itemAt(text, to - 1);
  if (!first || !last) throw new Error("Format range has no identities");
  return Object.keys(marks).map(key => ({
    kind: "format", key, first, last,
    prior: Array.from({ length: to - from }, (_, offset) => {
      const id = itemAt(text, from + offset);
      if (!id) throw new Error("Format character has no identity");
      return { id, value: contentAt(text, from + offset).attributes[key] ?? null };
    })
  }));
}

export const formatRange = acceptCommand(function (history: CommandHistory, beat: string, from: number, to: number, marks: CollabMarks, extra: CommandPart[] = [], label: string = "format"): void {
  const replica = history.replica;
  const { text, start } = replica.locate(beat);
  const selection: SelectionRecord = { start: pointAt(text, start + from, 0), end: pointAt(text, start + to, -1) };
  const parts = formatParts(text, start + from, start + to, marks);
  replica.doc.transact(() => {
    text.format(start + from, to - from, marks);
    for (const part of extra) {
      if (part.kind !== "record") continue;
      const record = new Y.Map<unknown>();
      replica.doc.getMap(part.collection).set(part.id, record);
      for (const [key, value] of Object.entries(part.fields)) record.set(key, value);
    }
  }, replica.localOrigin);
  history.record({ label, parts: [...parts, ...extra], selection });
});

export const formatSelection = acceptCommand(function (history: CommandHistory, anchor: ReplicaCaretAnchor, marks: CollabMarks): void {
  const replica = history.replica;
  const start = Y.createAbsolutePositionFromRelativePosition(anchor.position, replica.doc, false);
  const end = Y.createAbsolutePositionFromRelativePosition(anchor.selectionEnd ?? anchor.position, replica.doc, false);
  if (!start || !end || start.type !== end.type || !(start.type instanceof Y.Text)) throw new Error("Format selection unavailable");
  const text = textValue(start.type);
  const parts = formatParts(text, start.index, end.index, marks);
  replica.doc.transact(() => text.format(start.index, end.index - start.index, marks), replica.localOrigin);
  history.record({ label: "format", parts, selection: selectionOf(anchor) });
});

export function tagKey(tag: string, first: CollabIdentity, last: CollabIdentity): string {
  return `t:${tag}@${first.client}.${first.clock}-${last.client}.${last.clock}`;
}

export const tagRange = acceptCommand(function (history: CommandHistory, beat: string, from: number, to: number, tag: string, occurrence?: string): string {
  const { text, start } = history.replica.locate(beat);
  const first = itemAt(text, start + from);
  const last = itemAt(text, start + to - 1);
  if (!first || !last) throw new Error("Tag range has no identities");
  const key = occurrence ? `t:${occurrence}` : tagKey(tag, first, last);
  formatRange(history, beat, from, to, { [key]: tag }, [], "tag");
  return key;
});

export const addComment = acceptCommand(function (history: CommandHistory, id: string, beat: string, offset: number, length: number, author: string): void {
  const fields = { author, createdAt: 0, text: "", rowId: beat, field: "audioText" };
  formatRange(history, beat, offset, offset + length, { [`c:${id}`]: true }, [{ kind: "record", collection: "comments", id, fields, present: true }], "comment");
});

export const addReply = acceptCommand(function (history: CommandHistory, id: string, commentId: string, author: string, createdAt = 0): void {
  const replica = history.replica;
  const fields = { commentId, author, createdAt, text: "" };
  replica.doc.transact(() => {
    const reply = new Y.Map<unknown>();
    replica.doc.getMap("replies").set(id, reply);
    for (const [key, value] of Object.entries(fields)) reply.set(key, value);
  }, replica.localOrigin);
  history.record({ label: "reply", parts: [{ kind: "record", collection: "replies", id, fields, present: true }] });
});

export const split = acceptCommand(function (history: CommandHistory, beat: string, offset: number, newBeat: string, name: string, by?: string, caret?: ReplicaCaretAnchor): ReplicaCaretAnchor {
  const replica = history.replica;
  const before = replica.locate(beat);
  const selection: SelectionRecord = caret ? selectionOf(caret) : { start: pointAt(before.text, before.start + offset, 0) };
  replica.split(beat, offset, newBeat, name, by);
  const { text, start } = replica.locate(beat);
  history.record({ label: "split", parts: [{ kind: "sequence", inserted: [identityAt(text, start + offset)], deleted: [] }], selection });
  const next = replica.locate(newBeat);
  return { position: Y.createRelativePositionFromTypeIndex(next.text, next.start, -1) };
});

export const join = acceptCommand(function (history: CommandHistory, from: string, into: string, entry: string): void {
  history.replica.join(from, into, entry);
  history.record({ label: "join", parts: [{ kind: "join", from, into, entry }] });
});

export const removeBeat = acceptCommand(function (history: CommandHistory, beat: string, entry: string, by: string): void {
  const replica = history.replica;
  replica.doc.transact(() => {
    mapValue(mapValue(replica.doc.getMap("beats").get(beat)).get("removals")).clear();
    replica.remove(beat, entry, by);
  }, replica.localOrigin);
  history.record({ label: "remove", parts: [{ kind: "removal", beat, entry }] });
});

export const moveBeat = acceptCommand(function (history: CommandHistory, beat: string, before: string | null): boolean {
  const replica = history.replica;
  if (replica.candidate !== "B") return false;
  const order = replica.doc.getArray<unknown>("order");
  const segmentId = `seg-${beat}`;
  const text = textValue(mapValue(replica.doc.getMap("segments").get(segmentId)).get("text"));
  if (text.toDelta().some((delta: { insert: unknown }) => typeof delta.insert !== "string")) return false;
  const deleted: StoredContent[] = [];
  const moved: { id: CollabIdentity | null } = { id: null };
  replica.doc.transact(() => {
    for (let index = 0; index < order.length; index++) {
      const id = itemAt(order, index);
      if (order.get(index) === segmentId && id) deleted.push({ id, ...contentAt(order, index) });
    }
    for (let index = order.length - 1; index >= 0; index--) if (order.get(index) === segmentId) order.delete(index, 1);
    const index = before === null ? order.length : order.toArray().indexOf(`seg-${before}`);
    if (index < 0) throw new Error("Missing move destination");
    order.insert(index, [segmentId]);
    moved.id = itemAt(order, index);
  }, replica.localOrigin);
  if (!moved.id) throw new Error("Moved entry has no identity");
  history.record({ label: "move", parts: [{ kind: "sequence", inserted: [moved.id], deleted }] });
  return true;
});

function segmentWith(replica: SchemaReplica, text: Y.Text): string {
  for (const [id, value] of replica.doc.getMap("segments")) if (textValue(mapValue(value).get("text")) === text) return id;
  throw new Error("Text belongs to no segment");
}

function boundaryParts(replica: SchemaReplica, beat: string, head: { b: string } | { h: string }, change: () => void): { parts: CommandPart[]; deleted: StoredContent[]; inserted: () => CollabIdentity[] } {
  const location = replica.locate(beat);
  if (location.start === 0 && replica.candidate === "B") {
    const segment = segmentWith(replica, location.text);
    const prior: unknown = mapValue(replica.doc.getMap("segments").get(segment)).get("head");
    change();
    return { parts: [{ kind: "key", path: ["segments", segment], key: "head", prior, value: head }], deleted: [], inserted: () => [] };
  }
  const embed = identityAt(location.text, location.start - 1);
  const deleted = [{ id: embed, ...contentAt(location.text, location.start - 1) }];
  change();
  return { parts: [], deleted, inserted: () => {
    const after = replica.locate("b" in head ? head.b : head.h);
    return [identityAt(after.text, after.start - 1)];
  } };
}

function paragraphPart(replica: SchemaReplica, beat: string, value: unknown): CommandPart {
  return { kind: "key", path: ["beats", beat], key: "paragraphStart", prior: mapValue(replica.doc.getMap("beats").get(beat)).get("paragraphStart"), value };
}

export const removeHeadingRecord = acceptCommand(function (history: CommandHistory, heading: string, newBeat: string, next: string): void {
  const replica = history.replica;
  const paragraph = paragraphPart(replica, next, true);
  const boundary = boundaryParts(replica, heading, { b: newBeat }, () => removeHeading(replica, heading, newBeat, next));
  const sequence: CommandPart[] = boundary.deleted.length ? [{ kind: "sequence", inserted: boundary.inserted(), deleted: boundary.deleted }] : [];
  history.record({ label: "remove heading", parts: [...boundary.parts, ...sequence, { kind: "beat-record", id: newBeat, present: true }, paragraph] });
});

export const createHeadingRecord = acceptCommand(function (history: CommandHistory, beat: string, heading: string, nameLength: number, follows: boolean, names: readonly string[]): ReplicaCaretAnchor {
  const replica = history.replica;
  const order = [...new Set(replica.characters().map(character => character.beat))];
  const next = order[order.indexOf(beat) + 1];
  const caret = next ? structuralCaret(replica, next, 0) : null;
  const location = replica.locate(beat);
  const removed = [location.start, location.start + 1, ...(follows ? [location.start + 2 + nameLength] : [])]
    .map(index => ({ id: identityAt(location.text, index), ...contentAt(location.text, index) }));
  const boundary = boundaryParts(replica, beat, { h: heading }, () => createHeading(replica, beat, heading, nameLength, follows, names));
  const converted = replica.locate(heading);
  const inserted = [...boundary.inserted(), ...(follows ? [identityAt(converted.text, converted.start + nameLength)] : [])];
  const extra: CommandPart[] = follows ? [] : [
    { kind: "key", path: ["beats", beat, "removals"], key: `became-${heading}`, prior: undefined, value: true },
    { kind: "record", collection: "removalRecords", id: `became-${heading}`, fields: { kind: "became-heading" }, present: true }
  ];
  history.record({ label: "create heading", parts: [...boundary.parts, { kind: "sequence", inserted, deleted: [...boundary.deleted, ...removed] }, { kind: "beat-record", id: heading, present: true }, ...extra] });
  return { position: caret ?? structuralCaret(replica, heading, nameLength) };
});

export interface RangeCapture {
  fromBeat: string;
  selection: SelectionRecord;
  anchor: ReplicaCaretAnchor;
  collapse: Y.RelativePosition;
  deleted: StoredContent[];
  wholeBeats: { id: string; observed: CollabIdentity[] }[];
}

export const captureRange = acceptCommand(function (history: CommandHistory, fromBeat: string, from: number, toBeat: string, to: number): RangeCapture {
  const replica = history.replica;
  const anchor = { position: structuralCaret(replica, fromBeat, from), selectionEnd: structuralCaret(replica, toBeat, to, -1) };
  const characters = replica.characters();
  const start = characters.findIndex(character => character.beat === fromBeat) + from;
  const end = characters.findIndex(character => character.beat === toBeat) + to;
  if (start < 0 || end < start) throw new Error("Invalid structural selection");
  const selected = characters.slice(start, end);
  const wholeBeats = [...new Set(selected.map(character => character.beat))].filter(id => id !== fromBeat && id !== toBeat)
    .map(id => ({ id, observed: selected.filter(character => character.beat === id).map(character => character.identity) }));
  const whole = new Set(wholeBeats.map(beat => beat.id));
  const deleted = selected.filter(character => !whole.has(character.beat)).map(character => ({ id: character.identity, ...contentAt(character.text, character.index) }));
  return { fromBeat, selection: selectionOf(anchor), anchor, collapse: structuralCaret(replica, fromBeat, from, -1), deleted, wholeBeats };
});

export const replaceRange = acceptCommand(function (history: CommandHistory, capture: RangeCapture, value: string, names: readonly string[], by: string): ReplicaCaretAnchor {
  const replica = history.replica;
  let caret: ReplicaCaretAnchor = { position: capture.collapse };
  const inserted: CollabIdentity[] = [];
  const deleted: StoredContent[] = [];
  replica.doc.transact(() => {
    for (const beat of capture.wholeBeats) replica.remove(beat.id, `range-${beat.id}`, by, beat.observed);
    if (value) {
      const absolute = Y.createAbsolutePositionFromRelativePosition(capture.anchor.position, replica.doc, false);
      if (!absolute) throw new Error("Selection start unavailable");
      const location = replica.locate(capture.fromBeat);
      replica.insert(capture.fromBeat, absolute.index - location.start, value, names);
      inserted.push(...names.map(name => replica.identities.identity(name)));
      caret = caretAfterInserted(replica, names);
    }
    for (const content of [...capture.deleted].reverse()) {
      const at = resolveIdentity(replica.doc, content.id);
      if (!at?.live) continue;
      deleted.unshift(content);
      at.type.delete(at.index, 1);
    }
  }, replica.localOrigin);
  const removals: CommandPart[] = capture.wholeBeats.map(beat => ({ kind: "removal", beat: beat.id, entry: `range-${beat.id}` }));
  history.record({ label: "replace range", parts: [...removals, { kind: "sequence", inserted, deleted }], selection: capture.selection });
  return caret;
});

export const changeStatus = acceptCommand(function (history: CommandHistory, target: string, event: string, value: string, by: string): void {
  const replica = history.replica;
  replica.doc.transact(() => writeStatusEvent(replica, target, event, value, by), replica.localOrigin);
  history.record({ label: "status", parts: [{ kind: "status", target, event, value, by }] });
});

export const setScalar = acceptCommand(function (history: CommandHistory, beat: string, key: string, value: unknown): void {
  const replica = history.replica;
  const record = mapValue(replica.doc.getMap("beats").get(beat));
  const prior = record.get(key);
  replica.doc.transact(() => record.set(key, value), replica.localOrigin);
  history.record({ label: "scalar", parts: [{ kind: "scalar", beat, key, prior, value }] });
});
