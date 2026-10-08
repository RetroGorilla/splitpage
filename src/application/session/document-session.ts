import type { ValidatedDocument } from "../../core/document/validated.ts";
import { isDocumentObject } from "../../core/migrate.ts";
import { WHOLE_DOCUMENT, isEmpty, needsReconciliation } from "./change-set.ts";
import type { ChangeSet, SessionChange, TransactionKind } from "./change-set.ts";
import { createEffectScheduler } from "./effects.ts";
import type { RefreshTiming } from "./effects.ts";
import type { CapabilityPort, DocumentEntry, EffectPort, ReconcilePort, TimerPort, UndoPort } from "./ports.ts";

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
  readonly plan: (doc: DocumentView) => Plan | Refusal | null;
}

export type CommandOutcome =
  | { readonly kind: "applied"; readonly generation: number; readonly changes: ChangeSet }
  | { readonly kind: "noop" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: unknown };

export interface SessionPorts {
  entry: DocumentEntry;
  undo: UndoPort;
  effects: EffectPort;
  capability: CapabilityPort;
  reconcile: ReconcilePort;
  timers: TimerPort;
  timing?: RefreshTiming | undefined;
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
  absorbReload: (content: ReloadedContent) => ValidatedDocument | null;
  settle: (kind: AbsorbedKind) => void;
  run: (command: Command) => CommandOutcome;
  noteEdit: (changes?: ChangeSet) => void;
  refresh: (job: string) => void;
  subscribe: (listener: SessionListener) => () => void;
}

export const NO_DOCUMENT = "no document";

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
  let epoch = 0;
  let generation = 0;

  function enter(raw: unknown): ValidatedDocument | null {
    return raw === null || raw === undefined ? null : ports.entry(raw);
  }

  function refuses(raw: unknown): boolean {
    return raw !== null && raw !== undefined && !isDocumentObject(raw);
  }

  function changeOf(kind: TransactionKind, changes: ChangeSet): SessionChange {
    return Object.freeze({ kind: kind, epoch: epoch, generation: generation, changes: changes });
  }

  function publish(change: SessionChange): void {
    listeners.slice().forEach(function (listener) { listener(change); });
  }

  function commit(changes: ChangeSet): number {
    generation++;
    ports.undo.record(changes);
    const change = changeOf("edit", changes);
    scheduler.pass(change);
    publish(change);
    return generation;
  }

  function adopt(raw: unknown): ValidatedDocument | null {
    if (refuses(raw)) return document;
    const doc = enter(raw);
    ports.undo.adopt(doc);
    epoch++;
    document = doc;
    publish(changeOf("adopt", WHOLE_DOCUMENT));
    return doc;
  }

  function absorb(kind: "server" | "recovery", raw: unknown): ValidatedDocument | null {
    if (refuses(raw)) return document;
    const doc = enter(raw);
    ports.undo.absorbServer(doc);
    if (kind === "recovery") epoch++;
    document = doc;
    publish(changeOf(kind, WHOLE_DOCUMENT));
    return doc;
  }

  function absorbReload(content: ReloadedContent): ValidatedDocument | null {
    const doc = document;
    if (!doc) return null;
    const next = ports.entry(copied({ ...doc, title: content.title, rows: content.rows }));
    takeInPlace(doc, next);
    ports.undo.absorbReload();
    publish(changeOf("reload", WHOLE_DOCUMENT));
    return doc;
  }

  function settle(kind: AbsorbedKind): void {
    ports.undo.record(WHOLE_DOCUMENT);
    scheduler.pass(changeOf(kind, WHOLE_DOCUMENT));
  }

  function run(command: Command): CommandOutcome {
    const doc = document;
    if (!doc) return { kind: "rejected", reason: NO_DOCUMENT };
    if (command.needs === "edit") {
      const can = ports.capability.edit();
      if (!can.allowed) return { kind: "rejected", reason: can.reason };
    }
    let plan: Plan | Refusal | null;
    try {
      plan = command.plan(doc);
    } catch (error) {
      return { kind: "failed", error: error };
    }
    if (!plan) return { kind: "noop" };
    if ("refused" in plan) return { kind: "rejected", reason: plan.refused };
    if (isEmpty(plan.changes)) return { kind: "noop" };
    const restore = rollbackPoint(doc, plan.changes);
    try {
      plan.apply(doc);
    } catch (error) {
      restore();
      return { kind: "failed", error: error };
    }
    if (needsReconciliation(plan.changes)) {
      const unanchor = anchorPoint(doc);
      try {
        ports.reconcile.anchors(doc);
      } catch (error) {
        unanchor();
        restore();
        return { kind: "failed", error: error };
      }
    }
    return { kind: "applied", generation: commit(plan.changes), changes: plan.changes };
  }

  return {
    epoch: function () { return epoch; },
    generation: function () { return generation; },
    read: function (select) { return select(document); },
    adopt: adopt,
    absorbServer: function (raw) { return absorb("server", raw); },
    absorbRecovery: function (raw) { return absorb("recovery", raw); },
    absorbReload: absorbReload,
    settle: settle,
    run: run,
    noteEdit: function (changes) { commit(changes || WHOLE_DOCUMENT); },
    refresh: function (job) { scheduler.refresh(job); },
    subscribe: function (listener) {
      listeners.push(listener);
      return function () {
        const at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      };
    }
  };
}
