import { createSharedDocument, destroySharedDocument } from "../../adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../adapters/collab/hydrate.ts";
import { registerSharedOperationFamilies } from "../../adapters/collab/operation-families.ts";
import { createSharedReplica } from "../../adapters/collab/replica.ts";
import type { SharedReplica } from "../../adapters/collab/replica.ts";
import type { SharedStructureContentPorts } from "../../adapters/collab/structure-content.ts";
import type { SharedDocumentHandle } from "../../adapters/collab/types.ts";
import type { SharedUndo } from "../../application/editing/undo/shared-undo.ts";
import { sharedUndoActions } from "../../application/editing/undo/shared-undo-actions.ts";
import { createSessionCapabilities } from "../../application/session/capabilities.ts";
import type { CapabilityPort, ReportPort, TimerPort } from "../../application/session/ports.ts";
import { createSharedSession } from "../../application/session/shared-session.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { adoptShared, collectReplacementErrors, currentDocument, holdMergeBase, holdSessionCommands, landStandalone, mergeBase, sharedSession } from "./session-owner.ts";
import type { OwnerSwap } from "./session-owner.ts";
import { routeSharedUndo, undoOwner } from "./undo.ts";
import { sharedAuthorPort } from "./ports/shared-author.ts";
import type { SharedAuthorPort } from "./ports/shared-author.ts";
import { sharedUndoOwner } from "./ports/shared-undo.ts";

export interface SharedSessionParts {
  readonly handle: SharedDocumentHandle;
  readonly session: SharedDocumentSession;
  readonly undo: SharedUndo;
  readonly author: SharedAuthorPort;
}

export interface SharedBindings {
  readonly enter: (parts: SharedSessionParts) => void;
  readonly settle: () => string | null;
  readonly leave: () => void;
}

export interface SharedSwitchPorts {
  readonly refusal: () => string | null;
  readonly settle: () => void;
  readonly detach: () => void;
  readonly bindings: SharedBindings;
  readonly common: Pick<CapabilityPort, "edit" | "comment">;
  readonly standalone: CapabilityPort;
  readonly migrate: (raw: unknown) => ValidatedDocument;
  readonly docId: () => string;
  readonly editor: () => string;
  readonly structure: SharedStructureContentPorts;
  readonly report: ReportPort;
  readonly timers: TimerPort;
  readonly now: () => number;
}

export type SharedSwitchOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const SHARED_ALREADY = "already-shared";
export const SHARED_NOT_RUNNING = "not-shared";
export const SHARED_NO_DOCUMENT = "no-document";
export const SHARED_ENTER_FAILED = "enter-failed";
export const SHARED_LEAVE_FAILED = "leave-failed";
export const SHARED_SWITCHING = "session-switching";

interface Running {
  readonly parts: SharedSessionParts;
  readonly replica: SharedReplica;
  readonly kept: Record<string, unknown>;
  readonly live: (on: boolean) => void;
  readonly stopRoute: () => void;
}

let running: Running | null = null;

export function sharedSessionParts(): SharedSessionParts | null {
  return running ? running.parts : null;
}

function copyOf(doc: ValidatedDocument): Record<string, unknown> {
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

// why: the fault model of plan section 4: one guarded step never stops the rest, and the first error is reported first
class Faults {
  readonly errors: unknown[] = [];
  attempt(step: () => void): boolean {
    try { step(); return true; } catch (error) { this.errors.push(error); return false; }
  }
  report(ports: SharedSwitchPorts): void {
    for (const error of this.errors) { try { ports.report(error); } catch { break; } }
  }
}

// why: a destroy listener that throws stops Yjs before it drops its observers; a second attempt finishes the job
function destroy(faults: Faults, handle: SharedDocumentHandle): void {
  if (!faults.attempt(() => { destroySharedDocument(handle); })) faults.attempt(() => { destroySharedDocument(handle); });
}

function refusedNow(ports: SharedSwitchPorts, faults: Faults): string | null {
  if (running || sharedSession()) return SHARED_ALREADY;
  let reason: string | null = null;
  return faults.attempt(() => { reason = ports.refusal(); }) ? reason : SHARED_ENTER_FAILED;
}

function failed(ports: SharedSwitchPorts, faults: Faults, reason: string): SharedSwitchOutcome {
  faults.report(ports);
  return { ok: false, reason };
}

export async function enterSharedSession(ports: SharedSwitchPorts): Promise<SharedSwitchOutcome> {
  const faults = new Faults();
  const first = refusedNow(ports, faults);
  if (first) return failed(ports, faults, first);
  if (!faults.attempt(() => { ports.settle(); })) return failed(ports, faults, SHARED_ENTER_FAILED);
  // why: a noteEdit() without a selection flushes on a microtask (undo.ts:162), which must run before the owner swap
  await Promise.resolve();
  const second = refusedNow(ports, faults);
  if (second) return failed(ports, faults, second);
  const current = currentDocument();
  if (!current) return { ok: false, reason: SHARED_NO_DOCUMENT };
  // why: nothing may be accepted between the capture of the kept copy and the landing of one session or the other
  const releaseCommands = holdSessionCommands(SHARED_SWITCHING);
  const prepared: { kept: Record<string, unknown> | null; hydration: ValidatedDocument | null; handle: SharedDocumentHandle | null } = { kept: null, hydration: null, handle: null };
  if (!faults.attempt(() => {
    const kept = copyOf(current);
    prepared.kept = kept;
    prepared.hydration = ports.migrate({ ...kept, docId: ports.docId() });
    prepared.handle = createSharedDocument();
  }) || !prepared.kept || !prepared.hydration || !prepared.handle) {
    releaseCommands();
    return failed(ports, faults, SHARED_ENTER_FAILED);
  }
  return enter(ports, faults, { kept: prepared.kept, hydration: prepared.hydration, handle: prepared.handle, releaseCommands });
}

function enter(ports: SharedSwitchPorts, faults: Faults, prepared: { readonly kept: Record<string, unknown>; readonly hydration: ValidatedDocument;
  readonly handle: SharedDocumentHandle; readonly releaseCommands: () => void }): SharedSwitchOutcome {
  const { kept, hydration, handle, releaseCommands } = prepared, base = mergeBase();
  let on = true;
  const author = sharedAuthorPort({ handle: () => on ? handle : null, name: ports.editor });
  const made: { session: SharedDocumentSession | null; replica: SharedReplica | null; swap: OwnerSwap | null; stopRoute: (() => void) | null;
    releaseSession: (() => void) | null; bound: boolean } = { session: null, replica: null, swap: null, stopRoute: null, releaseSession: null, bound: false };
  try {
    registerSharedOperationFamilies(handle, ports.structure);
    const undo = sharedUndoOwner(handle, () => author.next(), ports.now, ports.report);
    const replica = createSharedReplica(handle, undefined, undo);
    made.replica = replica;
    const admission = { admit: () => made.session ? made.session.admit() : { kind: "rejected" as const, reason: SHARED_SWITCHING } };
    // why: replacement listeners may already see the shared owner, so Ctrl+Z must reach its undo owner first
    made.stopRoute = routeSharedUndo({ actions: sharedUndoActions(admission, undo), breakGroup: undo.breakGroup });
    made.swap = collectReplacementErrors(faults.errors, () => adoptShared(owner => {
      const session = createSharedSession({
        replica: replica, entry: owner.entry, undo: { record: () => {} },
        effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: owner.refresh },
        capability: owner.capability, report: ports.report, timers: ports.timers, after: owner.after
      });
      made.session = session;
      made.releaseSession = session.hold(SHARED_SWITCHING);
      return session;
    }, createSessionCapabilities("shared", ports.common)));
    if (!made.session) throw new Error("The shared session was not built");
    const parts: SharedSessionParts = { handle, session: made.session, undo, author };
    running = { parts, replica, kept, live: value => { on = value; }, stopRoute: made.stopRoute };
    undoOwner().adopt(null);
    holdMergeBase(null);
    made.bound = true;
    ports.bindings.enter(parts);
    hydrateSharedDocument(handle, hydration);
    // why: detaching is the one step with no way back, so it runs once everything else has landed
    ports.detach();
  } catch (error) {
    faults.errors.unshift(error);
    running = null;
    // why: the kept standalone owner comes back first, with no migration, and only then do the shared parts go
    if (made.bound) faults.attempt(() => { ports.bindings.leave(); });
    on = false;
    if (made.swap) { const swap = made.swap; faults.attempt(() => { collectReplacementErrors(faults.errors, swap.restore); }); }
    faults.attempt(() => { undoOwner().track(); });
    if (made.stopRoute) faults.attempt(made.stopRoute);
    faults.attempt(() => { holdMergeBase(base); });
    if (made.replica) { const replica = made.replica; faults.attempt(() => { replica.dispose(); }); }
    destroy(faults, handle);
    releaseCommands();
    return failed(ports, faults, SHARED_ENTER_FAILED);
  }
  const swap = made.swap;
  faults.attempt(() => { swap.commit(); });
  made.releaseSession?.();
  releaseCommands();
  faults.report(ports);
  return { ok: true };
}

function sameDocument(landed: ValidatedDocument): boolean {
  const current = currentDocument();
  return current !== null && JSON.stringify(current) === JSON.stringify(landed);
}

export function leaveSharedSession(ports: SharedSwitchPorts): SharedSwitchOutcome {
  const now = running;
  if (!now) return { ok: false, reason: SHARED_NOT_RUNNING };
  const faults = new Faults();
  let holding: string | null = null;
  if (!faults.attempt(() => { holding = ports.bindings.settle(); })) return failed(ports, faults, SHARED_LEAVE_FAILED);
  if (holding) return { ok: false, reason: holding };
  const holds: { session: (() => void) | null; commands: (() => void) | null } = { session: null, commands: null };
  const keep = (error: unknown): SharedSwitchOutcome => {
    faults.errors.unshift(error);
    now.live(true);
    faults.attempt(() => { ports.bindings.enter(now.parts); });
    holds.session?.();
    holds.commands?.();
    return failed(ports, faults, SHARED_LEAVE_FAILED);
  };
  try { ports.bindings.leave(); } catch (error) { return keep(error); }
  // why: the restart may still settle typing into the session; from here to the landing nothing more is accepted
  holds.session = now.parts.session.hold(SHARED_SWITCHING);
  holds.commands = holdSessionCommands(SHARED_SWITCHING);
  let landed: ValidatedDocument;
  try {
    // why: the copy is taken after the bindings settled on restart, and admission stays closed until it has landed
    const current = currentDocument();
    landed = ports.migrate({ ...(current ? copyOf(current) : now.kept), docId: ports.docId() });
  } catch (error) { return keep(error); }
  now.live(false);
  let swap: OwnerSwap;
  try {
    swap = collectReplacementErrors(faults.errors, () => landStandalone(landed, ports.standalone));
  } catch (error) { return keep(error); }
  let same = false;
  faults.attempt(() => { same = sameDocument(landed); });
  if (!same) {
    faults.attempt(() => { collectReplacementErrors(faults.errors, swap.restore); });
    return keep(new Error("The standalone copy did not land as captured"));
  }
  running = null;
  faults.attempt(() => { swap.commit(); });
  faults.attempt(now.stopRoute);
  faults.attempt(() => { now.replica.dispose(); });
  destroy(faults, now.parts.handle);
  holds.commands();
  faults.report(ports);
  return { ok: true };
}
