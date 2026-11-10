import * as Y from "yjs";
import type { CollabIdentity } from "../model.ts";
import type { ReplicaCaretAnchor } from "../reader.ts";
import { mapValue, textValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { statusFrontier, statusValue } from "../marks/commands.ts";
import { anchorOf, contentAt, identityKey, insertContent, itemAt, resolveIdentity, selectionOf } from "./identity.ts";
import type { IdentityPoint, ResolvedIdentity, SelectionRecord, StoredContent } from "./identity.ts";

export type CommandPart =
  | { kind: "sequence"; inserted: CollabIdentity[]; deleted: StoredContent[] }
  | { kind: "positional"; beat: string; offset: number; length: number }
  | { kind: "format"; key: string; first: CollabIdentity; last: CollabIdentity; prior: { id: CollabIdentity; value: unknown }[] }
  | { kind: "join"; from: string; into: string; entry: string }
  | { kind: "unjoined"; from: string; into: string; entry: string; retired: string[] }
  | { kind: "key"; path: string[]; key: string; prior: unknown; value: unknown }
  | { kind: "beat-record"; id: string; present: boolean }
  | { kind: "removal"; beat: string; entry: string }
  | { kind: "restored"; beat: string; entry: string }
  | { kind: "status"; target: string; event: string; value: string; by: string }
  | { kind: "status-retired"; target: string; event: string; value: string; by: string }
  | { kind: "scalar"; beat: string; key: string; prior: unknown; value: unknown }
  | { kind: "record"; collection: string; id: string; fields: Record<string, unknown>; present: boolean };

export interface CommandRecord {
  label: string;
  parts: CommandPart[];
  selection?: SelectionRecord;
}

export const undoDefects = ["fall-through", "no-restoration-record", "retire-without-own-entry", "span-delete", "positions"] as const;
export type UndoDefect = typeof undoDefects[number];

export interface UndoOutcome {
  effective: boolean;
  label: string | null;
  restored: [CollabIdentity, CollabIdentity][];
  selection: ReplicaCaretAnchor | null;
  consumed: number;
}

export interface StatusEvent {
  target: string;
  value: string;
  prior: string;
  parents: string[];
  by: string;
}

export const restorationRoot = "restoredIdentities";

interface Reversal {
  effective: boolean;
  inverse: CommandPart;
}

function attributeValue(attributes: Record<string, unknown>, key: string): unknown {
  return attributes[key] ?? null;
}

export function writeStatusEvent(replica: SchemaReplica, target: string, id: string, value: string, by: string): void {
  const frontier = statusFrontier(replica, target);
  const event: StatusEvent = { target, value, prior: statusValue(replica, target), parents: frontier.map(([key]) => key).sort(), by };
  replica.doc.getMap<StatusEvent>("statusEvents").set(id, event);
}

export class CommandHistory {
  readonly replica: SchemaReplica;
  readonly undoStack: CommandRecord[] = [];
  readonly redoStack: CommandRecord[] = [];
  readonly origin = { commandUndo: true };
  readonly bound: number;
  readonly defect: UndoDefect | null;
  dropped = 0;
  private restoredHere = new Map<string, CollabIdentity>();
  private readonly onDrop: ((entry: CommandRecord) => void) | null;

  constructor(replica: SchemaReplica, options: { bound?: number; defect?: UndoDefect; onDrop?: (entry: CommandRecord) => void } = {}) {
    this.replica = replica;
    this.bound = options.bound ?? 200;
    this.defect = options.defect ?? null;
    this.onDrop = options.onDrop ?? null;
  }

  record(entry: CommandRecord): void {
    this.undoStack.push(entry);
    this.redoStack.length = 0;
    while (this.undoStack.length > this.bound) {
      const oldest = this.undoStack.shift();
      if (!oldest) break;
      this.dropped++;
      this.onDrop?.(oldest);
    }
  }

  mapAnchor(anchor: ReplicaCaretAnchor): ReplicaCaretAnchor {
    return this.restoreSelection(selectionOf(anchor));
  }

  undo(): UndoOutcome {
    return this.step(this.undoStack, this.redoStack);
  }

  redo(): UndoOutcome {
    return this.step(this.redoStack, this.undoStack);
  }

  private step(from: CommandRecord[], to: CommandRecord[]): UndoOutcome {
    let consumed = 0;
    for (;;) {
      const entry = from.pop();
      if (!entry) return { effective: false, label: null, restored: [], selection: null, consumed };
      consumed++;
      this.restoredHere = new Map();
      const inverses: CommandPart[] = [];
      let effective = false;
      try {
        this.replica.doc.transact(() => {
          for (const part of [...entry.parts].reverse()) {
            const reversal = this.reverse(part);
            effective ||= reversal.effective;
            inverses.unshift(reversal.inverse);
          }
        }, this.origin);
      } catch (error) {
        from.push(entry);
        throw error;
      }
      const restored = [...this.restoredHere].map(([key, id]): [CollabIdentity, CollabIdentity] => {
        const [client, clock] = key.split(":").map(Number);
        return [{ client: client ?? 0, clock: clock ?? 0 }, id];
      });
      if (effective) {
        to.push({ label: entry.label, parts: inverses, ...(entry.selection ? { selection: entry.selection } : {}) });
        if (to.length > this.bound) to.shift();
        return { effective, label: entry.label, restored, selection: entry.selection ? this.restoreSelection(entry.selection) : null, consumed };
      }
      if (this.defect !== "fall-through" || from.length === 0) return { effective, label: entry.label, restored, selection: null, consumed };
    }
  }

  private restored(id: CollabIdentity): CollabIdentity | null {
    const key = identityKey(id);
    const local = this.restoredHere.get(key);
    if (local) return local;
    if (this.defect === "no-restoration-record") return null;
    const shared = this.replica.doc.getMap<CollabIdentity>(restorationRoot).get(key);
    return shared ? { client: shared.client, clock: shared.clock } : null;
  }

  private follow(id: CollabIdentity): CollabIdentity {
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(identityKey(current))) {
      seen.add(identityKey(current));
      if (resolveIdentity(this.replica.doc, current)?.live) return current;
      const next = this.restored(current);
      if (!next) return current;
      current = next;
    }
    throw new Error(`Restoration chain from ${identityKey(id)} loops`);
  }

  private locate(id: CollabIdentity): ResolvedIdentity | null {
    return resolveIdentity(this.replica.doc, this.follow(id));
  }

  private restoreSelection(selection: SelectionRecord): ReplicaCaretAnchor {
    const map = (point: IdentityPoint): Y.RelativePosition => anchorOf(point.id ? { ...point, id: this.follow(point.id) } : point);
    return { position: map(selection.start), ...(selection.end ? { selectionEnd: map(selection.end) } : {}) };
  }

  private reverse(part: CommandPart): Reversal {
    switch (part.kind) {
      case "sequence": return this.reverseSequence(part);
      case "positional": return this.reversePositional(part);
      case "format": return this.reverseFormat(part);
      case "join": return this.reverseJoin(part);
      case "unjoined": {
        const retired = this.replica.doc.getMap("retiredJoins");
        const inverse: CommandPart = { kind: "join", from: part.from, into: part.into, entry: part.entry };
        const back = part.retired.filter(id => retired.has(id));
        for (const id of back) retired.delete(id);
        return { effective: back.length > 0, inverse };
      }
      case "key": return this.reverseKey(part);
      case "beat-record": {
        const beats = this.replica.doc.getMap("beats");
        const inverse: CommandPart = { ...part, present: !part.present };
        if (part.present) {
          if (!beats.has(part.id)) return { effective: false, inverse };
          beats.delete(part.id);
          return { effective: true, inverse };
        }
        if (beats.has(part.id)) return { effective: false, inverse };
        const record = new Y.Map<unknown>();
        beats.set(part.id, record);
        record.set("joins", new Y.Map<unknown>());
        record.set("removals", new Y.Map<unknown>());
        return { effective: true, inverse };
      }
      case "removal": return this.reverseRemoval(part);
      case "restored": {
        const removals = mapValue(mapValue(this.replica.doc.getMap("beats").get(part.beat)).get("removals"));
        if (removals.has(part.entry)) return { effective: false, inverse: { kind: "removal", beat: part.beat, entry: part.entry } };
        removals.set(part.entry, true);
        return { effective: true, inverse: { kind: "removal", beat: part.beat, entry: part.entry } };
      }
      case "status": return this.reverseStatus(part);
      case "status-retired": {
        const event = `${part.event}~`;
        writeStatusEvent(this.replica, part.target, event, part.value, part.by);
        return { effective: true, inverse: { kind: "status", target: part.target, event, value: part.value, by: part.by } };
      }
      case "scalar": {
        const beat = mapValue(this.replica.doc.getMap("beats").get(part.beat));
        const inverse: CommandPart = { kind: "scalar", beat: part.beat, key: part.key, prior: part.value, value: part.prior };
        if (beat.get(part.key) !== part.value) return { effective: false, inverse };
        if (part.prior === undefined) beat.delete(part.key);
        else beat.set(part.key, part.prior);
        return { effective: true, inverse };
      }
      case "record": {
        const collection = this.replica.doc.getMap(part.collection);
        const inverse: CommandPart = { ...part, present: !part.present };
        if (part.present) {
          if (!collection.has(part.id)) return { effective: false, inverse };
          collection.delete(part.id);
          return { effective: true, inverse };
        }
        if (collection.has(part.id)) return { effective: false, inverse };
        const record = new Y.Map<unknown>();
        collection.set(part.id, record);
        for (const [key, value] of Object.entries(part.fields)) record.set(key, value);
        return { effective: true, inverse };
      }
    }
  }

  private reverseSequence(part: Extract<CommandPart, { kind: "sequence" }>): Reversal {
    const doc = this.replica.doc;
    const removed: StoredContent[] = [];
    if (this.defect === "span-delete" && part.inserted.length > 0) {
      const ends = [part.inserted[0], part.inserted.at(-1)].map(id => id ? this.locate(id) : null);
      const [first, last] = ends;
      if (first?.live && last?.live && first.type === last.type) {
        for (let index = first.index; index <= last.index; index++) {
          const id = itemAt(first.type, index);
          if (id) removed.push({ id, ...contentAt(first.type, index) });
        }
        first.type.delete(first.index, last.index - first.index + 1);
      }
    } else {
      for (const original of part.inserted) {
        const id = this.follow(original);
        const at = resolveIdentity(doc, id);
        if (!at?.live) continue;
        removed.push({ id, ...contentAt(at.type, at.index) });
        at.type.delete(at.index, 1);
      }
    }
    const before = part.deleted.map(content => resolveIdentity(doc, content.id));
    const restoredIds: CollabIdentity[] = [];
    const placed = new Map<string, CollabIdentity>();
    part.deleted.forEach((content, index) => {
      const key = identityKey(content.id);
      const tombstone = before[index];
      if (!tombstone || tombstone.live) return;
      const known = this.restored(content.id);
      if (known) {
        placed.set(key, known);
        return;
      }
      const previous = index > 0 ? part.deleted[index - 1] : undefined;
      const previousPlaced = previous ? placed.get(identityKey(previous.id)) : undefined;
      const previousBefore: ResolvedIdentity | null | undefined = before[index - 1];
      let target = resolveIdentity(doc, content.id)?.index ?? tombstone.index;
      if (previousPlaced && previousBefore && previousBefore.type === tombstone.type && previousBefore.index === tombstone.index) {
        const anchor = resolveIdentity(doc, previousPlaced);
        if (anchor?.live && anchor.type === tombstone.type) target = anchor.index + 1;
      }
      const created = insertContent(tombstone.type, target, content);
      placed.set(key, created);
      this.restoredHere.set(key, created);
      restoredIds.push(created);
      if (this.defect !== "no-restoration-record") doc.getMap<CollabIdentity>(restorationRoot).set(key, created);
    });
    return { effective: removed.length > 0 || restoredIds.length > 0, inverse: { kind: "sequence", inserted: restoredIds, deleted: removed } };
  }

  private reversePositional(part: Extract<CommandPart, { kind: "positional" }>): Reversal {
    const { text, start } = this.replica.locate(part.beat);
    text.delete(start + part.offset, part.length);
    return { effective: true, inverse: part };
  }

  private reverseFormat(part: Extract<CommandPart, { kind: "format" }>): Reversal {
    const first = this.locate(part.first);
    const last = this.locate(part.last);
    if (!first || !last || first.type !== last.type || !(first.type instanceof Y.Text)) throw new Error("Format span is not in one text");
    const text = textValue(first.type);
    const end = last.live ? last.index + 1 : last.index;
    const priors = new Map(part.prior.map(entry => [identityKey(this.follow(entry.id)), entry.value]));
    const fallback = part.prior[0]?.value ?? null;
    const changes: { index: number; length: number; target: unknown }[] = [];
    const inverse: { id: CollabIdentity; value: unknown }[] = [];
    let carried = fallback;
    for (let index = first.index; index < end; index++) {
      const id = itemAt(text, index);
      if (!id) continue;
      const key = identityKey(id);
      if (priors.has(key)) carried = priors.get(key) ?? null;
      const current = attributeValue(contentAt(text, index).attributes, part.key);
      inverse.push({ id, value: current });
      if (JSON.stringify(current) === JSON.stringify(carried)) continue;
      const previous = changes.at(-1);
      if (previous && previous.index + previous.length === index && JSON.stringify(previous.target) === JSON.stringify(carried)) previous.length++;
      else changes.push({ index, length: 1, target: carried });
    }
    for (const change of changes) text.format(change.index, change.length, { [part.key]: change.target });
    return { effective: changes.length > 0, inverse: { kind: "format", key: part.key, first: part.first, last: part.last, prior: inverse } };
  }

  private reverseJoin(part: Extract<CommandPart, { kind: "join" }>): Reversal {
    const now: string[] = [];
    const inverse: CommandPart = { kind: "unjoined", from: part.from, into: part.into, entry: part.entry, retired: now };
    const retired = this.replica.doc.getMap("retiredJoins");
    const joins = mapValue(mapValue(this.replica.doc.getMap("beats").get(part.from)).get("joins"));
    const ownLive = joins.has(part.entry) && !retired.has(part.entry);
    if (!ownLive && this.defect !== "retire-without-own-entry") return { effective: false, inverse };
    for (const [id, value] of joins) {
      if ((value as { into: string }).into === part.into && !retired.has(id)) {
        retired.set(id, true);
        now.push(id);
      }
    }
    return { effective: now.length > 0, inverse };
  }

  private reverseKey(part: Extract<CommandPart, { kind: "key" }>): Reversal {
    const inverse: CommandPart = { ...part, prior: part.value, value: part.prior };
    let target = this.replica.doc.getMap<unknown>(part.path[0] ?? "");
    for (const step of part.path.slice(1)) target = mapValue(target.get(step));
    const current: unknown = target.get(part.key);
    if (JSON.stringify(current) !== JSON.stringify(part.value)) return { effective: false, inverse };
    if (part.prior === undefined) target.delete(part.key);
    else target.set(part.key, part.prior);
    return { effective: true, inverse };
  }

  private reverseRemoval(part: Extract<CommandPart, { kind: "removal" }>): Reversal {
    const inverse: CommandPart = { kind: "restored", beat: part.beat, entry: part.entry };
    const removals = mapValue(mapValue(this.replica.doc.getMap("beats").get(part.beat)).get("removals"));
    if (!removals.has(part.entry) && this.defect !== "retire-without-own-entry") return { effective: false, inverse };
    const records = this.replica.doc.getMap("removalRecords");
    let effective = false;
    for (const id of [...removals.keys()]) {
      const record = records.get(id);
      if (id === part.entry || (record instanceof Y.Map && record.get("kind") === "beat")) {
        removals.delete(id);
        effective = true;
      }
    }
    return { effective, inverse };
  }

  private reverseStatus(part: Extract<CommandPart, { kind: "status" }>): Reversal {
    const inverse: CommandPart = { kind: "status-retired", target: part.target, event: part.event, value: part.value, by: part.by };
    const frontier = statusFrontier(this.replica, part.target);
    if (!frontier.some(([key]) => key === part.event)) return { effective: false, inverse };
    const retired = this.replica.doc.getMap("retiredStatus");
    let effective = false;
    for (const [key] of frontier) {
      if (!retired.has(key)) {
        retired.set(key, true);
        effective = true;
      }
    }
    return { effective, inverse };
  }
}
