import { createSharedDocument, destroySharedDocument } from "../../adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../adapters/collab/hydrate.ts";
import { registerSharedOperationFamilies } from "../../adapters/collab/operation-families.ts";
import { createSharedReplica } from "../../adapters/collab/replica.ts";
import type { SharedStructureContentPorts } from "../../adapters/collab/structure-content.ts";
import type { SharedDocumentHandle } from "../../adapters/collab/types.ts";
import type { SharedUndo } from "../../application/editing/undo/shared-undo.ts";
import type { CommandOutcome, DocumentStructureIntent } from "../../application/session/document-session.ts";
import { sharedUndoActions } from "../../application/editing/undo/shared-undo-actions.ts";
import { createSessionCapabilities } from "../../application/session/capabilities.ts";
import type { CapabilityPort, ReportPort, TimerPort } from "../../application/session/ports.ts";
import { createSharedSession } from "../../application/session/shared-session.ts";
import type { DocumentOpeningActivity } from "../../application/transitions/ports.ts";
import type { ReplicaPort, SharedDocumentSession, SharedSessionPorts } from "../../application/session/shared-session.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { adoptReplacement, adoptShared, collectReplacementErrors, currentDocument, holdMergeBase, holdSessionCommands, landStandalone, mergeBase, sessionEntryRefusal, sharedSession } from "./session-owner.ts";
import type { OwnerSwap } from "./session-owner.ts";
import type { SharedUndoRoute } from "./undo.ts";
import { routeSharedUndo, undoOwner } from "./undo.ts";
import { sharedAuthorPort } from "./ports/shared-author.ts";
import type { SharedAuthorPort } from "./ports/shared-author.ts";
import { sharedUndoOwner } from "./ports/shared-undo.ts";
import type { NativeEditorRecords } from "./native-shared-records.ts";
import type { FindNativeAccess } from "../../features/find/ports.ts";

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
  readonly abandon?: () => void;
  readonly drop?: () => void;
}

export interface SharedSwitchPorts {
  readonly refusal: () => string | null;
  readonly commandRefused: SharedSessionPorts["refused"];
  readonly settle: () => void;
  readonly prepare?: () => Promise<string | null>;
  readonly detach: () => void;
  readonly reattach?: () => void;
  readonly left?: (landed: boolean) => void;
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
  readonly opening: Pick<DocumentOpeningActivity, "openingPending">;
  readonly hydrate?: (handle: SharedDocumentHandle, migrated: ValidatedDocument) => void;
}

export function joinSharedBindings(first: SharedBindings, second: Pick<SharedBindings, "enter" | "leave">): SharedBindings {
  return {
    enter: parts => { first.enter(parts); second.enter(parts); },
    settle: () => first.settle(),
    leave: () => { try { second.leave(); } finally { first.leave(); } },
    abandon: () => { first.abandon?.(); },
    drop: () => { first.drop?.(); }
  };
}

export type SharedSwitchOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const SHARED_ALREADY = "already-shared";
export const SHARED_NOT_RUNNING = "not-shared";
export const SHARED_NO_DOCUMENT = "no-document";
export const SHARED_ENTER_FAILED = "enter-failed";
export const SHARED_LEAVE_FAILED = "leave-failed";
export const SHARED_SWITCHING = "session-switching";

interface Running {
  readonly ports: SharedSwitchPorts;
  readonly session: SharedDocumentSession;
  readonly backend: SharedEditorBackend;
  readonly kept: Record<string, unknown>;
  readonly stopRoute: () => void;
  readonly end: () => void;
}

export interface SharedEditorBackend {
  readonly replica: ReplicaPort;
  readonly parts: SharedSessionParts | null;
  readonly undo: (admission: Pick<SharedDocumentSession, "admit">) => SharedUndoRoute;
  readonly bind: (session: SharedDocumentSession) => void;
  readonly unbind: () => void;
  readonly settle: () => string | null;
  readonly abandon?: () => void;
  readonly drop?: () => void;
  readonly start: () => void;
  readonly failedEntry?: () => ValidatedDocument | null;
  readonly stopIngress?: () => () => void;
  readonly landing: () => ValidatedDocument | null;
  readonly live: (on: boolean) => void;
  readonly dispose: (attempt: (step: () => void) => boolean) => void;
  readonly unsupportedCommands?: string;
  readonly nativeRecords?: NativeEditorRecords;
  readonly nativeFind?: FindNativeAccess;
  readonly hasWriterPreview?: (beat: string) => boolean;
  readonly bindWriterPaint?: (root: HTMLElement) => (() => void) | undefined;
  readonly structure?: (intent: DocumentStructureIntent) => CommandOutcome;
}

type OpenBackend = (hydration: ValidatedDocument, failedClose: () => boolean) => SharedEditorBackend;

let running: Running | null = null;

export function sharedSessionParts(): SharedSessionParts | null {
  return running?.backend.parts ?? null;
}

export function nativeEditorRecords() {
  return running?.backend.nativeRecords ?? null;
}

export function nativeEditorFind() {
  return running?.backend.nativeFind ?? null;
}

export function nativeEditorActive(): boolean {
  return !!running?.backend.stopIngress;
}

export function hasNativeWriterPreview(beat: string): boolean {
  return running?.backend.hasWriterPreview?.(beat) ?? false;
}

export function bindNativeWriterPaint(root: HTMLElement): (() => void) | undefined {
  return running?.backend.bindWriterPaint?.(root);
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
function destroy(attempt: (step: () => void) => boolean, handle: SharedDocumentHandle): void {
  if (!attempt(() => { destroySharedDocument(handle); })) attempt(() => { destroySharedDocument(handle); });
}

function refusedNow(ports: SharedSwitchPorts, faults: Faults): string | null {
  if (running || sharedSession()) return SHARED_ALREADY;
  let reason: string | null = null;
  return faults.attempt(() => { reason = ports.opening.openingPending() ? "opening-pending" : ports.refusal(); }) ? reason : SHARED_ENTER_FAILED;
}

function failed(ports: SharedSwitchPorts, faults: Faults, reason: string): SharedSwitchOutcome {
  faults.report(ports);
  return { ok: false, reason };
}

export async function enterSharedSession(ports: SharedSwitchPorts, open?: OpenBackend): Promise<SharedSwitchOutcome> {
  const holdReason = sessionEntryRefusal();
  if (holdReason) return { ok: false, reason: holdReason };
  const release = holdSessionCommands(SHARED_SWITCHING, "entries");
  try { return await enterAvailableSession(ports, release, open); } finally { release(); }
}

async function enterAvailableSession(ports: SharedSwitchPorts, releaseEntries: () => void, open?: OpenBackend): Promise<SharedSwitchOutcome> {
  const faults = new Faults();
  const first = refusedNow(ports, faults);
  if (first) return failed(ports, faults, first);
  if (!faults.attempt(() => { ports.settle(); })) return failed(ports, faults, SHARED_ENTER_FAILED);
  // why: a noteEdit() without a selection flushes on a microtask (undo.ts:162), which must run before the owner swap
  await Promise.resolve();
  if (ports.prepare) {
    let prepared: string | null;
    try { prepared = await ports.prepare(); } catch (error) { faults.errors.push(error); return failed(ports, faults, SHARED_ENTER_FAILED); }
    if (prepared) return failed(ports, faults, prepared);
  }
  const second = refusedNow(ports, faults);
  if (second) return failed(ports, faults, second);
  const current = currentDocument();
  if (!current) return { ok: false, reason: SHARED_NO_DOCUMENT };
  // why: nothing may be accepted between the capture of the kept copy and the landing of one session or the other
  const releaseCommands = holdSessionCommands(SHARED_SWITCHING);
  let kept: Record<string, unknown>, hydration: ValidatedDocument;
  try {
    kept = copyOf(current);
    hydration = ports.migrate({ ...kept, docId: ports.docId() });
  } catch (error) {
    faults.errors.push(error);
    releaseCommands();
    return failed(ports, faults, SHARED_ENTER_FAILED);
  }
  return enter(ports, faults, { kept, hydration, releaseCommands, releaseEntries }, open ?? (doc => openLegacyBackend(ports, doc, faults)));
}

function openLegacyBackend(ports: SharedSwitchPorts, hydration: ValidatedDocument, faults: Faults): SharedEditorBackend {
  const handle = createSharedDocument();
  let on = true, parts: SharedSessionParts | null = null;
  const author = sharedAuthorPort({ handle: () => on ? handle : null, name: ports.editor });
  try {
    registerSharedOperationFamilies(handle, ports.structure);
    const undo = sharedUndoOwner(handle, () => author.next(), ports.now, ports.report);
    const replica = createSharedReplica(handle, undefined, undo);
    return {
      replica,
      get parts() { return parts; },
      undo: admission => ({ actions: sharedUndoActions(admission, undo), breakGroup: undo.breakGroup, replayed: undo.replayed }),
      bind: session => { parts ??= { handle, session, undo, author }; ports.bindings.enter(parts); },
      unbind: () => ports.bindings.leave(),
      settle: () => ports.bindings.settle(),
      abandon: () => { ports.bindings.abandon?.(); },
      drop: () => { ports.bindings.drop?.(); },
      start: () => (ports.hydrate ?? hydrateSharedDocument)(handle, hydration),
      landing: currentDocument,
      live: value => { on = value; },
      dispose: attempt => {
        attempt(() => { replica.dispose(); });
        destroy(attempt, handle);
      }
    };
  } catch (error) {
    destroy(step => faults.attempt(step), handle);
    throw error;
  }
}

async function enter(ports: SharedSwitchPorts, faults: Faults, prepared: { readonly kept: Record<string, unknown>; readonly hydration: ValidatedDocument;
  readonly releaseCommands: () => void; readonly releaseEntries: () => void }, open: OpenBackend): Promise<SharedSwitchOutcome> {
  const { kept, hydration, releaseCommands } = prepared, base = mergeBase();
  let alive = true, backend: SharedEditorBackend, entering = true, failedDuringEntry = false;
  try {
    backend = open(hydration, () => {
      if (entering) { failedDuringEntry = true; return false; }
      if (running?.backend !== backend) return false;
      const result = leaveSharedSession(ports);
      if (!result.ok) ports.report(new Error(`The failed shared session could not land: ${result.reason}`));
      return true;
    });
  } catch (error) {
    faults.errors.unshift(error);
    releaseCommands();
    return failed(ports, faults, SHARED_ENTER_FAILED);
  }
  const made: { session: SharedDocumentSession | null; swap: OwnerSwap | null; stopRoute: (() => void) | null;
    releaseSession: (() => void) | null; bound: boolean; detaching: boolean } = { session: null, swap: null, stopRoute: null, releaseSession: null,
    bound: false, detaching: false };
  // why: an adoption microtask can interrupt a native transaction and queue another microtask with its terminal bytes
  const entrySettled = backend.failedEntry ? new Promise<void>(resolve => { setTimeout(resolve, 0); }) : null;
  try {
    const admission = { admit: () => made.session ? made.session.admit() : { kind: "rejected" as const, reason: SHARED_SWITCHING } };
    // why: replacement listeners may already see the shared owner, so Ctrl+Z must reach its undo owner first
    made.stopRoute = routeSharedUndo(backend.undo(admission));
    made.swap = collectReplacementErrors(faults.errors, () => adoptShared(owner => {
      const shared = createSharedSession({
        replica: backend.replica, entry: owner.entry, undo: { record: () => {} },
        effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: jobs => { if (alive) owner.refresh(jobs); } },
        capability: owner.capability, report: ports.report, timers: ports.timers, after: owner.after, refused: ports.commandRefused,
        ...(backend.unsupportedCommands ? { unsupportedCommands: backend.unsupportedCommands } : {})
      });
      const route = backend.structure;
      const session = route ? { ...shared,
        run: (command: Parameters<SharedDocumentSession["run"]>[0]) => command.structure ? route(command.structure) : shared.run(command)
      } : shared;
      made.session = session;
      made.releaseSession = session.hold(SHARED_SWITCHING);
      return session;
    }, createSessionCapabilities("shared", ports.common)));
    if (!made.session) throw new Error("The shared session was not built");
    running = { ports, session: made.session, backend, kept, stopRoute: made.stopRoute, end: () => { alive = false; } };
    holdMergeBase(null);
    made.bound = true;
    backend.bind(made.session);
    backend.start();
    // why: detaching runs once everything else has landed; a rollback that reaches it puts back what it changed
    made.detaching = true;
    ports.detach();
    if (entrySettled) {
      await entrySettled;
      if (failedDuringEntry) throw new Error("The native session closed during entry");
    }
    // why: the D34 reset belongs to a successful entry, so a failed one keeps the standalone history
    undoOwner().adopt(null);
  } catch (error) {
    if (entrySettled && !failedDuringEntry) await entrySettled;
    faults.errors.unshift(error);
    running = null;
    // why: a shared callback whose timer cannot be cancelled must still not act once the session is gone
    alive = false;
    // why: the kept standalone owner comes back first, with no migration, and only then do the shared parts go
    if (made.bound) faults.attempt(backend.unbind);
    backend.live(false);
    if (made.swap) { const swap = made.swap; faults.attempt(() => { collectReplacementErrors(faults.errors, swap.restore); }); }
    faults.attempt(() => { undoOwner().track(); });
    if (made.stopRoute) faults.attempt(made.stopRoute);
    faults.attempt(() => { holdMergeBase(base); });
    let recovered = false;
    if (failedDuringEntry) faults.attempt(() => {
      const snapshot = backend.failedEntry?.();
      if (!snapshot) return;
      const landed = ports.migrate({ ...copyOf(snapshot), docId: ports.docId() });
      collectReplacementErrors(faults.errors, () => adoptReplacement(landed, ports.standalone));
      recovered = true;
      ports.left?.(true);
    });
    if (!recovered && made.detaching && ports.reattach) faults.attempt(ports.reattach);
    backend.dispose(step => faults.attempt(step));
    releaseCommands();
    return failed(ports, faults, SHARED_ENTER_FAILED);
  }
  const swap = made.swap;
  faults.attempt(() => { swap.commit(); });
  made.releaseSession?.();
  releaseCommands();
  if (backend.failedEntry) prepared.releaseEntries();
  entering = false;
  faults.report(ports);
  return { ok: true };
}

function sameDocument(landed: ValidatedDocument): boolean {
  const current = currentDocument();
  return current !== null && JSON.stringify(current) === JSON.stringify(landed);
}

export function leaveRunningSharedSession(): SharedSwitchOutcome {
  return running ? leaveSharedSession(running.ports) : { ok: false, reason: SHARED_NOT_RUNNING };
}

export function leaveSharedSession(ports: SharedSwitchPorts): SharedSwitchOutcome {
  const holdReason = sessionEntryRefusal();
  if (holdReason) return { ok: false, reason: holdReason };
  const release = holdSessionCommands(SHARED_SWITCHING, "entries");
  try { return leaveAvailableSession(ports); } finally { release(); }
}

function leaveAvailableSession(ports: SharedSwitchPorts): SharedSwitchOutcome {
  const now = running;
  if (!now) return { ok: false, reason: SHARED_NOT_RUNNING };
  ports = now.ports;
  const faults = new Faults();
  let holding: string | null = null;
  if (!faults.attempt(() => { holding = now.backend.settle(); })) return failed(ports, faults, SHARED_LEAVE_FAILED);
  if (holding) return { ok: false, reason: holding };
  const holds: { session: (() => void) | null; commands: (() => void) | null } = { session: null, commands: null };
  let resumeIngress: (() => void) | undefined;
  const keep = (error: unknown): SharedSwitchOutcome => {
    faults.errors.unshift(error);
    now.backend.live(true);
    faults.attempt(() => { now.backend.bind(now.session); });
    resumeIngress?.();
    holds.session?.();
    holds.commands?.();
    return failed(ports, faults, SHARED_LEAVE_FAILED);
  };
  try { now.backend.unbind(); } catch (error) { return keep(error); }
  // why: the restart may still settle typing into the session; from here to the landing nothing more is accepted
  holds.session = now.session.hold(SHARED_SWITCHING);
  holds.commands = holdSessionCommands(SHARED_SWITCHING);
  let landed: ValidatedDocument;
  try {
    resumeIngress = now.backend.stopIngress?.();
    // why: the copy is taken after the bindings settled on restart, and admission stays closed until it has landed
    const current = now.backend.landing();
    landed = ports.migrate({ ...(current ? copyOf(current) : now.kept), docId: ports.docId() });
  } catch (error) { return keep(error); }
  now.backend.live(false);
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
  now.end();
  faults.attempt(() => { swap.commit(); });
  faults.attempt(now.stopRoute);
  now.backend.dispose(step => faults.attempt(step));
  holds.commands();
  const left = ports.left;
  if (left) faults.attempt(() => { left(true); });
  faults.report(ports);
  return { ok: true };
}

function dropRunning(now: Running, reason: string): void {
  const faults = new Faults(), ports = now.ports;
  faults.errors.push(new Error(`The shared session ended without landing a standalone copy: ${reason}`));
  running = null;
  now.end();
  now.backend.live(false);
  // why: a dropped session releases every surface first, so the bindings tear down whatever the surfaces held
  faults.attempt(() => { now.backend.drop?.(); });
  faults.attempt(now.backend.unbind);
  faults.attempt(now.stopRoute);
  now.backend.dispose(step => faults.attempt(step));
  const left = ports.left;
  if (left) faults.attempt(() => { left(false); });
  faults.report(ports);
}

export function forceLeaveSharedSession(): SharedSwitchOutcome {
  const now = running;
  if (!now) return { ok: false, reason: SHARED_NOT_RUNNING };
  const first = leaveSharedSession(now.ports);
  if (first.ok || running !== now) return first;
  const faults = new Faults();
  faults.attempt(() => { now.backend.abandon?.(); });
  faults.report(now.ports);
  const second = leaveSharedSession(now.ports);
  if (second.ok || running !== now) return second;
  dropRunning(now, second.reason);
  return second;
}
