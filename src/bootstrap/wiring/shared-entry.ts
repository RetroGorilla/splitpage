import { mintDocId } from "../../adapters/identity/ids.ts";
import { startupReady } from "../../application/startup-signal.ts";
import { migrateRows } from "../document-ports.ts";
import { currentCapabilities, sharedSession } from "./session-owner.ts";
import { SHARED_ALREADY, SHARED_NOT_RUNNING, SHARED_SWITCHING, enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "./shared-session.ts";
import type { SharedSwitchOutcome, SharedSwitchPorts } from "./shared-session.ts";
import type { Home } from "../../application/location/document-location.ts";
import { sharedCommandRefusalNotice } from "./ports/shared-command-notices.ts";
import { notices } from "./ports/effects.ts";
import { openingStatus } from "./ports/transitions.ts";
import { getEditorName } from "./preferences-owner.ts";
import { undoOwner } from "./undo.ts";
import { writerControls } from "./writer.ts";
import { draftResume, flushDraftNow, noteDraftChange } from "./recovery-owners.ts";
import { draftSource } from "./drafts.ts";
import { confirmSavedNow, noteSaveChange, unsavedChanges } from "./save-owners.ts";
import { currentHome, documentLocation, setHome } from "./location-owner.ts";
import { enterRetainedSharedScript, leaveRetainedSharedScript, retainedSharedScriptActive } from "./retained-shared-script.ts";
import type { RetainedSharedScript } from "./retained-shared-script.ts";

const DRAFT_NOT_KEPT = "draft-not-kept";
const DRAFT_NOT_KEPT_NOTICE = "The shared session did not start: your recovery copy could not be saved.";
const APP_STOPPED = "app-stopped";
type CreatedEntry = { readonly owns: () => boolean; readonly release: () => void };
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

async function keepDraftBeforeEntry(refusal: () => string | null): Promise<string | null> {
  const flushed = await flushDraftNow();
  const refused = refusal();
  if (refused) return refused;
  if (flushed.ok) return draftDetachRefusal();
  notices.show(DRAFT_NOT_KEPT_NOTICE, "warn");
  return DRAFT_NOT_KEPT;
}

interface Detached {
  readonly home: Home;
  readonly writtenOut: boolean;
  readonly unsaved: boolean;
}

function runEvery(steps: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const step of steps) { try { step(); } catch (error) { errors.push(error); } }
  if (errors.length) throw errors[0];
}

function reattachDraft(kept: Detached): void {
  runEvery([() => { documentLocation().restoreHome(kept.home); }, () => { documentLocation().markWrittenOut(kept.writtenOut); },
    () => { if (kept.unsaved && !unsavedChanges()) noteSaveChange(); }, () => { draftSource.resumeWriting(); }]);
}

function startSharedEntry(onLeft: () => void) {
  let detached: Detached | null = null;
  let switching = false, composing = false, live = true, detachRefused: string | null = null;
  const report = (error: unknown): void => { console.error(error); };
  const composition = (event: Event): void => { composing = event.type === "compositionstart"; };
  document.addEventListener("compositionstart", composition, true);
  document.addEventListener("compositionend", composition, true);
  const left = (landed: boolean): void => {
    const kept = detached;
    detached = null;
    // why: the landed copy has a new docId and was never saved, so it is unsaved (rules 75 and 76)
    const marks = landed && kept ? [() => { noteSaveChange(); }, () => { noteDraftChange(); }] : [];
    runEvery([onLeft, ...(kept ? [() => { draftSource.resumeWriting(); }] : []), ...marks]);
  };
  const enter = async (retained: RetainedSharedScript | undefined, signal?: AbortSignal,
    handoff?: CreatedEntry, open?: (ports: SharedSwitchPorts) => Parameters<typeof enterSharedSession>[1]): Promise<SharedSwitchOutcome> => {
    if (!live) return { ok: false, reason: APP_STOPPED };
    if (switching) return { ok: false, reason: SHARED_SWITCHING };
    if (sharedSession()) return { ok: false, reason: SHARED_ALREADY };
    switching = true;
    detachRefused = null;
    try {
      let ready = false;
      startupReady()?.then(() => { ready = true; }, report);
      await Promise.resolve();
      const standalone = currentCapabilities();
      const common = { edit: standalone.edit, comment: standalone.edit };
      const refusal = (): string | null => (!live ? APP_STOPPED : null)
        ?? (signal?.aborted ? "opening-pending" : null) ?? sharedEntryRefusal(ready, composing);
      const entering: SharedSwitchPorts = {
        refusal, commandRefused: sharedCommandRefusalNotice(notices),
        ...(handoff && { ownsEntry: handoff.owns }),
        settle: () => {
          if (writerControls()?.writerFlowControl()?.settle?.() === false) throw new Error("The Writer could not settle");
          undoOwner().flush();
        },
        prepare: () => keepDraftBeforeEntry(refusal),
        detach: () => {
          const draft = draftSource.detachSource();
          if (!draft.ok) { detachRefused = draft.reason; throw new Error(`The draft writer did not detach: ${draft.reason}`); }
          detached = { home: currentHome(), writtenOut: documentLocation().writtenOut(), unsaved: unsavedChanges() };
          setHome("none"); documentLocation().markWrittenOut(false); confirmSavedNow();
        },
        reattach: () => {
          const kept = detached;
          detached = null;
          if (kept) reattachDraft(kept);
        },
        left,
        common, standalone, migrate: migrateRows, docId: mintDocId, editor: getEditorName,
        report,
        timers: { now: () => Date.now(), start: (run, ms) => setTimeout(run, ms), stop: timer => { clearTimeout(timer as ReturnType<typeof setTimeout>); } },
        now: () => Date.now(),
        opening: openingStatus
      };
      handoff?.release();
      const result = retained ? await enterRetainedSharedScript(entering, retained, signal)
        : open ? await enterSharedSession(entering, open(entering)) : { ok: false as const, reason: APP_STOPPED };
      if (result.ok && sharedSession()) return result;
      if (result.ok) return { ok: false, reason: APP_STOPPED };
      if (detachRefused) {
        const reason = detachRefused;
        detachRefused = null;
        notices.show(DRAFT_NOT_KEPT_NOTICE, "warn");
        return { ok: false, reason: `draft-${reason}` };
      }
      return result;
    } finally { switching = false; }
  };
  const leave = (): SharedSwitchOutcome | Promise<SharedSwitchOutcome> => {
    if (!live) return { ok: false, reason: APP_STOPPED };
    if (switching) return { ok: false, reason: SHARED_SWITCHING };
    if (!sharedSession()) return { ok: false, reason: SHARED_NOT_RUNNING };
    switching = true;
    if (retainedSharedScriptActive()) return leaveRetainedSharedScript().finally(() => { switching = false; });
    try { return leaveRunningSharedSession(); } finally { switching = false; }
  };
  return {
    enter, leave,
    close() {
      live = false;
      try { forceLeaveSharedSession(); }
      finally {
        document.removeEventListener("compositionstart", composition, true);
        document.removeEventListener("compositionend", composition, true);
      }
    }
  };
}

let current: ReturnType<typeof startSharedEntry> | undefined;

export function sharedEntry() { return current; }

export function mountSharedEntry(onLeft: () => void): () => void {
  const entry = startSharedEntry(onLeft);
  current = entry;
  return () => {
    current = undefined;
    entry.close();
  };
}

export async function enterCreatedSharedScript(entry: RetainedSharedScript, handoff: CreatedEntry): Promise<boolean> {
  return (await current?.enter(entry, undefined, handoff))?.ok ?? false;
}
