import type { SharedOperation } from "../../core/collab/operations.ts";
import type { SharedProjectionChanges } from "../../core/collab/projection/changes.ts";
import type { SharedRecoveryEntry } from "../../core/collab/recovery.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { WHOLE_DOCUMENT, changeSet } from "./change-set.ts";
import type { ChangeSet, SessionChange, TransactionKind } from "./change-set.ts";
import { DISPOSED, NO_DOCUMENT } from "./document-session.ts";
import type { Command, CommandOutcome, CommandRefusal, CommonDocumentSession, DocumentView, Plan, SessionCounters, SessionListener } from "./document-session.ts";
import { attempt, createEffectScheduler } from "./effects.ts";
import type { RefreshTiming } from "./effects.ts";
import type { CapabilityPort, DocumentEntry, EffectPort, ReportPort, TimerPort, UndoPort } from "./ports.ts";
import { changesBetween } from "./projection-changes.ts";

export type ReplicaOrigin = "local-command" | "local-undo" | "hydration" | "remote" | "cleanup";

export interface ReplicaFailure { readonly error: unknown }

export type ReplicaExecution = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface ReplicaPort {
  readonly revision: () => number;
  readonly project: () => unknown;
  readonly changes: () => SharedProjectionChanges;
  readonly recovery: () => readonly SharedRecoveryEntry[];
  readonly execute: (operations: readonly SharedOperation[], options: { readonly base: number }) => ReplicaExecution;
  readonly observe: (listener: (origin: ReplicaOrigin | null, failure?: ReplicaFailure) => void) => () => void;
}

export interface SharedSessionPorts {
  readonly replica: ReplicaPort;
  readonly entry: DocumentEntry;
  readonly undo: Pick<UndoPort, "record">;
  readonly effects: EffectPort;
  readonly capability: CapabilityPort;
  readonly report: ReportPort;
  readonly timers: TimerPort;
  readonly timing?: RefreshTiming | undefined;
  readonly after?: SessionCounters | undefined;
}

export interface SharedDocumentSession extends CommonDocumentSession {
  revision: () => number;
  readAt: <T>(select: (doc: DocumentView | null, revision: number) => T) => T;
  beforeCommand: (listener: () => boolean) => () => void;
  subscribeRows: (listener: ChangedRowsListener) => () => void;
  recovery: () => readonly SharedRecoveryEntry[];
}

export type ChangedRowsListener = (rows: SharedProjectionChanges, change: SessionChange) => void;

export const WHOLE_PROJECTION: SharedProjectionChanges = Object.freeze({
  whole: true,
  added: Object.freeze([]),
  removed: Object.freeze([]),
  moved: Object.freeze([]),
  changed: Object.freeze([]),
  fields: Object.freeze([])
});

export const NOT_SHARED = "not shared";

export const REENTERED = "reentered";

interface ProjectionStep {
  readonly document: ValidatedDocument;
  readonly changes: ChangeSet;
  readonly rows: SharedProjectionChanges;
  readonly recovery: readonly SharedRecoveryEntry[];
}

interface Landed {
  readonly change: SessionChange;
  readonly errors: readonly unknown[];
}

interface Running {
  readonly plan: Plan;
  landed: Landed | null;
  lost: { readonly error: unknown } | null;
}

export const ORIGIN_KINDS: Readonly<Record<ReplicaOrigin, TransactionKind>> = Object.freeze({
  "hydration": "adopt",
  "local-command": "edit",
  "local-undo": "replay",
  "remote": "remote",
  "cleanup": "remote"
});

function known(origin: unknown): origin is ReplicaOrigin {
  return typeof origin === "string" && Object.hasOwn(ORIGIN_KINDS, origin);
}

export const UNRECOGNISED_ORIGIN = "A shared transaction had an origin the session does not recognise";

export function createSharedSession(ports: SharedSessionPorts): SharedDocumentSession {
  const scheduler = createEffectScheduler(ports.effects, ports.timers, ports.timing);
  const listeners: SessionListener[] = [];
  const admissions: (() => boolean)[] = [];
  const rowListeners: ChangedRowsListener[] = [];
  let admitting = false;
  let missed = false;
  let document: ValidatedDocument | null = null;
  let recovery: readonly SharedRecoveryEntry[] = [];
  let revision = 0;
  let epoch = ports.after ? ports.after.epoch : 0;
  let generation = ports.after ? ports.after.generation : 0;
  let disposed = false;
  let delivering = false;
  let running: Running | null = null;
  let entered = false;

  // why: The change set compares held documents, since the entry port decides what is held; the replica's
  // report names rows by the projection's own ids and covers one publication, so a missed one makes it whole.
  function projectionStep(previous: ValidatedDocument | null): ProjectionStep {
    const next = ports.entry(ports.replica.project());
    const rows = previous && !missed ? ports.replica.changes() : WHOLE_PROJECTION;
    return { document: next, changes: previous ? changesBetween(previous, next) : WHOLE_DOCUMENT, rows: rows, recovery: ports.replica.recovery() };
  }

  function deliver(kind: TransactionKind, changes: ChangeSet, rows: SharedProjectionChanges, mine: Running | null, failure: ReplicaFailure | undefined): Landed {
    const errors: unknown[] = failure ? [failure.error] : [];
    const told = listeners.slice(), toldRows = rowListeners.slice();
    const change: SessionChange = Object.freeze({ kind: kind, epoch: epoch, generation: generation, changes: changes });
    // why: assumed rule 29 on #1414: undoing a recovery entry would throw the kept typing away.
    const recorded = mine?.plan.shared?.undo !== false;
    if (kind === "edit") attempt(errors, function () { if (recorded) ports.undo.record(changes, mine?.plan.selection); });
    if (kind === "edit" || kind === "replay") scheduler.pass(change).forEach(function (error) { errors.push(error); });
    told.forEach(function (listener) {
      attempt(errors, function () { listener(change); });
    });
    toldRows.forEach(function (listener) {
      attempt(errors, function () { listener(rows, change); });
    });
    errors.forEach(function (error) { ports.report(error); });
    return { change: change, errors: errors };
  }

  function receive(origin: ReplicaOrigin | null, failure?: ReplicaFailure): void {
    if (disposed) return;
    // why: A failed publication is retried at once below; its rows are reported whole rather than trusting the retry.
    if (failure) missed = true;
    const at = ports.replica.revision();
    if (at === revision) {
      if (failure) ports.report(failure.error);
      return;
    }
    const mine = origin === "local-command" && running && !running.landed && !running.lost ? running : null;
    let step: ProjectionStep;
    try {
      step = projectionStep(document);
    } catch (error) {
      if (mine) mine.lost = { error: error };
      missed = true;
      if (failure) ports.report(failure.error);
      ports.report(error);
      return;
    }
    missed = false;
    // why: An unrecognised origin still changed the document; remote is the kind that records and saves nothing.
    const kind = document === null ? "adopt" : known(origin) ? ORIGIN_KINDS[origin] : "remote";
    if (!known(origin)) ports.report(new Error(UNRECOGNISED_ORIGIN + ": " + String(origin)));
    document = step.document;
    recovery = step.recovery;
    revision = at;
    if (kind === "adopt") epoch++;
    if (kind === "edit" || kind === "replay") generation++;
    const declared = mine && kind === "edit" ? mine.plan.changes : null;
    const changes = kind === "adopt" ? WHOLE_DOCUMENT
      : declared ? changeSet({ ...step.changes, derive: declared.derive, saveNow: declared.saveNow }) : step.changes;
    const outer = delivering;
    delivering = true;
    try {
      const landed = deliver(kind, changes, kind === "adopt" ? WHOLE_PROJECTION : step.rows, mine, failure);
      if (mine) mine.landed = landed;
    } finally {
      delivering = outer;
    }
  }

  function execute(plan: Plan, operations: readonly SharedOperation[], base: number): CommandOutcome {
    const mine: Running = { plan: plan, landed: null, lost: null };
    running = mine;
    try {
      const result = ports.replica.execute(operations, { base: base });
      if (!result.ok) return { kind: "rejected", reason: result.reason };
    } catch (error) {
      if (!mine.landed) return { kind: "failed", error: error };
      ports.report(error);
      const done = mine.landed.change;
      return { kind: "committed", generation: done.generation, changes: done.changes, errors: mine.landed.errors.concat([error]) };
    } finally {
      running = null;
    }
    if (mine.lost) return { kind: "failed", error: mine.lost.error };
    if (!mine.landed) return { kind: "noop" };
    const done = mine.landed.change;
    if (mine.landed.errors.length) return { kind: "committed", generation: done.generation, changes: done.changes, errors: mine.landed.errors.slice() };
    return { kind: "applied", generation: done.generation, changes: done.changes };
  }

  function run(command: Command): CommandOutcome {
    if (disposed) return { kind: "rejected", reason: DISPOSED };
    if (entered || delivering) return { kind: "rejected", reason: REENTERED };
    if (!admitting) {
      admitting = true;
      try {
        for (const listener of admissions.slice()) if (!listener()) return { kind: "rejected", reason: "buffer-pending" };
      } catch (error) { return { kind: "failed", error }; }
      finally { admitting = false; }
      if (disposed) return { kind: "rejected", reason: DISPOSED };
    }
    entered = true;
    try {
      return decide(command);
    } finally {
      entered = false;
    }
  }

  function decide(command: Command): CommandOutcome {
    const doc = document;
    if (!doc) return { kind: "rejected", reason: NO_DOCUMENT };
    if (command.needs === "edit") {
      const can = ports.capability.edit();
      if (!can.allowed) return { kind: "rejected", reason: can.reason };
    }
    const planned = revision;
    let plan: Plan | CommandRefusal | null;
    try {
      plan = command.plan(doc, ports.capability);
    } catch (error) {
      return { kind: "failed", error: error };
    }
    if (!plan) return { kind: "noop" };
    if ("refused" in plan) return { kind: "rejected", reason: plan.refused };
    if (!plan.shared) return { kind: "rejected", reason: NOT_SHARED };
    if (!plan.shared.operations.length) return { kind: "noop" };
    return execute(plan, plan.shared.operations, plan.shared.base ?? planned);
  }

  const stop = ports.replica.observe(receive);
  if (ports.replica.revision() !== 0) receive("hydration");

  return {
    epoch: function () { return epoch; },
    generation: function () { return generation; },
    revision: function () { return revision; },
    read: function (select) { return select(document); },
    readAt: function (select) { return select(document, revision); },
    recovery: function () { return recovery; },
    run: run,
    beforeCommand: listener => {
      if (disposed) return () => {};
      admissions.push(listener);
      return () => { const at = admissions.indexOf(listener); if (at !== -1) admissions.splice(at, 1); };
    },
    refresh: function (job) { scheduler.refresh(job); },
    cancelRefresh: function (jobs) { scheduler.cancelRefresh(jobs); },
    subscribe: function (listener) {
      if (disposed) return function () {};
      listeners.push(listener);
      return function () {
        const at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      };
    },
    subscribeRows: function (listener) {
      if (disposed) return function () {};
      rowListeners.push(listener);
      return function () {
        const at = rowListeners.indexOf(listener);
        if (at !== -1) rowListeners.splice(at, 1);
      };
    },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      stop();
      scheduler.dispose();
      listeners.length = 0;
      rowListeners.length = 0;
      admissions.length = 0;
      document = null;
      recovery = [];
    }
  };
}
