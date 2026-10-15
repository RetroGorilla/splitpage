import type { ValidatedDocument } from "../../core/document/validated.ts";
import { isDocumentObject } from "../../core/migrate.ts";
import { WHOLE_DOCUMENT, changeSet, combined, isEmpty, needsReconciliation } from "./change-set.ts";
import type { ChangeSet, SessionChange, TransactionKind } from "./change-set.ts";
import { attempt, createEffectScheduler } from "./effects.ts";
import type { RefreshTiming } from "./effects.ts";
import type { CapabilityPort, DocumentEntry, EffectPort, ReconcilePort, RecordsPlan, ReportPort, TimerPort, UndoPort } from "./ports.ts";

export type DeepReadonly<T> =
  T extends (infer U)[] ? readonly DeepReadonly<U>[]
    : T extends readonly (infer V)[] ? readonly DeepReadonly<V>[]
      : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

export type DocumentView = DeepReadonly<ValidatedDocument>;

export interface Plan {
  readonly changes: ChangeSet;
  readonly apply: (doc: ValidatedDocument) => void;
}

export interface Refusal {
  readonly refused: string;
}

export interface Command {
  readonly name: string;
  readonly needs: "edit" | "nothing";
  readonly plan: (doc: DocumentView, capability: CapabilityPort) => Plan | Refusal | null;
}

export type CommandOutcome =
  | { readonly kind: "applied"; readonly generation: number; readonly changes: ChangeSet }
  | { readonly kind: "committed"; readonly generation: number; readonly changes: ChangeSet; readonly errors: readonly unknown[] }
  | { readonly kind: "noop" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: unknown };

export interface ReplayPlan {
  readonly changes: ChangeSet;
  readonly apply: (doc: ValidatedDocument) => void;
  readonly settle: () => void;
}

export interface Replay {
  readonly name: string;
  readonly plan: (doc: ValidatedDocument) => ReplayPlan | Refusal | null;
}

export interface AttributionPort {
  readonly attribute: (doc: DocumentView) => Plan | null;
}

export interface SessionPorts {
  entry: DocumentEntry;
  undo: UndoPort;
  effects: EffectPort;
  capability: CapabilityPort;
  reconcile: ReconcilePort;
  attribution: AttributionPort;
  report: ReportPort;
  timers: TimerPort;
  timing?: RefreshTiming | undefined;
  after?: SessionCounters | undefined;
}

export interface SessionCounters {
  readonly epoch: number;
  readonly generation: number;
}

export type AbsorbedKind = "server" | "reload" | "recovery" | "adopt";

export type SessionListener = (change: SessionChange) => void;

export interface ReloadedContent {
  readonly title: unknown;
  readonly rows: unknown;
}

export interface DocumentSession {
  epoch: () => number;
  generation: () => number;
  read: <T>(select: (doc: DocumentView | null) => T) => T;
  adopt: (raw: unknown) => ValidatedDocument | null;
  absorbServer: (raw: unknown) => ValidatedDocument | null;
  absorbRecovery: (raw: unknown) => ValidatedDocument | null;
  absorbMerged: (kind: "server" | "recovery", merged: ValidatedDocument) => ValidatedDocument | null;
  absorbReload: (content: ReloadedContent) => ValidatedDocument | null;
  settle: (kind: AbsorbedKind) => void;
  run: (command: Command) => CommandOutcome;
  replay: (replay: Replay) => CommandOutcome;
  amend: (amendment: Replay) => CommandOutcome;
  noteEdit: (changes?: ChangeSet) => void;
  refresh: (job: string) => void;
  subscribe: (listener: SessionListener) => () => void;
  dispose: () => void;
}

export const NO_DOCUMENT = "no document";

export const DISPOSED = "disposed";

type Restore = () => void;
type Bag = Record<string, unknown>;

function copied(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function owns(owner: Bag, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(owner, key);
}

function keepField(owner: Bag, key: string): Restore {
  const had = owns(owner, key);
  const value = copied(owner[key]);
  const keys = Object.keys(owner);
  const later = had ? keys.slice(keys.indexOf(key) + 1) : [];
  return function () {
    if (!had) {
      Reflect.deleteProperty(owner, key);
      return;
    }
    const gone = !owns(owner, key);
    owner[key] = value;
    if (!gone) return;
    later.forEach(function (next) {
      if (!owns(owner, next)) return;
      const kept = owner[next];
      Reflect.deleteProperty(owner, next);
      owner[next] = kept;
    });
  };
}

function keepWhole(doc: ValidatedDocument): Restore {
  const saved: unknown = JSON.parse(JSON.stringify(doc));
  return function () {
    Object.keys(doc).forEach(function (key) { Reflect.deleteProperty(doc, key); });
    if (saved && typeof saved === "object") Object.assign(doc, saved);
  };
}

function takeInPlace(doc: ValidatedDocument, next: ValidatedDocument): void {
  const taken = new Map<string, unknown>();
  Object.keys(next).forEach(function (key) {
    const was: unknown = Reflect.get(doc, key);
    const value: unknown = Reflect.get(next, key);
    const same = Object.prototype.hasOwnProperty.call(doc, key) && JSON.stringify(was) === JSON.stringify(value);
    taken.set(key, same ? was : value);
  });
  Object.keys(doc).forEach(function (key) { Reflect.deleteProperty(doc, key); });
  taken.forEach(function (value, key) {
    Object.defineProperty(doc, key, { value: value, enumerable: true, writable: true, configurable: true });
  });
}

function rollbackPoint(doc: ValidatedDocument, changes: ChangeSet): Restore {
  if (changes.whole) return keepWhole(doc);
  const undo: Restore[] = [];
  changes.cells.forEach(function (cell) {
    const row = doc.rows.find(function (r) { return r.id === cell.rowId; });
    if (row) undo.push(keepField(row, cell.field));
  });
  changes.docFields.forEach(function (key) { undo.push(keepField(doc, key)); });
  if (changes.rowsInserted.length || changes.rowsRemoved.length || changes.rowsMoved || changes.runsMoved) {
    const rows = doc.rows.slice();
    undo.push(function () { doc.rows.splice(0, doc.rows.length, ...rows); });
  }
  return function () { undo.reverse().forEach(function (restore) { restore(); }); };
}

function anchorPoint(doc: ValidatedDocument): Restore {
  const comments = doc.comments.slice();
  const places = comments.map(function (c) { return { rowId: c.rowId, field: c.field }; });
  return function () {
    doc.comments.splice(0, doc.comments.length, ...comments);
    comments.forEach(function (c, i) {
      const place = places[i];
      if (place) { c.rowId = place.rowId; c.field = place.field; }
    });
  };
}

export function createDocumentSession(ports: SessionPorts): DocumentSession {
  const scheduler = createEffectScheduler(ports.effects, ports.timers, ports.timing);
  const listeners: SessionListener[] = [];
  let document: ValidatedDocument | null = null;
  let epoch = ports.after ? ports.after.epoch : 0;
  let generation = ports.after ? ports.after.generation : 0;
  let disposed = false;

  function enter(raw: unknown): ValidatedDocument | null {
    return raw === null || raw === undefined ? null : ports.entry(raw);
  }

  function refuses(raw: unknown): boolean {
    return raw !== null && raw !== undefined && !isDocumentObject(raw);
  }

  function changeOf(kind: TransactionKind, changes: ChangeSet): SessionChange {
    return Object.freeze({ kind: kind, epoch: epoch, generation: generation, changes: changes });
  }

  function reported(errors: unknown[]): unknown[] {
    errors.forEach(function (error) { ports.report(error); });
    return errors;
  }

  function publish(change: SessionChange, errors: unknown[]): void {
    listeners.slice().forEach(function (listener) {
      attempt(errors, function () { listener(change); });
    });
  }

  function announce(change: SessionChange): void {
    const errors: unknown[] = [];
    publish(change, errors);
    reported(errors);
  }

  function commit(kind: "edit" | "replay" | "amend", changes: ChangeSet): { generation: number; errors: unknown[] } {
    generation++;
    const at = generation;
    const errors: unknown[] = [];
    if (kind === "edit") attempt(errors, function () { ports.undo.record(changes); });
    const change = changeOf(kind, changes);
    scheduler.pass(change).forEach(function (error) { errors.push(error); });
    publish(change, errors);
    return { generation: at, errors: reported(errors) };
  }

  function withRecords(doc: ValidatedDocument, changes: ChangeSet, kept: Restore[] | null): ChangeSet {
    const records = ports.reconcile.records;
    const plan: RecordsPlan | null = records ? records(doc, changes) : null;
    if (!plan || !plan.fields.length) return changes;
    if (kept) plan.fields.forEach(function (key) { kept.push(keepField(doc as unknown as Bag, key)); });
    plan.apply(doc);
    return combined(changes, changeSet({ docFields: plan.fields }));
  }

  function adopt(raw: unknown): ValidatedDocument | null {
    if (disposed) return null;
    if (refuses(raw)) return document;
    const doc = enter(raw);
    ports.undo.adopt(doc);
    epoch++;
    document = doc;
    announce(changeOf("adopt", WHOLE_DOCUMENT));
    return doc;
  }

  function absorb(kind: "server" | "recovery", raw: unknown): ValidatedDocument | null {
    if (disposed) return null;
    if (refuses(raw)) return document;
    return take(kind, enter(raw));
  }

  function take(kind: "server" | "recovery", doc: ValidatedDocument | null): ValidatedDocument | null {
    ports.undo.absorbServer(doc);
    if (kind === "recovery") epoch++;
    document = doc;
    announce(changeOf(kind, WHOLE_DOCUMENT));
    return doc;
  }

  function absorbReload(content: ReloadedContent): ValidatedDocument | null {
    const doc = document;
    if (!doc) return null;
    const next = ports.entry(copied({ ...doc, title: content.title, rows: content.rows }));
    takeInPlace(doc, next);
    ports.undo.absorbReload();
    announce(changeOf("reload", WHOLE_DOCUMENT));
    return doc;
  }

  function settle(kind: AbsorbedKind): void {
    if (disposed) return;
    const errors: unknown[] = [];
    attempt(errors, function () { ports.undo.record(WHOLE_DOCUMENT); });
    scheduler.pass(changeOf(kind, WHOLE_DOCUMENT)).forEach(function (error) { errors.push(error); });
    reported(errors);
  }

  function run(command: Command): CommandOutcome {
    if (disposed) return { kind: "rejected", reason: DISPOSED };
    const doc = document;
    if (!doc) return { kind: "rejected", reason: NO_DOCUMENT };
    if (command.needs === "edit") {
      const can = ports.capability.edit();
      if (!can.allowed) return { kind: "rejected", reason: can.reason };
    }
    let plan: Plan | Refusal | null;
    try {
      plan = command.plan(doc, ports.capability);
    } catch (error) {
      return { kind: "failed", error: error };
    }
    if (!plan) return { kind: "noop" };
    if ("refused" in plan) return { kind: "rejected", reason: plan.refused };
    if (isEmpty(plan.changes)) return { kind: "noop" };
    return transact("edit", doc, plan.changes, plan.apply, null);
  }

  function replay(task: Replay): CommandOutcome {
    return replayAs("replay", task);
  }

  function replayAs(kind: "replay" | "amend", task: Replay): CommandOutcome {
    if (disposed) return { kind: "rejected", reason: DISPOSED };
    const doc = document;
    if (!doc) return { kind: "rejected", reason: NO_DOCUMENT };
    let plan: ReplayPlan | Refusal | null;
    try {
      plan = task.plan(doc);
    } catch (error) {
      return { kind: "failed", error: error };
    }
    if (!plan) return { kind: "noop" };
    if ("refused" in plan) return { kind: "rejected", reason: plan.refused };
    if (isEmpty(plan.changes)) return { kind: "noop" };
    return transact(kind, doc, plan.changes, plan.apply, plan.settle);
  }

  function transact(kind: "edit" | "replay" | "amend", doc: ValidatedDocument, planned: ChangeSet, apply: (doc: ValidatedDocument) => void, settle: (() => void) | null): CommandOutcome {
    let signed: Plan | null;
    try {
      signed = ports.attribution.attribute(doc);
    } catch (error) {
      return { kind: "failed", error: error };
    }
    const sign = signed && !isEmpty(signed.changes) ? signed : null;
    let changes = sign ? combined(planned, sign.changes) : planned;
    const restore = rollbackPoint(doc, changes);
    try {
      apply(doc);
      if (sign) sign.apply(doc);
    } catch (error) {
      restore();
      return { kind: "failed", error: error };
    }
    const unrecord: Restore[] = [];
    let unanchor: Restore | null = null;
    try {
      if (kind === "edit") changes = withRecords(doc, changes, unrecord);
      unanchor = needsReconciliation(changes) ? anchorPoint(doc) : null;
      if (unanchor) ports.reconcile.anchors(doc);
      if (settle) settle();
    } catch (error) {
      if (unanchor) unanchor();
      unrecord.reverse().forEach(function (back) { back(); });
      restore();
      return { kind: "failed", error: error };
    }
    const done = commit(kind, changes);
    if (done.errors.length) return { kind: "committed", generation: done.generation, changes: changes, errors: done.errors.slice() };
    return { kind: "applied", generation: done.generation, changes: changes };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    scheduler.dispose();
    listeners.length = 0;
    document = null;
  }

  return {
    epoch: function () { return epoch; },
    generation: function () { return generation; },
    read: function (select) { return select(document); },
    adopt: adopt,
    absorbServer: function (raw) { return absorb("server", raw); },
    absorbRecovery: function (raw) { return absorb("recovery", raw); },
    absorbMerged: function (kind, merged) {
      if (disposed) return null;
      if (refuses(merged)) return document;
      return take(kind, merged);
    },
    absorbReload: absorbReload,
    settle: settle,
    run: run,
    replay: replay,
    amend: function (task) { return replayAs("amend", task); },
    noteEdit: function (changes) {
      if (disposed) return;
      let noted = changes || WHOLE_DOCUMENT;
      const errors: unknown[] = [];
      if (document) {
        const doc = document;
        attempt(errors, function () { noted = withRecords(doc, noted, null); });
      }
      reported(errors);
      commit("edit", noted);
    },
    refresh: function (job) { scheduler.refresh(job); },
    subscribe: function (listener) {
      if (disposed) return function () {};
      listeners.push(listener);
      return function () {
        const at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      };
    },
    dispose: dispose
  };
}
