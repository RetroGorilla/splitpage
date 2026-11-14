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
import { adoptReplacement, adoptShared, currentDocument, holdMergeBase, sharedSession } from "./session-owner.ts";
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
export const SHARED_HYDRATION_FAILED = "hydration-failed";

interface Running {
  readonly parts: SharedSessionParts;
  readonly replica: SharedReplica;
  readonly kept: Record<string, unknown>;
  readonly end: () => void;
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

function leaveTo(ports: SharedSwitchPorts, raw: Record<string, unknown>): void {
  const now = running;
  if (!now) return;
  running = null;
  // why: a Writer left on the shared ports would plan against committed ids the standalone document lacks
  ports.bindings.leave();
  now.end();
  try {
    adoptReplacement(ports.migrate(raw), ports.standalone);
  } finally {
    now.replica.dispose();
    destroySharedDocument(now.parts.handle);
  }
}

function build(ports: SharedSwitchPorts, handle: SharedDocumentHandle, author: SharedAuthorPort): { readonly replica: SharedReplica; readonly parts: SharedSessionParts } {
  registerSharedOperationFamilies(handle, ports.structure);
  const undo = sharedUndoOwner(handle, () => author.next(), ports.now);
  const replica = createSharedReplica(handle, undefined, undo);
  const made: { session: SharedDocumentSession | null } = { session: null };
  try {
    adoptShared(owner => {
      made.session = createSharedSession({
        replica: replica, entry: owner.entry, undo: { record: () => {} },
        effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: owner.refresh },
        capability: owner.capability, report: ports.report, timers: ports.timers, after: owner.after
      });
      return made.session;
    }, createSessionCapabilities("shared", ports.common));
  } catch (error) {
    replica.dispose();
    throw error;
  }
  if (!made.session) throw new Error("The shared session was not built");
  return { replica, parts: { handle, session: made.session, undo, author } };
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
  const kept = copyOf(current);
  const handle = createSharedDocument();
  let live = true;
  const author = sharedAuthorPort({ handle: () => live ? handle : null, name: ports.editor });
  let made: { readonly replica: SharedReplica; readonly parts: SharedSessionParts };
  try {
    made = build(ports, handle, author);
  } catch (error) {
    live = false;
    destroySharedDocument(handle);
    throw error;
  }
  const stopRoute = routeSharedUndo({ actions: sharedUndoActions(made.parts.session, made.parts.undo), breakGroup: made.parts.undo.breakGroup });
  running = { parts: made.parts, replica: made.replica, kept, end: () => { live = false; stopRoute(); } };
  ports.detach();
  undoOwner().adopt(null);
  holdMergeBase(null);
  ports.bindings.enter(made.parts);
  try {
    hydrateSharedDocument(handle, ports.migrate({ ...kept, docId: ports.docId() }));
  } catch (error) {
    ports.report(error);
    leaveTo(ports, kept);
    return { ok: false, reason: SHARED_HYDRATION_FAILED };
  }
  return { ok: true };
}

export function leaveSharedSession(ports: SharedSwitchPorts): SharedSwitchOutcome {
  const now = running;
  if (!now) return { ok: false, reason: SHARED_NOT_RUNNING };
  const holding = ports.bindings.settle();
  if (holding) return { ok: false, reason: holding };
  const current = currentDocument();
  leaveTo(ports, { ...(current ? copyOf(current) : now.kept), docId: ports.docId() });
  return { ok: true };
}
