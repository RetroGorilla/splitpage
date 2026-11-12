import assert from "node:assert/strict";
import type { SharedContentRef, SharedJsonValue, SharedMarkValue, SharedOperation, SharedRecordCollection, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import type { SharedUndoRecord, SharedUndoSelection } from "../../../src/core/collab/undo-record.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import type { SharedUndo, SharedUndoReversal } from "../../../src/application/editing/undo/shared-undo.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand, reverseSharedUndoRecord, SHARED_UNDO_RECORDS, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import type { UndoRecordAction } from "./scenario.ts";
import { readSharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import type { SharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import { readSharedTextRestoreOperation } from "../../../src/adapters/collab/mark-provenance.ts";
import { createSharedAnchor, readSharedAnchorUnit } from "../../../src/adapters/collab/anchors.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { readSharedStatus, readSharedStatusHeads, readSharedStatusNotices } from "../../../src/adapters/collab/status.ts";
import { scalarTarget } from "../../../src/adapters/collab/scalar-executor.ts";
import { createMonitoredSharedDocument, deliveryReplica, validatedFixture } from "../../adapters/collab/helpers.ts";
import { operation, ref } from "../../adapters/collab/executor-support.ts";
import { IdentityBook } from "../checker.ts";
import type { CollabCaret, CollabModel, CollabRow } from "../checker.ts";
import { DeliveryQueue } from "../delivery.ts";
import type { ReplicaName } from "../delivery.ts";
import type { SeedBeat } from "../oracles/seed-beat.ts";
import { modelWriters } from "./model-world.ts";
import type { ModelObservation, ModelSnapshot } from "./model-world.ts";

const FORMATS = ["b", "i", "u", "s", "hl", "dir", "cue"] as const;
const SCALARS = ["lengthSeconds", "paragraphStart"] as const;

function address(beat: string): SharedTextAddress { return { owner: ref(beat), segment: ref("b:" + beat), field: "audioText" }; }
function unitKey(unit: { readonly client: number; readonly clock: number }): string { return unit.client + ":" + unit.clock; }
function identityOf(id: string): { client: number; clock: number } {
  const named = id.startsWith("{") ? readSharedAnchorUnit(id) : null;
  if (named) return { client: named.client, clock: named.clock };
  const [client = 0, clock = 0] = id.split(":").map(Number);
  return { client, clock };
}

export class AdapterReplica {
  readonly name: ReplicaName;
  readonly handle: SharedDocumentHandle;
  readonly undo: SharedUndo;
  readonly written: Uint8Array[] = [];
  failNextReversal: string | null = null;
  refuseNextReversal: string | null = null;
  typing = false;
  private readonly world: AdapterWorld;
  private readonly spans = new WeakMap<ModelObservation, SharedContentRef | null>();
  private serial = 0;

  constructor(world: AdapterWorld, name: ReplicaName, state: Uint8Array | null) {
    this.world = world;
    this.name = name;
    this.handle = createMonitoredSharedDocument();
    collabState(this.handle).doc.clientID = modelWriters[name].client;
    if (state) assert.equal(applySharedUpdate(this.handle, state).ok, true);
    registerSharedTextOperationHandlers(this.handle);
    registerSharedUndoOperationHandlers(this.handle);
    registerSharedRecordHandlers(this.handle);
    deliveryReplica(this.handle).onLocalUpdate(update => { this.written.push(update); });
    this.undo = createSharedUndo({ now: () => world.now, supports: supportsSharedUndoPart, reverse: record => this.reverse(record) });
  }

  history(beat: string): SharedTextHistory {
    const history = readSharedTextHistory(this.handle, address(beat));
    assert.ok(history, "no text for " + beat);
    return history;
  }

  private anchor(beat: string, offset: number, affinity: "before" | "after"): SharedContentRef {
    const anchor = createSharedAnchor(this.handle, address(beat), offset, affinity);
    assert.ok(anchor);
    return anchor;
  }

  private author(): { id: string; by: string } { return { id: this.name + ":" + ++this.serial, by: modelWriters[this.name].by }; }

  private command(operations: readonly SharedOperation[], description: { label: string; selection: SharedUndoSelection | null; typing: string | null }): SharedUndoRecord | null {
    if (!this.typing) this.world.now += 2000;
    let recorded: SharedUndoRecord | null = null;
    this.undo.perform(() => {
      if (!operations.length) return null;
      const execution = executeSharedCommand(this.handle, operations, description);
      assert.deepEqual(execution.result, { ok: true });
      recorded = execution.record;
      return execution.record;
    });
    return recorded;
  }

  observe(beat: string, from: number, to: number): ModelObservation {
    const units = this.history(beat).units, caret = from > 0 ? this.anchor(beat, from, "before") : this.anchor(beat, from, "after");
    const observation: ModelObservation = { beat, left: this.anchor(beat, from, "before"), ids: units.slice(from, to).map(unit => unit.identity),
      selection: to > from ? { anchor: this.anchor(beat, from, "after"), focus: this.anchor(beat, to, "before") } : { anchor: caret, focus: caret } };
    this.spans.set(observation, to > from ? captureSharedTextRange(this.handle, address(beat), from, to) : null);
    return observation;
  }

  caretAfter(character: string): SharedUndoSelection {
    for (const beat of this.world.beats) {
      const unit = this.history(beat).live(identityOf(character));
      if (!unit) continue;
      const caret = this.anchor(beat, unit.index + 1, "before");
      return { anchor: caret, focus: caret };
    }
    throw new Error("No character " + character);
  }

  edit(input: { readonly at: ModelObservation; readonly remove?: ModelObservation; readonly text?: string; readonly marks?: readonly SharedMarkValue[]; readonly caret?: ModelObservation; readonly command?: string }): string[] {
    const target = address(input.at.beat), operations: SharedOperation[] = [], removed = (input.remove ?? input.at).ids;
    if (input.text) operations.push(operation({ kind: "text-insert", ...this.author(), target, at: { left: input.at.left, right: null, affinity: "after" },
      content: [{ value: input.text, marks: input.marks ?? [] }] }));
    if (removed.length) operations.push(operation({ kind: "text-delete", ...this.author(), target, observed: removed }));
    const record = this.command(operations, { label: input.command ?? "typing", selection: (input.caret ?? input.at).selection,
      typing: input.command === undefined ? input.text ?? "" : null });
    return (record?.parts ?? []).flatMap(part => part.kind === "text" ? part.inserted : []).map(identity => {
      const unit = readSharedAnchorUnit(identity);
      assert.ok(unit);
      return unitKey(unit);
    });
  }

  length(beat: string): number { return this.history(beat).units.length; }

  private placed(id: string): { readonly history: SharedTextHistory; readonly index: number } | null {
    for (const [index, beat] of this.world.beats.entries()) {
      const history = this.history(beat);
      if (history.known(identityOf(id))) return { history, index };
    }
    return null;
  }

  rootOf(id: string): string {
    const found = this.placed(id);
    return found ? unitKey(found.history.root(identityOf(id))) : id;
  }

  spot(id: string): number | undefined {
    const found = this.placed(id);
    return found ? found.index * 1000000 + found.history.order(identityOf(id)) : undefined;
  }

  knows(mark: string): boolean {
    return this.world.beats.some(beat => this.history(beat).records.some(item => item.identity === mark));
  }

  mark(observed: ModelObservation, mark: SharedMarkValue): string[] {
    const span = this.spans.get(observed);
    const record = this.command(span ? [operation({ kind: "mark", ...this.author(), target: address(observed.beat), observed: [span], mark })] : [],
      { label: "format", selection: observed.selection, typing: null });
    return (record?.parts ?? []).flatMap(part => part.kind === "mark-add" ? part.added.map(entry => entry.occurrence) : []);
  }

  status(beat: string, value: string): void {
    const target = { scope: "beat", record: ref(beat) } as const;
    this.command(readSharedStatus(this.handle, target) === value ? []
      : [operation({ kind: "status", ...this.author(), target, value, parents: readSharedStatusHeads(this.handle, target) })], { label: "status", selection: null, typing: null });
  }

  scalar(beat: string, field: string, value: SharedJsonValue | undefined): void {
    this.command([operation({ kind: "scalar", ...this.author(), target: { scope: "beat", record: ref(beat) }, field, ...(value === undefined ? { clear: true } : { value }) })],
      { label: "field", selection: null, typing: null });
  }

  record(action: UndoRecordAction, collection: SharedRecordCollection, key: string, value: string): string | null {
    const target = { collection, record: key }, main = collection === "comments" || collection === "replies" ? "text" : "name";
    const [commentId, id] = collection === "replies" ? JSON.parse(key) as [string, string] : ["", ""];
    const fields: Record<SharedRecordCollection, Record<string, unknown>> = {
      comments: { createdAt: 0, text: value, rowId: this.world.beats[0], field: "audioText" },
      replies: { id, commentId, createdAt: 0, text: value },
      people: { name: value }, tags: { cat: "prop", name: value }, shots: { name: value, origin: "list" }, gallery: {}, visuals: {}
    };
    const made = action === "create" ? { kind: "record-create", ...this.author(), target, fields: fields[collection] }
      : action === "set" ? { kind: "record-set", ...this.author(), target, field: main, value } : { kind: "record-delete", ...this.author(), target };
    let reason: string | null = null;
    this.world.now += 2000;
    this.undo.perform(() => {
      const execution = executeSharedCommand(this.handle, [operation(made)], { label: "record", selection: null, typing: null });
      if (!execution.result.ok) reason = execution.result.reason;
      return execution.record;
    });
    return reason;
  }

  private reverse(record: SharedUndoRecord): SharedUndoReversal {
    if (this.refuseNextReversal !== null) {
      const reason = this.refuseNextReversal;
      this.refuseNextReversal = null;
      return { ok: false, reason };
    }
    if (this.failNextReversal !== null) {
      const message = this.failNextReversal;
      this.failNextReversal = null;
      throw new Error(message);
    }
    const reversal = reverseSharedUndoRecord(this.handle, record, { by: modelWriters[this.name].by, nextId: () => this.author().id });
    this.world.nameRestorations(this);
    return reversal;
  }

  caret(selection: SharedUndoSelection): CollabCaret {
    const resolve = (anchor: SharedContentRef): { beat: string; offset: number } => {
      const beat = (JSON.parse(anchor) as { segment: string }).segment.slice(2), offset = this.history(beat).offset(anchor);
      assert.notEqual(offset, null);
      return { beat, offset: offset ?? 0 };
    };
    const from = resolve(selection.anchor), to = resolve(selection.focus);
    return selection.anchor === selection.focus ? from : { ...from, selection: { beat: from.beat, from: from.offset, to: to.offset } };
  }

  snapshot(): ModelSnapshot {
    const records: Record<string, string> = {};
    for (const collection of SHARED_UNDO_RECORDS) for (const item of readSharedRecords(this.handle, collection)) {
      const fields = item.fields as Record<string, unknown>;
      records[collection + "|" + item.key] = JSON.stringify(Object.keys(fields).sort().map(field => [field, fields[field]]));
    }
    return { records, rows: this.world.beats.map(beat => {
      const history = this.history(beat), record = scalarTarget(this.handle, { scope: "beat", record: ref(beat) });
      return { id: beat, status: readSharedStatus(this.handle, { scope: "beat", record: ref(beat) }),
        scalars: Object.fromEntries(SCALARS.filter(field => record?.has(field)).map(field => [field, JSON.stringify(record?.get(field))] as const)),
        characters: history.units.map(unit => ({ id: unitKey(unit.unit), root: unitKey(history.root(unit.unit)), value: typeof unit.value === "string" ? unit.value : "￼",
          marks: [...new Set(unit.marks.flatMap(group => group.kind === "tag" ? group.values.map(value => "tag:" + String(value)) : [group.kind + ":true"]))].sort() })) };
    }) };
  }
}

export class AdapterWorld {
  readonly beats: readonly string[];
  readonly queue = new DeliveryQueue<Uint8Array>(bytes => bytes.slice(), bytes => String(bytes.length));
  readonly replicas = new Map<ReplicaName, AdapterReplica>();
  readonly book = new IdentityBook();
  now = 0;
  private readonly restored = new Map<string, number>();
  private readonly named = new Set<string>();
  private forwarded = 0;

  constructor(seed: readonly SeedBeat[], writers: readonly ReplicaName[] = ["A", "B"]) {
    this.beats = seed.map(row => row.id);
    const base = createMonitoredSharedDocument();
    try {
      collabState(base).doc.clientID = 10;
      hydrateSharedDocument(base, validatedFixture({ rows: seed.map(row => ({ id: row.id, audioText: row.text })) }));
      const state = encodeSharedState(base);
      for (const name of writers) {
        const replica = new AdapterReplica(this, name, state);
        this.replicas.set(name, replica);
        this.queue.addReplica(name, deliveryReplica(replica.handle));
      }
      let serial = 0;
      const first = this.replica(writers[0] ?? "A");
      for (const beat of this.beats) for (const unit of first.history(beat).units) this.book.bind("s" + ++serial, unit.unit);
    } finally { destroySharedDocument(base); }
  }

  replica(name: ReplicaName): AdapterReplica {
    const found = this.replicas.get(name);
    if (!found) throw new Error("No replica " + name);
    return found;
  }

  join(name: ReplicaName, source: ReplicaName): AdapterReplica {
    const replica = new AdapterReplica(this, name, null);
    this.replicas.set(name, replica);
    this.queue.lateJoin(name, deliveryReplica(replica.handle), source, encodeSharedState(this.replica(source).handle));
    // why: a joiner syncs with the same server as its source, so what is still on its way to the source reaches it too.
    for (const message of this.queue.pending.filter(candidate => candidate.to === source)) {
      this.queue.pending.push({ ...message, id: "J" + ++this.forwarded, to: name, update: message.update.slice() });
    }
    return replica;
  }

  fresh(source: ReplicaName): AdapterReplica {
    return new AdapterReplica(this, "C", encodeSharedState(this.replica(source).handle));
  }

  sync(): void {
    const present = [...this.replicas.values()];
    for (const source of present) for (const target of present) if (source !== target) assert.equal(applySharedUpdate(target.handle, encodeSharedState(source.handle)).ok, true);
  }

  name(ids: readonly string[], names: readonly string[]): void {
    ids.forEach((id, index) => { this.book.bind(names[index] ?? id, identityOf(id)); });
  }

  nameRestorations(replica: AdapterReplica): void {
    for (const beat of this.beats) {
      const history = replica.history(beat);
      const births = history.records.flatMap(item => {
        const original = item.record.type === "birth" ? readSharedTextRestoreOperation(item.record.operation) : null;
        return original && item.record.type === "birth" && !this.named.has(unitKey(item.record.born)) ? [{ original, born: item.record.born }] : [];
      }).sort((a, b) => history.order(a.born) - history.order(b.born) || a.born.clock - b.born.clock);
      for (const { original, born } of births) {
        const count = (this.restored.get(unitKey(original)) ?? 0) + 1;
        this.restored.set(unitKey(original), count);
        this.named.add(unitKey(born));
        this.book.bind(this.book.notation(original) + "*" + "'".repeat(count - 1), { client: born.client, clock: born.clock });
      }
    }
  }

  model(replica: { readonly name: ReplicaName }, options: { readonly carets?: Readonly<Record<string, SharedUndoSelection>>; readonly status?: boolean } = {}): CollabModel {
    assert.ok(replica instanceof AdapterReplica);
    const rows = this.beats.map((beat): CollabRow => ({
      id: beat,
      characters: replica.history(beat).units.map(unit => {
        const marks: Record<string, string | boolean> = {};
        for (const group of unit.marks) {
          if ((FORMATS as readonly string[]).includes(group.kind)) marks[group.kind] = true;
          else if (group.kind === "tag" && typeof group.values[0] === "string") marks.tag = group.values[0];
        }
        return { identity: unit.unit, notation: this.book.notation(unit.unit), value: typeof unit.value === "string" ? unit.value : "￼", marks, beat };
      }),
      ...(options.status ? { status: readSharedStatus(replica.handle, { scope: "beat", record: ref(beat) }) } : {})
    }));
    const carets = Object.fromEntries(Object.entries(options.carets ?? {}).map(([name, selection]) => [name, replica.caret(selection)]));
    if (!options.status) return { rows, carets, recovery: [] };
    const notices = [...new Set(this.beats.flatMap(beat => readSharedStatusNotices(replica.handle, { scope: "beat", record: ref(beat) })))].sort();
    return { rows, carets, recovery: [], ...(notices.length ? { notices } : {}) };
  }
}
