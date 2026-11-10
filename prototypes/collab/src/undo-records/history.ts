import * as Y from "yjs";
import type { CollabIdentity } from "../model.ts";
import type { ReplicaCaretAnchor } from "../reader.ts";
import { mapValue, textValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { statusFrontier, statusValue } from "../marks/commands.ts";
import { readStatusEvent } from "../marks/status-resolution.ts";
import { anchorOf, contentAt, identityKey, insertContent, itemAt, resolveIdentity, restoreBefore, sameIdentity, selectionOf } from "./identity.ts";
import type { IdentityPoint, ResolvedIdentity, SelectionRecord, SequenceType, StoredContent } from "./identity.ts";

export type CommandPart =
  | { kind: "sequence"; inserted: CollabIdentity[]; deleted: StoredContent[] }
  | { kind: "positional"; beat: string; offset: number; length: number }
  | { kind: "format"; key: string; first: CollabIdentity; last: CollabIdentity; prior: { id: CollabIdentity; value: unknown }[] }
  | { kind: "join"; from: string; into: string; entry: string }
  | { kind: "unjoined"; from: string; into: string; entry: string; retired: string[] }
  | { kind: "key"; path: string[]; key: string; prior: unknown; value: unknown }
  | { kind: "beat-record"; id: string; present: boolean; fields?: Record<string, unknown> }
  | { kind: "removal"; beat: string; entry: string }
  | { kind: "restored"; beat: string; entry: string; retired: string[] }
  | { kind: "status"; target: string; event: string; value: string; by: string }
  | { kind: "status-retired"; target: string; event: string; value: string; by: string }
  | { kind: "scalar"; beat: string; key: string; prior: unknown; value: unknown }
  | { kind: "record"; collection: string; id: string; fields: Record<string, unknown>; present: boolean };

export interface CommandRecord {
  label: string;
  parts: CommandPart[];
  selection?: SelectionRecord;
}

export const undoDefects = ["fall-through", "no-restoration-record", "retire-without-own-entry", "span-delete", "positions", "restore-twice", "index-placement", "loser-not-followed"] as const;
export type UndoDefect = typeof undoDefects[number];

export interface UndoOutcome {
  effective: boolean;
  label: string | null;
  restored: [CollabIdentity, CollabIdentity][];
  selection: ReplicaCaretAnchor | null;
  consumed: number;
}

export const restorationRoot = "restorations";
const legacyRestorationRoot = "restoredIdentities";
export const settleOrigin = { settleRestorations: true };

interface Reversal {
  effective: boolean;
  inverse: CommandPart;
}

interface Capture {
  manager: Y.UndoManager;
  open: boolean;
  members: StoredContent[];
  discarded: boolean;
}

export type RestoreRoute = "capture" | "items";

function sequenceScope(doc: Y.Doc): SequenceType[] {
  if (doc.share.has("flow")) return [doc.getText("flow")];
  const types: SequenceType[] = [doc.getArray("order")];
  for (const segment of doc.getMap("segments").values()) {
    if (segment instanceof Y.Map && segment.get("text") instanceof Y.Text) types.push(segment.get("text") as Y.Text);
  }
  return types;
}

function ownClock(doc: Y.Doc): number {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;
}

function parseIdentityKey(key: string): CollabIdentity {
  const [client, clock] = key.split(":").map(Number);
  return { client: client ?? 0, clock: clock ?? 0 };
}

function earliest(ids: readonly CollabIdentity[]): CollabIdentity | null {
  let best: CollabIdentity | null = null;
  for (const id of ids) if (!best || id.client < best.client || (id.client === best.client && id.clock < best.clock)) best = id;
  return best;
}

function restorationsOf(doc: Y.Doc, original: CollabIdentity): CollabIdentity[] {
  const wanted = identityKey(original);
  const found: CollabIdentity[] = [];
  for (const [key, value] of doc.getMap<CollabIdentity>(restorationRoot)) if (identityKey(value) === wanted) found.push(parseIdentityKey(key));
  return found;
}

export function restorationWinner(doc: Y.Doc, original: CollabIdentity): CollabIdentity | null {
  return earliest(restorationsOf(doc, original));
}

export function settleRestorations(replica: SchemaReplica): CollabIdentity[] {
  const groups = new Map<string, CollabIdentity[]>();
  for (const [key, original] of replica.doc.getMap<CollabIdentity>(restorationRoot)) {
    const group = groups.get(identityKey(original)) ?? [];
    group.push(parseIdentityKey(key));
    groups.set(identityKey(original), group);
  }
  const losers = [...groups.values()].flatMap(group => {
    const winner = earliest(group);
    return group.filter(id => winner && !sameIdentity(id, winner) && resolveIdentity(replica.doc, id)?.live);
  });
  if (losers.length === 0) return [];
  replica.doc.transact(() => {
    for (const id of losers) {
      const at = resolveIdentity(replica.doc, id);
      if (at?.live) at.type.delete(at.index, 1);
    }
  }, settleOrigin);
  return losers;
}

function attributeValue(attributes: Record<string, unknown>, key: string): unknown {
  return attributes[key] ?? null;
}

export function writeStatusEvent(replica: SchemaReplica, target: string, id: string, value: string, by: string): void {
  const frontier = statusFrontier(replica, target);
  const validated = readStatusEvent({ target, value, parents: frontier.map(([key]) => key).sort(), by });
  if (!validated) throw new Error("Invalid status command");
  replica.doc.getMap("statusEvents").set(id, { target: validated.target, value: validated.value, prior: statusValue(replica, target), parents: validated.parents, by: validated.by });
}

export class CommandHistory {
  readonly replica: SchemaReplica;
  readonly undoStack: CommandRecord[] = [];
  readonly redoStack: CommandRecord[] = [];
  readonly origin = { commandUndo: true };
  readonly bound: number;
  readonly defect: UndoDefect | null;
  readonly route: RestoreRoute;
  readonly deleteRule: "remove" | "hide";
  dropped = 0;
  private restoredHere = new Map<string, CollabIdentity>();
  private popped = new Map<string, CollabIdentity>();
  private capture: Capture | null = null;
  private readonly captures = new WeakMap<StoredContent, Capture>();
  private readonly onDrop: ((entry: CommandRecord) => void) | null;
  private readonly openCapture = (transaction: Y.Transaction): void => {
    if (!transaction.local || transaction.origin === settleOrigin) return;
    const scope = sequenceScope(this.replica.doc);
    if (this.capture?.open) {
      this.capture.manager.addToScope(scope);
      this.capture.manager.trackedOrigins.add(transaction.origin);
      return;
    }
    const capture: Capture = { manager: new Y.UndoManager(scope, {
      trackedOrigins: new Set([transaction.origin]), captureTimeout: Number.POSITIVE_INFINITY, deleteFilter: () => false,
      captureTransaction: tr => capture.open && tr.local && tr.origin !== settleOrigin
    }), open: true, members: [], discarded: false };
    this.capture = capture;
  };

  constructor(replica: SchemaReplica, options: { bound?: number; defect?: UndoDefect; onDrop?: (entry: CommandRecord) => void; route?: RestoreRoute; deleteRule?: "remove" | "hide" } = {}) {
    this.replica = replica;
    this.deleteRule = options.deleteRule ?? "remove";
    this.bound = options.bound ?? 200;
    this.defect = options.defect ?? null;
    this.onDrop = options.onDrop ?? null;
    this.route = options.route ?? "items";
    if (this.route === "capture") replica.doc.on("beforeTransaction", this.openCapture);
  }

  destroy(): void {
    this.replica.doc.off("beforeTransaction", this.openCapture);
    this.closeCapture([]);
  }

  private closeCapture(parts: readonly CommandPart[]): void {
    const capture = this.capture;
    this.capture = null;
    if (!capture) return;
    capture.open = false;
    for (const part of parts) if (part.kind === "sequence") capture.members.push(...part.deleted);
    if (capture.manager.undoStack.length === 0 || capture.members.length === 0) {
      capture.manager.destroy();
      return;
    }
    for (const member of capture.members) this.captures.set(member, capture);
  }

  record(entry: CommandRecord): void {
    this.closeCapture(entry.parts);
    this.undoStack.push(entry);
    this.redoStack.length = 0;
    while (this.undoStack.length > this.bound) {
      const oldest = this.undoStack.shift();
      if (!oldest) break;
      this.dropped++;
      for (const part of oldest.parts) if (part.kind === "sequence") for (const content of part.deleted) this.captures.get(content)?.manager.destroy();
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
      this.popped = new Map();
      const inverses: CommandPart[] = [];
      let effective = false;
      this.closeCapture([]);
      try {
        this.replica.doc.transact(() => {
          for (const part of [...entry.parts].reverse()) {
            const reversal = this.reverse(part);
            effective ||= reversal.effective;
            inverses.unshift(reversal.inverse);
          }
        }, this.origin);
      } catch (error) {
        this.closeCapture([]);
        from.push(entry);
        throw error;
      }
      this.closeCapture(effective ? inverses : []);
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
    if (this.defect === "restore-twice") {
      const shared = this.replica.doc.getMap<CollabIdentity>(legacyRestorationRoot).get(key);
      return shared ? { client: shared.client, clock: shared.clock } : null;
    }
    return restorationWinner(this.replica.doc, id);
  }

  private winnerInstead(id: CollabIdentity): CollabIdentity | null {
    if (this.defect === "no-restoration-record" || this.defect === "restore-twice" || this.defect === "loser-not-followed") return null;
    const original = this.replica.doc.getMap<CollabIdentity>(restorationRoot).get(identityKey(id));
    const winner = original ? restorationWinner(this.replica.doc, original) : null;
    return winner && !sameIdentity(winner, id) ? winner : null;
  }

  private follow(id: CollabIdentity): CollabIdentity {
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(identityKey(current))) {
      seen.add(identityKey(current));
      const winner = this.winnerInstead(current);
      if (winner) {
        current = winner;
        continue;
      }
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
        if (part.present) {
          const current: unknown = beats.get(part.id);
          if (!(current instanceof Y.Map)) return { effective: false, inverse: { kind: "beat-record", id: part.id, present: false } };
          const fields = (current as Y.Map<unknown>).toJSON() as Record<string, unknown>;
          beats.delete(part.id);
          return { effective: true, inverse: { kind: "beat-record", id: part.id, present: false, fields } };
        }
        const inverse: CommandPart = { kind: "beat-record", id: part.id, present: true };
        if (beats.has(part.id)) return { effective: false, inverse };
        const record = new Y.Map<unknown>();
        beats.set(part.id, record);
        const fields = { joins: {}, removals: {}, ...part.fields };
        for (const [field, value] of Object.entries(fields)) {
          if (field !== "joins" && field !== "removals") {
            record.set(field, value);
            continue;
          }
          const nested = new Y.Map<unknown>();
          record.set(field, nested);
          for (const [entry, content] of Object.entries(value as Record<string, unknown>)) nested.set(entry, content);
        }
        return { effective: true, inverse };
      }
      case "removal": return this.reverseRemoval(part);
      case "restored": {
        const beat: unknown = this.replica.doc.getMap("beats").get(part.beat);
        if (!(beat instanceof Y.Map)) return { effective: false, inverse: { kind: "removal", beat: part.beat, entry: part.entry } };
        const removals = mapValue((beat as Y.Map<unknown>).get("removals"));
        const back = part.retired.filter(id => !removals.has(id));
        for (const id of back) removals.set(id, true);
        return { effective: back.length > 0, inverse: { kind: "removal", beat: part.beat, entry: part.entry } };
      }
      case "status": return this.reverseStatus(part);
      case "status-retired": {
        const event = `${part.event}~`;
        writeStatusEvent(this.replica, part.target, event, part.value, part.by);
        return { effective: true, inverse: { kind: "status", target: part.target, event, value: part.value, by: part.by } };
      }
      case "scalar": {
        const beat = this.beatRecord(part.beat);
        const inverse: CommandPart = { kind: "scalar", beat: part.beat, key: part.key, prior: part.value, value: part.prior };
        if (!beat || beat.get(part.key) !== part.value) return { effective: false, inverse };
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
      const created = this.defect === "restore-twice" || this.defect === "index-placement"
        ? this.insertAtIndex(part.deleted, index, before, placed, tombstone)
        : this.route === "capture" ? this.recreate(content) : restoreBefore(tombstone.type, content.id, content);
      placed.set(key, created);
      this.restoredHere.set(key, created);
      restoredIds.push(created);
      if (this.defect === "restore-twice") doc.getMap<CollabIdentity>(legacyRestorationRoot).set(key, created);
      else if (this.defect !== "no-restoration-record") doc.getMap<CollabIdentity>(restorationRoot).set(identityKey(created), content.id);
    });
    return { effective: removed.length > 0 || restoredIds.length > 0, inverse: { kind: "sequence", inserted: restoredIds, deleted: removed } };
  }

  private recreate(content: StoredContent): CollabIdentity {
    const key = identityKey(content.id);
    const done = this.popped.get(key);
    if (done) return done;
    const capture = this.captures.get(content);
    if (!capture || capture.manager.undoStack.length === 0) throw new Error(`No capture holds the deletion of ${key}; records reloaded from JSON have none`);
    if (capture.discarded) throw new Error(`The capture holding ${key} also re-creates a copy its step discarded`);
    const doc = this.replica.doc;
    const wanted = new Set(capture.members
      .filter(member => resolveIdentity(doc, member.id)?.live === false && !this.restoredHere.has(identityKey(member.id)) && !this.restored(member.id))
      .map(member => identityKey(member.id)));
    if (!wanted.has(key)) throw new Error(`Capture restore of ${key} is not wanted`);
    const groups = new Map<SequenceType, { member: StoredContent; index: number }[]>();
    for (const member of capture.members) {
      const at = resolveIdentity(doc, member.id);
      if (!at || at.live) throw new Error(`Captured identity ${identityKey(member.id)} is not a tombstone`);
      groups.set(at.type, [...groups.get(at.type) ?? [], { member, index: at.index }]);
    }
    const before = ownClock(doc);
    capture.manager.undo();
    capture.manager.destroy();
    const unwanted: CollabIdentity[] = [];
    for (const [type, members] of groups) {
      members.sort((left, right) => left.index - right.index);
      const fresh: CollabIdentity[] = [];
      for (let index = 0; index < type.length; index++) {
        const id = itemAt(type, index);
        if (id && id.client === doc.clientID && id.clock >= before) fresh.push(id);
      }
      if (fresh.length !== members.length) throw new Error(`Captured restore re-created ${fresh.length} items for ${members.length} deleted`);
      members.forEach(({ member }, index) => {
        const id = fresh[index];
        if (!id) return;
        if (wanted.has(identityKey(member.id))) this.popped.set(identityKey(member.id), id);
        else unwanted.push(id);
      });
      if (!(type instanceof Y.Text)) continue;
      for (const { member } of members) {
        const id = this.popped.get(identityKey(member.id));
        const at = id ? resolveIdentity(doc, id) : null;
        if (!at?.live) continue;
        const current = contentAt(type, at.index).attributes;
        const marks = Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(member.attributes)])]
          .filter(mark => JSON.stringify(current[mark] ?? null) !== JSON.stringify(member.attributes[mark] ?? null))
          .map(mark => [mark, member.attributes[mark] ?? null]));
        if (Object.keys(marks).length > 0) type.format(at.index, 1, marks);
      }
    }
    for (const id of unwanted) {
      const at = resolveIdentity(doc, id);
      if (at?.live) at.type.delete(at.index, 1);
    }
    if (unwanted.length > 0 && this.capture) this.capture.discarded = true;
    const created = this.popped.get(key);
    if (!created) throw new Error(`Capture restore did not re-create ${key}`);
    return created;
  }

  private insertAtIndex(deleted: StoredContent[], index: number, before: (ResolvedIdentity | null)[], placed: Map<string, CollabIdentity>, tombstone: ResolvedIdentity): CollabIdentity {
    const content = deleted[index];
    if (!content) throw new Error("Missing deleted content");
    const previous = index > 0 ? deleted[index - 1] : undefined;
    const previousPlaced = previous ? placed.get(identityKey(previous.id)) : undefined;
    const previousBefore = before[index - 1];
    let target = resolveIdentity(this.replica.doc, content.id)?.index ?? tombstone.index;
    if (previousPlaced && previousBefore && previousBefore.type === tombstone.type && previousBefore.index === tombstone.index) {
      const anchor = resolveIdentity(this.replica.doc, previousPlaced);
      if (anchor?.live && anchor.type === tombstone.type) target = anchor.index + 1;
    }
    return insertContent(tombstone.type, target, content);
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

  private beatRecord(id: string): Y.Map<unknown> | null {
    const record: unknown = this.replica.doc.getMap("beats").get(id);
    return record instanceof Y.Map ? record as Y.Map<unknown> : null;
  }

  private reverseJoin(part: Extract<CommandPart, { kind: "join" }>): Reversal {
    const now: string[] = [];
    const inverse: CommandPart = { kind: "unjoined", from: part.from, into: part.into, entry: part.entry, retired: now };
    const retired = this.replica.doc.getMap("retiredJoins");
    const beat = this.beatRecord(part.from);
    if (!beat) return { effective: false, inverse };
    const joins = mapValue(beat.get("joins"));
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
    for (const step of part.path.slice(1)) {
      const next: unknown = target.get(step);
      if (!(next instanceof Y.Map)) return { effective: false, inverse };
      target = next as Y.Map<unknown>;
    }
    const current: unknown = target.get(part.key);
    if (JSON.stringify(current) !== JSON.stringify(part.value)) return { effective: false, inverse };
    if (part.prior === undefined) target.delete(part.key);
    else target.set(part.key, part.prior);
    return { effective: true, inverse };
  }

  private reverseRemoval(part: Extract<CommandPart, { kind: "removal" }>): Reversal {
    const retired: string[] = [];
    const inverse: CommandPart = { kind: "restored", beat: part.beat, entry: part.entry, retired };
    const beat: unknown = this.replica.doc.getMap("beats").get(part.beat);
    if (!(beat instanceof Y.Map)) return { effective: false, inverse: { ...inverse, retired: [part.entry] } };
    const removals = mapValue((beat as Y.Map<unknown>).get("removals"));
    if (!removals.has(part.entry) && this.defect !== "retire-without-own-entry") return { effective: false, inverse: { ...inverse, retired: [part.entry] } };
    const records = this.replica.doc.getMap("removalRecords");
    for (const id of [...removals.keys()]) {
      const record = records.get(id);
      if (id === part.entry || (record instanceof Y.Map && record.get("kind") === "beat")) {
        removals.delete(id);
        retired.push(id);
      }
    }
    return { effective: retired.length > 0, inverse };
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
