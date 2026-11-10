import * as Y from "yjs";
import type { CollabIdentity } from "./model.ts";
import type { ReplicaCaretAnchor } from "./reader.ts";
import type { SchemaReplica, UndoIdentityAnchor } from "./schema.ts";
import { createHeading, undoOne } from "./structure.ts";

export interface StructuralRangeCapture {
  fromBeat: string;
  selection: ReplicaCaretAnchor;
  collapse: Y.RelativePosition;
  deleted: string[];
  wholeBeats: { id: string; observed: CollabIdentity[] }[];
  restores: UndoIdentityAnchor[];
}

export function structuralCaret(replica: SchemaReplica, beat: string, offset: number, assoc = 0): Y.RelativePosition {
  const location = replica.locate(beat);
  return Y.createRelativePositionFromTypeIndex(location.text, location.start + offset, assoc);
}

export function restoreStructuralAnchor(replica: SchemaReplica, anchor: ReplicaCaretAnchor): ReplicaCaretAnchor {
  const restore = (position: Y.RelativePosition): Y.RelativePosition => {
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, replica.doc, true);
    if (!absolute) throw new Error("Undo selection identity unavailable");
    return Y.createRelativePositionFromTypeIndex(absolute.type, absolute.index, position.assoc);
  };
  return { position: restore(anchor.position), ...(anchor.selectionEnd ? { selectionEnd: restore(anchor.selectionEnd) } : {}) };
}

export function caretAfterInserted(replica: SchemaReplica, names: readonly string[]): ReplicaCaretAnchor {
  const last = names.at(-1);
  if (!last) throw new Error("No inserted character for caret");
  const identity = replica.identities.identity(last);
  const character = replica.characters().find(item => item.identity.client === identity.client && item.identity.clock === identity.clock);
  if (!character) throw new Error("Inserted caret identity unavailable");
  return { position: Y.createRelativePositionFromTypeIndex(character.text, character.index + 1, -1) };
}

export function insertWithCaret(replica: SchemaReplica, beat: string, offset: number, value: string, names: readonly string[]): ReplicaCaretAnchor {
  replica.insert(beat, offset, value, names);
  return caretAfterInserted(replica, names);
}

export function splitWithCaret(replica: SchemaReplica, beat: string, offset: number, next: string, name: string): ReplicaCaretAnchor {
  replica.split(beat, offset, next, name);
  return { position: structuralCaret(replica, next, 0, -1) };
}

export function captureStructuralRange(replica: SchemaReplica, fromBeat: string, from: number, toBeat: string, to: number): StructuralRangeCapture {
  const selection = { position: structuralCaret(replica, fromBeat, from), selectionEnd: structuralCaret(replica, toBeat, to, -1) };
  const characters = replica.characters();
  const start = characters.findIndex(character => character.beat === fromBeat) + from;
  const end = characters.findIndex(character => character.beat === toBeat) + to;
  if (start < 0 || end < start) throw new Error("Invalid structural selection");
  const selected = characters.slice(start, end);
  const wholeBeats = [...new Set(selected.map(character => character.beat))].filter(id => id !== fromBeat && id !== toBeat).map(id => ({ id, observed: selected.filter(character => character.beat === id).map(character => character.identity) }));
  const whole = new Set(wholeBeats.map(beat => beat.id));
  const deleted = selected.filter(character => !whole.has(character.beat)).map(character => replica.identities.notation(character.identity));
  return { fromBeat, selection, collapse: structuralCaret(replica, fromBeat, from, -1), deleted, wholeBeats, restores: replica.captureUndoIdentities(deleted) };
}

export function replaceStructuralRange(replica: SchemaReplica, capture: StructuralRangeCapture, value: string, names: readonly string[], by: string): ReplicaCaretAnchor {
  let caret: ReplicaCaretAnchor = { position: capture.collapse };
  replica.doc.transact(() => {
    for (const beat of capture.wholeBeats) replica.remove(beat.id, `range-${beat.id}`, by, beat.observed);
    if (value) {
      const absolute = Y.createAbsolutePositionFromRelativePosition(capture.selection.position, replica.doc, false);
      if (!absolute) throw new Error("Selection start unavailable");
      const location = replica.locate(capture.fromBeat);
      replica.insert(capture.fromBeat, absolute.index - location.start, value, names);
      caret = caretAfterInserted(replica, names);
    }
    replica.deleteIdentities(capture.deleted);
  }, replica.localOrigin);
  return caret;
}

export function undoStructuralRange(replica: SchemaReplica, manager: Y.UndoManager, capture: StructuralRangeCapture): ReplicaCaretAnchor {
  undoOne(manager);
  replica.bindUndoRestores(capture.restores);
  return restoreStructuralAnchor(replica, capture.selection);
}

export function planHeadingWithCaret(replica: SchemaReplica, beat: string, heading: string, nameLength: number, follows: boolean, names: readonly string[]): () => ReplicaCaretAnchor {
  const order = [...new Set(replica.characters().map(character => character.beat))];
  const next = order[order.indexOf(beat) + 1];
  const position = next ? structuralCaret(replica, next, 0) : null;
  return () => {
    createHeading(replica, beat, heading, nameLength, follows, names);
    return { position: position ?? structuralCaret(replica, heading, nameLength) };
  };
}
