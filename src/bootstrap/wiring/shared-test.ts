import { exposeTestHook } from "../../features/common/test-hooks.ts";
import { mintDocId } from "../../adapters/identity/ids.ts";
import { startupReady } from "../../application/startup-signal.ts";
import { migrateRows } from "../document-ports.ts";
import { fromHtml } from "../richtext.ts";
import { currentCapabilities } from "./session-owner.ts";
import { SHARED_ENTER_FAILED, enterSharedSession, joinSharedBindings, leaveSharedSession, sharedSessionParts } from "./shared-session.ts";
import { recoveryPanelBinding } from "./recovery-panel.ts";
import type { SharedSwitchOutcome, SharedSwitchPorts } from "./shared-session.ts";
import { sharedWriterBindings } from "./shared-writer.ts";
import { createSharedTestPeer } from "./shared-test-peer.ts";
import { sharedCommandRefusalNotice } from "./ports/shared-command-notices.ts";
import { notices } from "./ports/effects.ts";
import { documentReader } from "./ports/document.ts";
import { openingStatus } from "./ports/transitions.ts";
import { getEditorName } from "./preferences-owner.ts";
import { undoOwner } from "./undo.ts";
import { writerControls } from "./writer.ts";
import { draftResume, flushDraftNow, noteDraftChange } from "./recovery-owners.ts";
import { draftSource } from "./drafts.ts";
import { confirmSavedNow, noteSaveChange } from "./save-owners.ts";
import { documentLocation, setHome } from "./location-owner.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

const DRAFT_NOT_KEPT = "draft-not-kept";
const DRAFT_NOT_KEPT_NOTICE = "The shared session did not start: your recovery copy could not be saved.";
const APP_STOPPED = "app-stopped";

function sharedEntryRefusal(ready: boolean, composing: boolean): string | null {
  return (!ready ? "startup-pending" : null)
    ?? (composing ? "buffer-composition" : null)
    ?? (draftResume().restorePending() ? "draft-restore-pending" : null);
}

function draftDetachRefusal(): string | null {
  const reason = draftSource.detachRefusal();
  if (!reason) return null;
  notices.show(DRAFT_NOT_KEPT_NOTICE, "warn");
  return `draft-${reason}`;
}

async function keepDraftBeforeEntry(ports: SharedSwitchPorts, refusal: () => string | null): Promise<string | null> {
  try {
    const refused = refusal();
    if (refused) return refused;
    ports.settle();
  } catch (error) { ports.report(error); return SHARED_ENTER_FAILED; }
  await Promise.resolve();
  const flushed = await flushDraftNow();
  const refused = refusal();
  if (refused) return refused;
  if (flushed.ok) return draftDetachRefusal();
  notices.show(DRAFT_NOT_KEPT_NOTICE, "warn");
  return DRAFT_NOT_KEPT;
}

function startSharedTestHook(): () => void {
  let ports: SharedSwitchPorts | null = null, peer: ReturnType<typeof createSharedTestPeer> | null = null;
  let switching = false, composing = false, detached = false, live = true, detachRefused: string | null = null;
  let withdraw = (): void => {};
  const counts = { recovered: 0, missingBase: 0, ownershipScans: 0 };
  const report = (error: unknown): void => { console.error(error); };
  const composition = (event: Event): void => { composing = event.type === "compositionstart"; };
  document.addEventListener("compositionstart", composition, true);
  document.addEventListener("compositionend", composition, true);
  const bindings = joinSharedBindings(sharedWriterBindings({
    recovered: () => { counts.recovered++; notices.show("Your writing was kept in recovery.", "warn"); },
    missingBase: () => { counts.missingBase++; notices.show("This line changed. Try writing again.", "warn"); },
    ownershipScan: () => { counts.ownershipScans++; }, report
  }), recoveryPanelBinding);
  const resume = (): void => { if (detached) { detached = false; draftSource.resumeWriting(); } };
  const leaveNow = (from: SharedSwitchPorts): SharedSwitchOutcome => {
    const result = leaveSharedSession(from);
    if (result.ok) {
      peer?.dispose(); peer = null; ports = null;
      resume();
      // why: the landed copy has a new docId and was never saved, so it is unsaved (rules 75 and 76)
      noteSaveChange(); noteDraftChange();
    }
    return result;
  };
  const enter = async (): Promise<SharedSwitchOutcome> => {
    if (!live) return { ok: false, reason: APP_STOPPED };
    if (switching) return { ok: false, reason: "session-switching" };
    if (sharedSessionParts()) return { ok: false, reason: "already-shared" };
    switching = true;
    detachRefused = null;
    try {
      let ready = false;
      startupReady()?.then(() => { ready = true; }, report);
      await Promise.resolve();
      const standalone = currentCapabilities();
      const common = { edit: standalone.edit, comment: standalone.edit };
      const refusal = (): string | null => (!live ? APP_STOPPED : null) ?? sharedEntryRefusal(ready, composing);
      const entering: SharedSwitchPorts = {
        refusal: () => refusal() ?? draftDetachRefusal(),
        commandRefused: sharedCommandRefusalNotice(notices),
        settle: () => {
          if (writerControls()?.writerFlowControl()?.settle?.() === false) throw new Error("The Writer could not settle");
          undoOwner().flush();
        },
        detach: () => {
          const draft = draftSource.detachSource();
          if (!draft.ok) { detachRefused = draft.reason; throw new Error(`The draft writer did not detach: ${draft.reason}`); }
          detached = true;
          setHome("none"); documentLocation().markWrittenOut(false); confirmSavedNow();
        },
        bindings, common, standalone, migrate: migrateRows, docId: mintDocId, editor: getEditorName,
        structure: { cells: html => fromHtml(html) }, report,
        timers: { now: () => Date.now(), start: (run, ms) => setTimeout(run, ms), stop: timer => { clearTimeout(timer as ReturnType<typeof setTimeout>); } },
        now: () => Date.now(),
        opening: openingStatus
      };
      ports = entering;
      const kept = await keepDraftBeforeEntry(entering, refusal);
      if (kept) { ports = null; return { ok: false, reason: kept }; }
      const result = await enterSharedSession(entering);
      const parts = sharedSessionParts();
      if (result.ok && parts && live) { peer = createSharedTestPeer(parts, entering); return result; }
      if (result.ok && parts) leaveNow(entering);
      else { ports = null; resume(); }
      if (!live) return { ok: false, reason: APP_STOPPED };
      if (!result.ok && detachRefused) {
        const reason = detachRefused;
        detachRefused = null;
        notices.show(DRAFT_NOT_KEPT_NOTICE, "warn");
        return { ok: false, reason: `draft-${reason}` };
      }
      return result;
    } finally { switching = false; }
  };
  const leave = (): SharedSwitchOutcome => {
    if (switching) return { ok: false, reason: "session-switching" };
    if (!ports) return { ok: false, reason: "not-shared" };
    switching = true;
    try { return leaveNow(ports); } finally { switching = false; }
  };
  const hook = {
    enter, leave,
    peer: {
      type: (rowId: string, offset: number, text: string) => peer?.type(rowId, offset, text),
      remove: (rowId: string) => peer?.remove(rowId),
      hold: () => { peer?.hold(); },
      deliver: (order?: "forward" | "reverse" | "duplicate") => peer?.deliver(order),
      release: (order?: "forward" | "reverse" | "duplicate") => peer?.release(order),
      appliedUpdates: () => peer?.appliedUpdates() ?? []
    },
    read: () => ({ app: documentReader.read(doc => doc ? JSON.parse(JSON.stringify(doc)) as unknown : null), peer: peer?.read() ?? null }),
    counters: () => ({ ...counts, queued: peer?.queued() ?? 0 })
  };
  exposeTestHook("__sharedTest", () => hook, release => { withdraw = release; });
  return () => {
    live = false;
    try {
      if (ports && sharedSessionParts() && !switching) {
        const left = leaveNow(ports);
        if (!left.ok) throw new Error(`The shared session did not end before the app stopped: ${left.reason}`);
      }
    } finally {
      peer?.dispose(); peer = null; ports = null;
      document.removeEventListener("compositionstart", composition, true);
      document.removeEventListener("compositionend", composition, true);
      withdraw();
    }
  };
}

const startForTest = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS ? startSharedTestHook : null;
let stopHook: (() => void) | null = null;

export function mountSharedSessionFeature(): void {
  stopSharedSessionFeature();
  stopHook = startForTest?.() ?? null;
}

export function stopSharedSessionFeature(): void {
  const stop = stopHook;
  stopHook = null;
  stop?.();
}
