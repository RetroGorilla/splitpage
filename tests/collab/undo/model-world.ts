import type { SharedContentRef, SharedFieldValue, SharedJsonValue, SharedMarkValue, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import type { SharedUndoMarkOccurrence, SharedUndoPart, SharedUndoRecord, SharedUndoSelection, SharedUndoUnit } from "../../../src/core/collab/undo-record.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import type { SharedUndo, SharedUndoReversal } from "../../../src/application/editing/undo/shared-undo.ts";
import { IdentityBook } from "../checker.ts";
import type { CollabCaret, CollabIdentity, CollabModel, CollabRow } from "../checker.ts";
import { DeliveryQueue } from "../delivery.ts";
import type { DeliveryReplica, ReplicaName } from "../delivery.ts";
import type { SeedBeat } from "../oracles/seed-beat.ts";
import { ModelView, compareModelIds, modelStatusHeads, resolveModelStatus } from "./model-state.ts";
import type { ModelMark, ModelOp, ModelStatus } from "./model-state.ts";

export const MODEL_UNDO_PARTS = ["text", "mark-add", "mark-remove", "scalar", "status", "status-retired"] as const;
export const modelWriters = { A: { client: 1, by: "Alice" }, B: { client: 2, by: "Bob" }, C: { client: 3, by: "Carol" } } as const;

export interface ModelObservation {
  readonly beat: string;
  readonly left: string | null;
  readonly ids: readonly string[];
  readonly selection: SharedUndoSelection;
}

export interface ModelSnapshotCharacter { id: string; root: string; value: string; marks: string[] }
export interface ModelSnapshot {
  rows: { id: string; characters: ModelSnapshotCharacter[]; status: string; scalars: Record<string, string> }[];
  records?: Record<string, string>;
}

function ref(value: string): SharedContentRef { return value as SharedContentRef; }
function identityOf(id: string): CollabIdentity { const [client = 0, clock = 0] = id.split(":").map(Number); return { client, clock }; }
export function caretAfter(character: string): SharedUndoSelection { return { anchor: point(character, "after"), focus: point(character, "after") }; }
function point(character: string, side: "before" | "after"): SharedContentRef { return ref(JSON.stringify({ c: character, s: side })); }
function address(beat: string): SharedTextAddress { return { owner: ref(beat), segment: ref("b:" + beat), field: "audioText" }; }
function sameValue(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function markKey(mark: SharedMarkValue): { key: string; value: string | true } {
  return { key: mark.kind, value: mark.kind === "tag" || mark.kind === "comment" || mark.kind === "link" ? mark.id : true };
}

export class ModelReplica implements DeliveryReplica<ModelOp[]> {
  readonly name: ReplicaName;
  readonly undo: SharedUndo;
  readonly ops = new Map<string, ModelOp>();
  readonly written: ModelOp[][] = [];
  failNextReversal: string | null = null;
  refuseNextReversal: string | null = null;
  typing = false;
  private readonly world: ModelWorld;
  private readonly listeners = new Set<(update: ModelOp[]) => void>();
  private readonly waiting = new Map<string, ModelOp>();
  private readonly heads = new Map<number, number>();
  private serial = 0;
  private clock = 0;
  private cached: ModelView | null = null;
  private pending: ModelOp[] | null = null;

  constructor(world: ModelWorld, name: ReplicaName) {
    this.world = world;
    this.name = name;
    this.undo = createSharedUndo({
      now: () => world.now,
      supports: part => (MODEL_UNDO_PARTS as readonly string[]).includes(part),
      reverse: record => this.reverse(record)
    });
  }

  get view(): ModelView {
    this.cached ??= new ModelView(this.ops.values(), this.world.beats, "todo");
    return this.cached;
  }

  onLocalUpdate(listener: (update: ModelOp[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  apply(update: ModelOp[]): void {
    for (const op of update) if (!this.ops.has(op.id)) this.waiting.set(op.id, op);
    for (let moved = true; moved;) {
      moved = false;
      for (const op of [...this.waiting.values()].sort((a, b) => compareModelIds(a.id, b.id))) {
        if (!this.ready(op)) continue;
        this.waiting.delete(op.id);
        this.integrate(op);
        moved = true;
      }
    }
  }

  // why: like the shared document, a change waits until the sender's earlier changes and everything it names arrived.
  private ready(op: ModelOp): boolean {
    const [client = 0, serial = 0] = op.id.split(":").map(Number);
    const named = op.kind === "char" ? [op.after, op.restores, ...op.excluded] : op.kind === "delete" ? [op.char] : op.kind === "mark" ? [op.from, op.to]
      : op.kind === "unmark" ? [op.from, op.to, ...op.occurrences] : op.kind === "status" ? op.parents : op.kind === "retire" ? [op.event] : [op.after];
    return serial === (this.heads.get(client) ?? 0) + 1 && named.every(id => id === null || this.ops.has(id));
  }

  private integrate(op: ModelOp): void {
    const [client = 0, serial = 0] = op.id.split(":").map(Number);
    this.ops.set(op.id, op);
    this.heads.set(client, serial);
    if (op.kind === "char") this.clock = Math.max(this.clock, op.clock);
    this.cached = null;
  }

  state(): ModelOp[] { return [...this.ops.values(), ...this.waiting.values()]; }

  private id(): string { return modelWriters[this.name].client + ":" + ++this.serial; }

  private emit(op: ModelOp): void {
    if (!this.pending) throw new Error("Model writes happen inside a command");
    this.integrate(op);
    this.pending.push(op);
  }

  private transact<T>(change: () => T): T {
    if (this.pending) throw new Error("Model commands cannot nest");
    const update: ModelOp[] = this.pending = [];
    try { return change(); }
    finally {
      this.pending = null;
      if (update.length) {
        this.written.push(update);
        for (const listener of this.listeners) listener(update);
      }
    }
  }

  private command(build: () => SharedUndoRecord | null): void {
    if (!this.typing) this.world.now += 2000;
    this.undo.perform(() => this.transact(build));
  }

  observe(beat: string, from: number, to: number): ModelObservation {
    const view = this.view, visible = view.visible(beat), sequence = view.sequences.get(beat) ?? [], ids = visible.slice(from, to), next = visible[from];
    // why: like the shared text, an insertion at a gap lands after the deleted characters already in that gap.
    const left = (next === undefined ? sequence.at(-1) : sequence[(view.position.get(next) ?? 0) - 1]) ?? null, before = visible[from - 1];
    const first = ids[0], last = ids.at(-1);
    const caret = before !== undefined ? point(before, "after") : next !== undefined ? point(next, "before") : ref(JSON.stringify({ b: beat }));
    return { beat, left, ids, selection: first !== undefined && last !== undefined ? { anchor: point(first, "before"), focus: point(last, "after") } : { anchor: caret, focus: caret } };
  }

  caretAfter(character: string): SharedUndoSelection { return caretAfter(character); }

  private marksOf(id: string): SharedMarkValue[] {
    return this.view.occurrences(id).map((mark): SharedMarkValue => mark.key === "tag"
      ? { kind: "tag", id: ref(String(mark.value)), value: ref(String(mark.value)) } : { kind: "b", value: true });
  }

  private insert(beat: string, after: string | null, restores: string | null, value: string, marks: readonly SharedMarkValue[]): string {
    const id = this.id();
    this.emit({ kind: "char", id, beat, after, restores, value, clock: ++this.clock, by: modelWriters[this.name].by, excluded: this.view.marks.map(mark => mark.id) });
    for (const mark of marks) this.writeMark(markKey(mark).key, markKey(mark).value, id, id);
    if (restores !== null) this.world.nameRestoration(id, restores);
    return id;
  }

  private remove(id: string): SharedUndoUnit {
    const unit: SharedUndoUnit = { identity: ref(id), value: this.view.characters.get(id)?.value ?? "", marks: this.marksOf(id) };
    this.emit({ kind: "delete", id: this.id(), char: id });
    return unit;
  }

  edit(input: { readonly at: ModelObservation; readonly remove?: ModelObservation; readonly text?: string; readonly marks?: readonly SharedMarkValue[]; readonly caret?: ModelObservation; readonly command?: string }): string[] {
    const created: string[] = [];
    this.command(() => {
      let after = input.at.left;
      for (const value of (input.text ?? "").split("")) {
        after = this.insert(input.at.beat, after, null, value, input.marks ?? []);
        created.push(after);
      }
      const deleted = (input.remove ?? input.at).ids.filter(id => this.view.live(id)).map(id => this.remove(id));
      if (!created.length && !deleted.length) return null;
      return { label: input.command ?? "typing", selection: (input.caret ?? input.at).selection, typing: input.command === undefined ? input.text ?? "" : null,
        parts: [{ kind: "text", target: address(input.at.beat), inserted: created.map(ref), deleted }] };
    });
    return created;
  }

  length(beat: string): number { return this.view.visible(beat).length; }
  rootOf(id: string): string { return this.view.root(id); }
  spot(id: string): number | undefined { return this.view.position.get(id); }
  knows(mark: string): boolean { return this.ops.has(mark); }

  mark(observed: ModelObservation, mark: SharedMarkValue): string[] {
    const updates = this.written.length;
    this.markCommand(observed, mark);
    return this.written.length > updates ? (this.written.at(-1) ?? []).filter(op => op.kind === "mark").map(op => op.id) : [];
  }

  private markCommand(observed: ModelObservation, mark: SharedMarkValue): void {
    this.command(() => {
      const first = observed.ids[0], last = observed.ids.at(-1), view = this.view, { key, value } = markKey(mark);
      if (first === undefined || last === undefined) return null;
      const from = view.position.get(first) ?? 0, to = view.position.get(last) ?? -1;
      // why: T21: a mark is given a range, so it also covers what arrived between the two ends it was given.
      const live = view.visible(observed.beat).filter(id => { const at = view.position.get(id) ?? -1; return from <= at && at <= to; });
      if (mark.value === null) {
        const removed = this.view.marks.filter(candidate => candidate.key === key && (mark.kind !== "tag" || candidate.value === value))
          .map(candidate => ({ occurrence: ref(candidate.id), units: live.filter(id => this.view.occurrences(id).includes(candidate)).map(ref) }))
          .filter(entry => entry.units.length);
        if (!removed.length) return null;
        this.emit({ kind: "unmark", id: this.id(), occurrences: removed.map(entry => entry.occurrence), from: first, to: last, identical: false });
        return { label: "format", selection: observed.selection, typing: null, parts: [{ kind: "mark-remove", target: address(observed.beat), mark, removed }] };
      }
      if (!live.length) return null;
      // why: prepareSharedMarkChange writes one occurrence over the whole range, also where the mark already shows.
      const added = [{ occurrence: ref(this.writeMark(key, value, first, last)), units: live.map(ref) }];
      return { label: "format", selection: observed.selection, typing: null, parts: [{ kind: "mark-add", target: address(observed.beat), mark, added }] };
    });
  }

  private writeMark(key: string, value: string | true, from: string, to: string): string {
    const known = this.view.marks.filter(other => other.key === key && other.value === value && other.from === from && other.to === to);
    const generation = 1 + Math.max(0, ...known.map(other => other.generation));
    const mark: ModelMark = { kind: "mark", id: this.id(), key, value, from, to, by: modelWriters[this.name].by, generation };
    this.emit(mark);
    return mark.id;
  }

  private restoreMarks(beat: string, key: string, value: string | true, wanted: ReadonlySet<string>): SharedUndoMarkOccurrence[] {
    const view = this.view, runs: string[][] = [];
    let open: string[] | null = null;
    for (const id of view.visible(beat)) {
      // why: putting a mark back touches only the recorded characters that do not show it; the rest is other people's.
      if (!wanted.has(id) || view.occurrences(id).some(mark => mark.key === key && mark.value === value)) { open = null; continue; }
      if (!open) { open = []; runs.push(open); }
      open.push(id);
    }
    return runs.map(run => ({ occurrence: ref(this.writeMark(key, value, run[0] ?? "", run.at(-1) ?? "")), units: run.map(ref) }));
  }

  status(beat: string, value: string): void {
    this.command(() => {
      if (this.view.status(beat) === value) return null;
      const id = this.id();
      this.emit({ kind: "status", id, beat, value, parents: modelStatusHeads(this.view.events.get(beat) ?? new Map<string, ModelStatus>()), by: modelWriters[this.name].by });
      return { label: "status", selection: null, typing: null, parts: [{ kind: "status", target: { scope: "beat", record: ref(beat) }, event: ref(id), value }] };
    });
  }

  scalar(beat: string, field: string, value: SharedJsonValue | undefined): void {
    this.command(() => {
      const current = this.view.scalar(beat, field), written: SharedFieldValue = value === undefined ? { clear: true } : { value };
      const prior: SharedFieldValue = current.clear ? { clear: true } : { value: current.value };
      if (sameValue(prior, written)) return null;
      this.writeScalar(beat, field, written);
      return { label: "field", selection: null, typing: null, parts: [{ kind: "scalar", target: { scope: "beat", record: ref(beat) }, field, prior, written }] };
    });
  }

  private writeScalar(beat: string, field: string, value: SharedFieldValue): void {
    this.emit({ kind: "scalar", id: this.id(), beat, field, value: value.clear ? null : value.value, clear: value.clear === true, after: this.view.scalarHead(beat, field) });
  }

  private reverse(record: SharedUndoRecord): SharedUndoReversal {
    if (this.refuseNextReversal !== null) {
      const reason = this.refuseNextReversal;
      this.refuseNextReversal = null;
      return { ok: false, reason };
    }
    return this.transact(() => {
      if (this.failNextReversal !== null) {
        const message = this.failNextReversal;
        this.failNextReversal = null;
        throw new Error(message);
      }
      const inverse: SharedUndoPart[] = [];
      let effective = false;
      for (const part of [...record.parts].reverse()) {
        const reversed = this.reversePart(part);
        effective ||= reversed.effective;
        inverse.unshift(reversed.inverse);
      }
      return { ok: true, effective, inverse: { label: record.label, parts: inverse, selection: record.selection, typing: null }, selection: record.selection };
    });
  }

  private reversePart(part: SharedUndoPart): { effective: boolean; inverse: SharedUndoPart } {
    switch (part.kind) {
      case "text": {
        const deleted = part.inserted.map(id => this.view.follow(id)).filter(id => this.view.live(id)).map(id => this.remove(id));
        const inserted: SharedContentRef[] = [];
        for (const unit of part.deleted) {
          const view = this.view, original = view.characters.get(unit.identity), root = view.root(unit.identity);
          // why: a deletion someone already undid, or whose character is back, is not undone a second time.
          if (!original || view.restorations.has(unit.identity) || view.visible(original.beat).some(id => view.root(id) === root)) continue;
          inserted.push(ref(this.insert(original.beat, null, unit.identity, typeof unit.value === "string" ? unit.value : "", [])));
        }
        return { effective: deleted.length + inserted.length > 0, inverse: { kind: "text", target: part.target, inserted, deleted } };
      }
      case "mark-add": {
        const mine = part.added.map(entry => entry.occurrence as string), removed: SharedUndoMarkOccurrence[] = [];
        for (const mark of this.view.marks.filter(candidate => mine.includes(candidate.id))) {
          const units = this.view.shown(mark.id);
          if (!units.length) continue;
          // why: the cancellation is kept with the occurrence, so an identical change that arrives later is cancelled too.
          this.emit({ kind: "unmark", id: this.id(), occurrences: [mark.id], from: mark.from, to: mark.to, identical: true });
          removed.push({ occurrence: ref(mark.id), units: units.map(ref) });
        }
        return { effective: removed.length > 0, inverse: { kind: "mark-remove", target: part.target, mark: part.mark, removed } };
      }
      case "mark-remove": {
        const { key, value } = markKey(part.mark), view = this.view;
        const wanted = new Set(part.removed.flatMap(entry => entry.units.map(unit => view.follow(unit))));
        const added = this.restoreMarks(String(part.target.owner), key, value, wanted);
        return { effective: added.length > 0, inverse: { kind: "mark-add", target: part.target, mark: part.mark, added } };
      }
      case "scalar": {
        const beat = String(part.target.record), current = this.view.scalar(beat, part.field);
        const now: SharedFieldValue = current.clear ? { clear: true } : { value: current.value };
        const inverse: SharedUndoPart = { ...part, prior: part.written, written: part.prior };
        if (!sameValue(now, part.written)) return { effective: false, inverse };
        this.writeScalar(beat, part.field, part.prior);
        return { effective: true, inverse };
      }
      case "status":
      case "status-retired": return this.reverseStatus(part);
      default: throw new Error("The model executor has no reversal for " + part.kind);
    }
  }

  private reverseStatus(part: Extract<SharedUndoPart, { kind: "status" | "status-retired" }>): { effective: boolean; inverse: SharedUndoPart } {
    const beat = String(part.target.record), view = this.view, events = view.events.get(beat) ?? new Map<string, ModelStatus>(), now = view.status(beat);
    if (part.kind === "status-retired") {
      if (now === part.value) return { effective: false, inverse: { ...part, kind: "status" } };
      const id = this.id();
      this.emit({ kind: "status", id, beat, value: part.value, parents: modelStatusHeads(events), by: modelWriters[this.name].by });
      return { effective: true, inverse: { kind: "status", target: part.target, event: ref(id), value: part.value } };
    }
    const inverse: SharedUndoPart = { ...part, kind: "status-retired" };
    const superseded = (id: string): boolean => [...events.values()].some(event => event.parents.includes(id) && (!view.retired.has(event.id) || superseded(event.id)));
    const standing = [...events.values()].filter(event => !view.retired.has(event.id) && !superseded(event.id));
    // why: T21 scalar: a change that lost a conflict never applied, so its undo writes nothing and is used up.
    if (now !== part.value || !standing.some(event => event.id === part.event)) return { effective: false, inverse };
    const retire = standing.filter(event => event.value === part.value).map(event => event.id).sort(compareModelIds);
    if (resolveModelStatus(events, new Set([...view.retired, ...retire]), view.stored) === now) return { effective: false, inverse };
    for (const event of retire) this.emit({ kind: "retire", id: this.id(), event });
    return { effective: true, inverse };
  }

  resolve(anchor: SharedContentRef): { beat: string; offset: number } {
    const raw = JSON.parse(anchor) as { b?: string; c?: string; s?: "before" | "after" }, view = this.view;
    if (raw.c === undefined) return { beat: raw.b ?? "", offset: 0 };
    const id = view.follow(raw.c), beat = view.characters.get(id)?.beat ?? "", at = view.position.get(id) ?? 0;
    const before = (view.sequences.get(beat) ?? []).slice(0, at).filter(other => view.live(other)).length;
    return { beat, offset: before + (view.live(id) && raw.s === "after" ? 1 : 0) };
  }

  caret(selection: SharedUndoSelection): CollabCaret {
    const from = this.resolve(selection.anchor), to = this.resolve(selection.focus);
    return selection.anchor === selection.focus ? from : { ...from, selection: { beat: from.beat, from: from.offset, to: to.offset } };
  }

  snapshot(): ModelSnapshot {
    const view = this.view;
    return { rows: this.world.beats.map(beat => ({
      id: beat, status: view.status(beat),
      scalars: Object.fromEntries([...view.scalars.values()].filter(op => op.beat === beat && !op.clear).map(op => [op.field, JSON.stringify(op.value)] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
      characters: view.visible(beat).map(id => ({ id, root: view.root(id), value: view.characters.get(id)?.value ?? "",
        marks: [...new Set(view.occurrences(id).map(mark => mark.key + ":" + String(mark.value)))].sort() }))
    })) };
  }
}

export class ModelWorld {
  readonly beats: readonly string[];
  readonly queue = new DeliveryQueue<ModelOp[]>(update => JSON.parse(JSON.stringify(update)) as ModelOp[], update => update.length + " ops");
  readonly replicas = new Map<ReplicaName, ModelReplica>();
  readonly book = new IdentityBook();
  now = 0;
  private readonly seed: ModelOp[] = [];
  private readonly restored = new Map<string, number>();
  private forwarded = 0;

  constructor(seed: readonly SeedBeat[], writers: readonly ReplicaName[] = ["A", "B"]) {
    this.beats = seed.map(row => row.id);
    let serial = 0;
    for (const row of seed) {
      let after: string | null = null;
      for (const value of row.text.split("")) {
        const id: string = "10:" + ++serial;
        this.seed.push({ kind: "char", id, beat: row.id, after, restores: null, value, clock: 0, by: "seed", excluded: [] });
        this.book.bind("s" + serial, identityOf(id));
        after = id;
      }
    }
    for (const name of writers) {
      const replica = new ModelReplica(this, name);
      replica.apply(this.seed);
      this.replicas.set(name, replica);
      this.queue.addReplica(name, replica);
    }
  }

  replica(name: ReplicaName): ModelReplica {
    const found = this.replicas.get(name);
    if (!found) throw new Error("No replica " + name);
    return found;
  }

  join(name: ReplicaName, source: ReplicaName): ModelReplica {
    const replica = new ModelReplica(this, name);
    this.replicas.set(name, replica);
    this.queue.lateJoin(name, replica, source, this.replica(source).state());
    // why: a joiner syncs with the same server as its source, so what is still on its way to the source reaches it too.
    for (const message of this.queue.pending.filter(candidate => candidate.to === source)) {
      this.queue.pending.push({ ...message, id: "J" + ++this.forwarded, to: name, update: JSON.parse(JSON.stringify(message.update)) as ModelOp[] });
    }
    return replica;
  }

  fresh(source: ReplicaName): ModelReplica {
    const replica = new ModelReplica(this, "C");
    replica.apply(this.replica(source).state());
    return replica;
  }

  sync(): void {
    const present = [...this.replicas.values()];
    for (const source of present) for (const target of present) if (source !== target) target.apply(source.state());
  }

  name(ids: readonly string[], names: readonly string[]): void {
    ids.forEach((id, index) => { this.book.bind(names[index] ?? id, identityOf(id)); });
  }

  nameRestoration(id: string, original: string): void {
    this.restored.set(original, (this.restored.get(original) ?? 0) + 1);
    this.book.bind(this.book.notation(identityOf(original)) + "*" + "'".repeat((this.restored.get(original) ?? 1) - 1), identityOf(id));
  }

  model(replica: { readonly name: ReplicaName }, options: { readonly carets?: Readonly<Record<string, SharedUndoSelection>>; readonly status?: boolean } = {}): CollabModel {
    if (!(replica instanceof ModelReplica)) throw new Error("Not a replica of the model world");
    const view = replica.view;
    const rows = this.beats.map((beat): CollabRow => ({
      id: beat,
      characters: view.visible(beat).map(id => {
        const identity = identityOf(id), marks: Record<string, string | boolean> = {};
        for (const mark of view.occurrences(id)) marks[mark.key] = mark.value;
        return { identity, notation: this.book.notation(identity), value: view.characters.get(id)?.value ?? "", marks, beat };
      }),
      ...(options.status ? { status: view.status(beat) } : {})
    }));
    const carets = Object.fromEntries(Object.entries(options.carets ?? {}).map(([name, selection]) => [name, replica.caret(selection)]));
    if (!options.status) return { rows, carets, recovery: [] };
    const events = [...view.events.values()].flatMap(byBeat => [...byBeat.values()]);
    const lost = events.filter(event => events.some(other => other.beat === event.beat && other.value !== event.value
      && sameValue([...other.parents].sort(compareModelIds), [...event.parents].sort(compareModelIds))));
    const notices = [...new Set(lost.map(event => event.by + ": concurrent status change did not apply"))].sort();
    return { rows, carets, recovery: [], ...(notices.length ? { notices } : {}) };
  }
}
