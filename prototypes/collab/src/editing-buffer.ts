import * as Y from "yjs";
import type { CollabIdentity } from "./model.ts";
import type { ReplicaCaretAnchor } from "./reader.ts";
import type { SchemaReplica, UndoIdentityAnchor } from "./schema.ts";
import { mapValue } from "./schema.ts";
import { eventHistory } from "./event-history.ts";

export const bufferMechanisms = ["M1", "M2", "M3"] as const;
export type BufferMechanism = typeof bufferMechanisms[number];

export interface PaintedBeat {
  epoch: number;
  id: string;
  value: string;
  identities: CollabIdentity[];
  names: string[];
  runs: { insert: string; attributes: Record<string, unknown> }[];
  version: string;
  positions: Y.RelativePosition[];
}

export interface NativeSplice {
  from: number;
  to: number;
  insert: string;
}

export type SyntheticEditEvent =
  | { type: "compositionstart"; from: number; to: number }
  | { type: "compositionupdate"; data: string }
  | { type: "compositionend"; names: string[] }
  | { type: "beforeinput"; from: number; to: number; data: string; selection?: readonly [number, number]; names: string[] };

export class BufferMappingError extends Error {}
export class BufferQueueBoundError extends Error {}

export function minimalSplices(before: string, after: string): NativeSplice[] {
  let cost = Infinity;
  const result: NativeSplice[] = [];
  for (let from = 0; from <= Math.min(before.length, after.length); from++) {
    for (let to = from; to <= before.length; to++) {
      const inserted = after.length - before.length + to - from;
      if (inserted < 0) continue;
      const insert = after.slice(from, from + inserted);
      if (before.slice(0, from) + insert + before.slice(to) !== after) continue;
      const nextCost = to - from + inserted;
      if (nextCost > cost) continue;
      if (nextCost < cost) result.length = 0;
      cost = nextCost;
      result.push({ from, to, insert });
    }
  }
  return result;
}

function sameIdentity(left: CollabIdentity, right: CollabIdentity): boolean {
  return left.client === right.client && left.clock === right.clock;
}

export class EditableBeatBuffer {
  readonly editor: SchemaReplica;
  readonly network: SchemaReplica;
  readonly mechanism: BufferMechanism;
  readonly history: string[];
  readonly undoManager: Y.UndoManager;
  painted: PaintedBeat | null = null;
  nativeValue = "";
  caret: ReplicaCaretAnchor | null = null;
  dirty = false;
  composing = false;
  paintHeld = false;
  targetEvidence = true;
  queueLimitBytes = 64 * 1024;
  heldBytes = 0;
  readonly held: Uint8Array[] = [];
  private origins: (number | null)[] = [];
  private compositionRange: { from: number; to: number } | null = null;
  private undoStart: ReplicaCaretAnchor | null = null;
  private readonly undoDeleted = new Map<string, UndoIdentityAnchor>();
  private fault: BufferQueueBoundError | null = null;
  private readonly editorListener: (update: Uint8Array, origin: unknown) => void;
  private readonly networkListener: (update: Uint8Array, origin: unknown) => void;

  constructor(editor: SchemaReplica, mechanism: BufferMechanism, network: SchemaReplica = editor, record?: (line: string) => void) {
    this.history = eventHistory(record);
    this.editor = editor;
    this.network = network;
    this.mechanism = mechanism;
    this.undoManager = editor.undoManager();
    this.editorListener = (update, origin) => {
      if (origin !== "network") Y.applyUpdate(network.doc, update, "editor-forward");
    };
    this.networkListener = (update, origin) => {
      if (origin !== "delivery") return;
      try {
        this.forwardInbound(update);
      } catch (error) {
        if (!(error instanceof BufferQueueBoundError)) throw error;
        this.fault = error;
      }
    };
    if (mechanism === "M3") {
      editor.doc.on("update", this.editorListener);
      network.doc.on("update", this.networkListener);
    }
  }

  private snapshot(id: string): PaintedBeat {
    const { text, start, end } = this.editor.locate(id);
    const characters = this.editor.characters().filter(character => character.beat === id);
    const runs: PaintedBeat["runs"] = [];
    let index = 0;
    for (const delta of text.toDelta()) {
      const insert: unknown = delta.insert;
      const length = typeof insert === "string" ? insert.length : 1;
      if (typeof insert === "string" && index < end && index + length > start) {
        runs.push({ insert: insert.slice(Math.max(0, start - index), end - index), attributes: { ...delta.attributes } as Record<string, unknown> });
      }
      index += length;
    }
    const identities = characters.map(character => character.identity);
    const removals = [...mapValue(mapValue(this.editor.doc.getMap("beats").get(id)).get("removals")).keys()].sort();
    return {
      epoch: 1,
      id,
      value: characters.map(character => character.value).join(""),
      identities,
      names: identities.map(identity => this.editor.identities.notation(identity)),
      runs,
      version: JSON.stringify({ identities, runs, removals }),
      positions: Array.from({ length: end - start + 1 }, (_, offset) => Y.createRelativePositionFromTypeIndex(text, start + offset, offset === end - start ? -1 : 0))
    };
  }

  paint(id: string, from: number, to = from): void {
    if (this.dirty) throw new Error("Cannot replace a dirty native buffer");
    const painted = this.snapshot(id);
    const position = painted.positions[from];
    const selectionEnd = painted.positions[to];
    if (!position || !selectionEnd) throw new Error("Paint selection outside the beat");
    this.painted = painted;
    this.nativeValue = painted.value;
    this.origins = painted.identities.map((_, index) => index);
    this.caret = { position, ...(from === to ? {} : { selectionEnd }) };
    this.history.push(`paint ${id} ${JSON.stringify(painted.value)} [${painted.names.join(" ")}] selection ${from}:${to}`);
  }

  private requirePaint(): PaintedBeat {
    if (!this.painted) throw new Error("No paint-time base");
    return this.painted;
  }

  private begin(from: number, to: number): void {
    if (this.dirty) return;
    const painted = this.requirePaint();
    const position = painted.positions[from];
    const selectionEnd = painted.positions[to];
    if (!position || !selectionEnd) throw new Error("Native selection outside painted text");
    this.dirty = true;
    this.origins = painted.identities.map((_, index) => index);
    this.undoStart ??= { position, ...(from === to ? {} : { selectionEnd }) };
    this.history.push(`buffer start epoch ${painted.epoch} ${painted.id} selection ${from}:${to}`);
  }

  private splice(from: number, to: number, data: string): void {
    if (from < 0 || to < from || to > this.nativeValue.length) throw new Error("Native target range outside buffer");
    this.nativeValue = this.nativeValue.slice(0, from) + data + this.nativeValue.slice(to);
    this.origins.splice(from, to - from, ...Array<null>(data.length).fill(null));
    this.history.push(`native ${from}:${to} -> ${JSON.stringify(data)} = ${JSON.stringify(this.nativeValue)}`);
  }

  dispatch(event: SyntheticEditEvent): void {
    this.history.push(event.type);
    if (event.type === "compositionstart") {
      if (this.composing) throw new Error("Composition already started");
      this.begin(event.from, event.to);
      this.composing = true;
      this.compositionRange = { from: event.from, to: event.to };
    } else if (event.type === "compositionupdate") {
      if (!this.composing || !this.compositionRange) throw new Error("Composition update without start");
      this.splice(this.compositionRange.from, this.compositionRange.to, event.data);
      this.compositionRange.to = this.compositionRange.from + event.data.length;
    } else if (event.type === "compositionend") {
      if (!this.composing) throw new Error("Composition end without start");
      this.composing = false;
      this.commit(event.names);
      this.compositionRange = null;
    } else {
      if (this.composing) throw new Error("Ordinary input during composition");
      const painted = this.requirePaint();
      const stale = this.snapshot(painted.id).version !== painted.version;
      const selection = event.selection ?? [event.from, event.to];
      this.begin(selection[0], selection[1]);
      this.splice(event.from, event.to, event.data);
      if (stale) {
        this.history.push("cancel stale beforeinput; apply intended model edit through painted identities");
        this.commit(event.names);
      }
    }
  }

  plan(): NativeSplice {
    const painted = this.requirePaint();
    let choices = minimalSplices(painted.value, this.nativeValue);
    if (this.targetEvidence) {
      choices = choices.filter(choice => {
        const origins: (number | null)[] = painted.identities.map((_, index) => index);
        origins.splice(choice.from, choice.to - choice.from, ...Array<null>(choice.insert.length).fill(null));
        return JSON.stringify(origins) === JSON.stringify(this.origins);
      });
    }
    if (choices.length !== 1) throw new BufferMappingError(`Ambiguous native diff: ${choices.length} minimal splices; target evidence ${this.targetEvidence ? "present" : "absent"}`);
    const choice = choices[0];
    if (!choice) throw new BufferMappingError("No native diff");
    return choice;
  }

  private isRemoved(beat: string): boolean {
    return mapValue(mapValue(this.editor.doc.getMap("beats").get(beat)).get("removals")).size > 0;
  }

  commit(names: readonly string[], operationOrder: "insert-first" | "delete-first" = "insert-first"): void {
    if (!this.dirty) throw new Error("No pending native edit");
    if (this.fault) throw this.fault;
    const painted = this.requirePaint();
    const edit = this.plan();
    if (names.length !== edit.insert.length) throw new Error("Commit needs a name for every inserted character");
    const live = this.editor.characters();
    const selected = painted.names.slice(edit.from, edit.to).filter(name => {
      const id = this.editor.identities.identity(name);
      return live.some(character => sameIdentity(character.identity, id));
    });
    const current = live.filter(character => character.beat === painted.id);
    const left = painted.identities.slice(0, edit.from).reverse().map(id => current.find(character => sameIdentity(character.identity, id))).find(character => character !== undefined);
    const destination = this.isRemoved(painted.id) ? "recovery" : "active";
    if (edit.insert && !left && edit.from > 0 && current.every(character => selected.includes(this.editor.identities.notation(character.identity))) && destination !== "recovery") {
      throw new BufferMappingError("No painted insertion neighbour survives; native buffer needs recovery");
    }
    for (const anchor of this.editor.captureUndoIdentities(selected)) this.undoDeleted.set(anchor.notation, anchor);
    this.history.push(`commit ${destination} ${operationOrder} delete [${selected.join(" ")}] insert ${JSON.stringify(edit.insert)} [${names.join(" ")}]`);
    this.editor.doc.transact(() => {
      if (operationOrder === "delete-first") this.editor.deleteIdentities(selected);
      const location = this.editor.locate(painted.id);
      const offset = left ? left.index + 1 - location.start : 0;
      // why: Inserting before deletion retains the painted right origin and keeps replacements ahead of unseen insertions.
      if (edit.insert) this.editor.insert(painted.id, offset, edit.insert, names, {});
      this.caret = { position: Y.createRelativePositionFromTypeIndex(location.text, location.start + offset + edit.insert.length, -1) };
      if (operationOrder === "insert-first") this.editor.deleteIdentities(selected);
    }, this.editor.localOrigin);
    this.dirty = false;
    this.paintHeld = false;
    this.drain();
    this.repaint();
  }

  receive(update: Uint8Array, path = "delivery"): void {
    this.history.push(`receive ${path} ${update.length} bytes dirty=${this.dirty}`);
    if (this.mechanism === "M3") {
      Y.applyUpdate(this.network.doc, update, "delivery");
      if (this.fault) throw this.fault;
    } else {
      this.forwardInbound(update);
    }
  }

  private forwardInbound(update: Uint8Array): void {
    if (this.dirty && this.mechanism !== "M2") {
      if (this.heldBytes + update.length > this.queueLimitBytes) {
        const message = `${this.mechanism} dirty queue needs ${this.heldBytes + update.length} bytes, bound ${this.queueLimitBytes}`;
        this.history.push(message);
        throw new BufferQueueBoundError(message);
      }
      this.held.push(update.slice());
      this.heldBytes += update.length;
      this.history.push(`hold ${update.length} bytes; total ${this.heldBytes}`);
      return;
    }
    Y.applyUpdate(this.editor.doc, update, this.mechanism === "M3" ? "network" : "delivery");
    if (!this.dirty && !this.paintHeld && this.painted) this.repaint();
  }

  private drain(): void {
    if (this.dirty) throw new Error("Cannot drain into a dirty editor");
    for (const update of this.held) {
      Y.applyUpdate(this.editor.doc, update, this.mechanism === "M3" ? "network" : "delivery");
      this.history.push(`release ${update.length} bytes`);
    }
    this.held.length = 0;
    this.heldBytes = 0;
  }

  private repaint(): void {
    if (!this.painted || !this.caret) return;
    const absolute = Y.createAbsolutePositionFromRelativePosition(this.caret.position, this.editor.doc, false);
    if (!absolute) throw new BufferMappingError("Caret identity missing");
    const beats = [...new Set(this.editor.characters().map(character => character.beat))];
    let id = beats.find(beat => {
      const location = this.editor.locate(beat);
      return location.text === absolute.type && location.start <= absolute.index && absolute.index <= location.end;
    }) ?? this.painted.id;
    let offset: number;
    if (this.isRemoved(id)) {
      const next = [...beats.slice(beats.indexOf(id) + 1), ...beats].find(beat => !this.isRemoved(beat));
      if (!next) throw new BufferMappingError("No surviving beat for caret");
      id = next;
      offset = 0;
      const { text, start } = this.editor.locate(id);
      this.caret = { position: Y.createRelativePositionFromTypeIndex(text, start, 0) };
    } else {
      offset = absolute.index - this.editor.locate(id).start;
    }
    this.painted = this.snapshot(id);
    this.nativeValue = this.painted.value;
    this.origins = this.painted.identities.map((_, index) => index);
    this.history.push(`repaint ${id} ${JSON.stringify(this.nativeValue)} caret ${offset}`);
  }

  undo(): void {
    if (this.dirty || !this.undoStart) throw new Error("Undo needs a committed buffer");
    this.undoManager.undo();
    this.editor.bindUndoRestores([...this.undoDeleted.values()]);
    const reanchor = (position: Y.RelativePosition): Y.RelativePosition => {
      const absolute = Y.createAbsolutePositionFromRelativePosition(position, this.editor.doc, true);
      if (!absolute) throw new BufferMappingError("Undo selection missing");
      return Y.createRelativePositionFromTypeIndex(absolute.type, absolute.index, position.assoc);
    };
    this.caret = {
      position: reanchor(this.undoStart.position),
      ...(this.undoStart.selectionEnd ? { selectionEnd: reanchor(this.undoStart.selectionEnd) } : {})
    };
    this.history.push("undo local action and reanchor selection to restored identities");
    this.repaint();
  }

  destroy(): void {
    this.undoManager.destroy();
    if (this.mechanism === "M3") {
      this.editor.doc.off("update", this.editorListener);
      this.network.doc.off("update", this.networkListener);
    }
  }
}
