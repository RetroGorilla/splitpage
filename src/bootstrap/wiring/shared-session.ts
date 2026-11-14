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
import { adoptReplacement, adoptShared, currentDocument, holdMergeBase, mergeBase, sharedSession } from "./session-owner.ts";
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

interface Running {
  readonly parts: SharedSessionParts;
  readonly replica: SharedReplica;
  readonly kept: Record<string, unknown>;
  readonly live: (on: boolean) => void;
  readonly stopRoute: () => void;
}

interface Entering {
  readonly handle: SharedDocumentHandle;
  readonly kept: Record<string, unknown>;
  readonly base: ValidatedDocument | null;
  readonly live: (on: boolean) => void;
  replica: SharedReplica | null;
  stopRoute: (() => void) | null;
  bound: boolean;
}

let running: Running | null = null;

export function sharedSessionParts(): SharedSessionParts | null {
  return running ? running.parts : null;
}

function refusedNow(ports: SharedSwitchPorts): string | null {
  return running || sharedSession() ? SHARED_ALREADY : ports.refusal();
}

function copyOf(doc: ValidatedDocument): Record<string, unknown> {
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

function attempt(errors: unknown[], step: () => void): void {
  try { step(); } catch (error) { errors.push(error); }
}

// why: one way back for every step of entering: the kept copy lands as standalone, then the shared parts go,
// the route last, mirroring the order they came in
function unwindEntry(ports: SharedSwitchPorts, entering: Entering, cause: unknown): SharedSwitchOutcome {
  const errors: unknown[] = [cause];
  running = null;
  if (entering.bound) attempt(errors, () => { ports.bindings.leave(); });
  entering.live(false);
  if (sharedSession()) attempt(errors, () => { adoptReplacement(ports.migrate(entering.kept), ports.standalone); });
  entering.stopRoute?.();
  attempt(errors, () => { holdMergeBase(entering.base); });
  entering.replica?.dispose();
  destroySharedDocument(entering.handle);
  errors.forEach(error => { ports.report(error); });
  return { ok: false, reason: SHARED_ENTER_FAILED };
}

export async function enterSharedSession(ports: SharedSwitchPorts): Promise<SharedSwitchOutcome> {
  const first = refusedNow(ports);
  if (first) return { ok: false, reason: first };
  ports.settle();
  // why: a noteEdit() without a selection flushes on a microtask (undo.ts:162), which must run before the owner swap
  await Promise.resolve();
  const second = refusedNow(ports);
  if (second) return { ok: false, reason: second };
  const current = currentDocument();
  if (!current) return { ok: false, reason: SHARED_NO_DOCUMENT };
  const handle = createSharedDocument();
  let on = true;
  const entering: Entering = { handle, kept: copyOf(current), base: mergeBase(), live: value => { on = value; }, replica: null, stopRoute: null, bound: false };
  const author = sharedAuthorPort({ handle: () => on ? handle : null, name: ports.editor });
  try {
    registerSharedOperationFamilies(handle, ports.structure);
    const undo = sharedUndoOwner(handle, () => author.next(), ports.now, ports.report);
    const replica = createSharedReplica(handle, undefined, undo);
    entering.replica = replica;
    const made: { session: SharedDocumentSession | null } = { session: null };
    const admission = { admit: () => made.session ? made.session.admit() : { kind: "rejected" as const, reason: SHARED_NOT_RUNNING } };
    // why: replacement listeners may already see the shared owner, so Ctrl+Z must reach its undo owner first
    entering.stopRoute = routeSharedUndo({ actions: sharedUndoActions(admission, undo), breakGroup: undo.breakGroup });
    adoptShared(owner => {
      made.session = createSharedSession({
        replica: replica, entry: owner.entry, undo: { record: () => {} },
        effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: owner.refresh },
        capability: owner.capability, report: ports.report, timers: ports.timers, after: owner.after
      });
      return made.session;
    }, createSessionCapabilities("shared", ports.common));
    if (!made.session) throw new Error("The shared session was not built");
    const parts: SharedSessionParts = { handle, session: made.session, undo, author };
    const stopRoute = entering.stopRoute;
    running = { parts, replica, kept: entering.kept, live: entering.live, stopRoute };
    undoOwner().adopt(null);
    holdMergeBase(null);
    entering.bound = true;
    ports.bindings.enter(parts);
    hydrateSharedDocument(handle, ports.migrate({ ...entering.kept, docId: ports.docId() }));
    // why: detaching is the one step with no way back, so it runs once everything else has landed
    ports.detach();
  } catch (error) {
    return unwindEntry(ports, entering, error);
  }
  return { ok: true };
}

function restoreBindings(ports: SharedSwitchPorts, now: Running, errors: unknown[]): SharedSwitchOutcome {
  attempt(errors, () => { ports.bindings.enter(now.parts); });
  errors.forEach(error => { ports.report(error); });
  return { ok: false, reason: SHARED_LEAVE_FAILED };
}

export function leaveSharedSession(ports: SharedSwitchPorts): SharedSwitchOutcome {
  const now = running;
  if (!now) return { ok: false, reason: SHARED_NOT_RUNNING };
  const holding = ports.bindings.settle();
  if (holding) return { ok: false, reason: holding };
  try { ports.bindings.leave(); } catch (error) { return restoreBindings(ports, now, [error]); }
  let landed: ValidatedDocument;
  try {
    // why: the copy is taken after the bindings settled on restart, and nothing runs between it and the landing
    const current = currentDocument();
    landed = ports.migrate({ ...(current ? copyOf(current) : now.kept), docId: ports.docId() });
  } catch (error) { return restoreBindings(ports, now, [error]); }
  now.live(false);
  try {
    adoptReplacement(landed, ports.standalone);
  } catch (error) {
    if (sharedSession()) {
      now.live(true);
      return restoreBindings(ports, now, [error]);
    }
    ports.report(error);
  }
  running = null;
  now.stopRoute();
  now.replica.dispose();
  destroySharedDocument(now.parts.handle);
  return { ok: true };
}
