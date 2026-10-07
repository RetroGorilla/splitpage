import type { ValidatedDocument } from "../../core/document/validated.ts";
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

export type SessionListener = (change: SessionChange) => void;

export interface DocumentSession {
  epoch: () => number;
  generation: () => number;
  read: <T>(select: (doc: DocumentView | null) => T) => T;
  adopt: (raw: unknown) => ValidatedDocument | null;
  absorbServer: (raw: unknown) => ValidatedDocument | null;
  absorbReload: () => void;
  run: (command: Command) => CommandOutcome;
  noteEdit: (changes?: ChangeSet) => void;
  refresh: (job: string) => void;
  subscribe: (listener: SessionListener) => () => void;
}

export const NO_DOCUMENT = "no document";

export function createDocumentSession(ports: SessionPorts): DocumentSession {
  const scheduler = createEffectScheduler(ports.effects, ports.timers, ports.timing);
  const listeners: SessionListener[] = [];
  let document: ValidatedDocument | null = null;
  let epoch = 0;
  let generation = 0;

  function enter(raw: unknown): ValidatedDocument | null {
    return raw === null || raw === undefined ? null : ports.entry(raw);
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
    const doc = enter(raw);
    epoch++;
    document = doc;
    ports.undo.adopt(doc);
    publish(changeOf("adopt", WHOLE_DOCUMENT));
    return doc;
  }

  function absorbServer(raw: unknown): ValidatedDocument | null {
    const doc = enter(raw);
    document = doc;
    ports.undo.absorbServer(doc);
    publish(changeOf("server", WHOLE_DOCUMENT));
    return doc;
  }

  function absorbReload(): void {
    ports.undo.absorbReload();
    publish(changeOf("reload", WHOLE_DOCUMENT));
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
    plan.apply(doc);
    if (needsReconciliation(plan.changes)) ports.reconcile.anchors(doc);
    return { kind: "applied", generation: commit(plan.changes), changes: plan.changes };
  }

  return {
    epoch: function () { return epoch; },
    generation: function () { return generation; },
    read: function (select) { return select(document); },
    adopt: adopt,
    absorbServer: absorbServer,
    absorbReload: absorbReload,
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
