import type { SharedOperation } from "../../core/collab/operations.ts";
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

export type ReplicaExecution = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface ReplicaPort {
  readonly revision: () => number;
  readonly project: () => unknown;
  readonly execute: (operations: readonly SharedOperation[], options: { readonly base: number }) => ReplicaExecution;
  readonly observe: (listener: (origin: ReplicaOrigin | null) => void) => () => void;
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
}

export const NOT_SHARED = "not shared";

export const REENTERED = "reentered";

interface ProjectionStep {
  readonly document: ValidatedDocument;
  readonly changes: ChangeSet;
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
  let document: ValidatedDocument | null = null;
  let revision = 0;
  let epoch = ports.after ? ports.after.epoch : 0;
  let generation = ports.after ? ports.after.generation : 0;
  let disposed = false;
  let delivering = false;
  let running: Running | null = null;
  let entered = false;

  // why: The whole document is projected and compared per transaction until the incremental projector replaces this step.
  function projectionStep(previous: ValidatedDocument | null): ProjectionStep {
    const next = ports.entry(ports.replica.project());
    return { document: next, changes: previous ? changesBetween(previous, next) : WHOLE_DOCUMENT };
  }

  function deliver(kind: TransactionKind, changes: ChangeSet, mine: Running | null): Landed {
    const errors: unknown[] = [];
    const change: SessionChange = Object.freeze({ kind: kind, epoch: epoch, generation: generation, changes: changes });
    if (kind === "edit") attempt(errors, function () { ports.undo.record(changes, mine?.plan.selection); });
    if (kind === "edit" || kind === "replay") scheduler.pass(change).forEach(function (error) { errors.push(error); });
    listeners.slice().forEach(function (listener) {
      attempt(errors, function () { listener(change); });
    });
    errors.forEach(function (error) { ports.report(error); });
    return { change: change, errors: errors };
  }

  function receive(origin: ReplicaOrigin | null): void {
    if (disposed) return;
    const at = ports.replica.revision();
    if (at === revision) return;
    const mine = origin === "local-command" && running && !running.landed && !running.lost ? running : null;
    let step: ProjectionStep;
    try {
      step = projectionStep(document);
    } catch (error) {
      if (mine) mine.lost = { error: error };
      ports.report(error);
      return;
    }
    // why: An unrecognised origin still changed the document; remote is the kind that records and saves nothing.
    const kind = document === null ? "adopt" : known(origin) ? ORIGIN_KINDS[origin] : "remote";
    if (!known(origin)) ports.report(new Error(UNRECOGNISED_ORIGIN + ": " + String(origin)));
    document = step.document;
    revision = at;
    if (kind === "adopt") epoch++;
    if (kind === "edit" || kind === "replay") generation++;
    const declared = mine && kind === "edit" ? mine.plan.changes : null;
    const changes = kind === "adopt" ? WHOLE_DOCUMENT
      : declared ? changeSet({ ...step.changes, derive: declared.derive, saveNow: declared.saveNow }) : step.changes;
    const outer = delivering;
    delivering = true;
    try {
      const landed = deliver(kind, changes, mine);
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
    run: run,
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
    dispose: function () {
      if (disposed) return;
      disposed = true;
      stop();
      scheduler.dispose();
      listeners.length = 0;
      document = null;
    }
  };
}
