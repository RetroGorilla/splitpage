import { exposeTestHook } from "../../features/common/test-hooks.ts";
import { mintDocId } from "../../adapters/identity/ids.ts";
import { startupReady } from "../../application/startup-signal.ts";
import { migrateRows } from "../document-ports.ts";
import { currentCapabilities, sharedSession } from "./session-owner.ts";
import { SHARED_ALREADY, SHARED_NOT_RUNNING, SHARED_SWITCHING, enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "./shared-session.ts";
import type { SharedSwitchOutcome, SharedSwitchPorts } from "./shared-session.ts";
import type { Home } from "../../application/location/document-location.ts";
import { sharedCommandRefusalNotice } from "./ports/shared-command-notices.ts";
import { notices } from "./ports/effects.ts";
import { documentReader } from "./ports/document.ts";
import { openingStatus } from "./ports/transitions.ts";
import { getEditorName } from "./preferences-owner.ts";
import { undoOwner } from "./undo.ts";
import { writerControls } from "./writer.ts";
import { draftResume, flushDraftNow, noteDraftChange } from "./recovery-owners.ts";
import { draftSource } from "./drafts.ts";
import { confirmSavedNow, noteSaveChange, unsavedChanges } from "./save-owners.ts";
import { currentHome, documentLocation, setHome } from "./location-owner.ts";
import { openNativeEditor } from "./native-shared-session.ts";
import { createNativeTestPeer } from "./shared-native-test-peer.ts";
import { stopNativeCaretWait } from "./native-switch-caret.ts";
import { enterRetainedSharedScript, leaveRetainedSharedScript, retainedSharedScriptActive } from "./retained-shared-script.ts";
import type { RetainedSharedScript } from "./retained-shared-script.ts";

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

function sharedTestBytes(state: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof state === "string") return Uint8Array.from(atob(state), character => character.charCodeAt(0));
  return state instanceof ArrayBuffer ? new Uint8Array(state.slice(0)) : Uint8Array.from(state);
}

function startSharedTestHook(): () => void {
  let detached: Detached | null = null;
  let nativePeer: ReturnType<typeof createNativeTestPeer> | null = null;
  let switching = false, composing = false, live = true, detachRefused: string | null = null;
  const lifetime = new AbortController();
  let withdraw = (): void => {};
  const report = (error: unknown): void => { console.error(error); };
  const composition = (event: Event): void => { composing = event.type === "compositionstart"; };
  document.addEventListener("compositionstart", composition, true);
  document.addEventListener("compositionend", composition, true);
  const left = (landed: boolean): void => {
    const ending = nativePeer, kept = detached;
    nativePeer = null; detached = null;
    // why: the landed copy has a new docId and was never saved, so it is unsaved (rules 75 and 76)
    const marks = landed && kept ? [() => { noteSaveChange(); }, () => { noteDraftChange(); }] : [];
    runEvery([() => { ending?.dispose(); }, ...(kept ? [() => { draftSource.resumeWriting(); }] : []), ...marks]);
  };
  const enter = async (stored?: Uint8Array, retained?: RetainedSharedScript): Promise<SharedSwitchOutcome> => {
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
      const refusal = (): string | null => (!live ? APP_STOPPED : null) ?? sharedEntryRefusal(ready, composing);
      const entering: SharedSwitchPorts = {
        refusal, commandRefused: sharedCommandRefusalNotice(notices),
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
      const opened: { session?: ReturnType<typeof openNativeEditor>["native"] } = {};
      const signal = retained?.signal ? AbortSignal.any([retained.signal, lifetime.signal]) : lifetime.signal;
      const result = retained ? await enterRetainedSharedScript(entering, { ...retained, signal }) : await enterSharedSession(entering, (doc, failedClose) => {
        const { backend, native } = openNativeEditor(entering, doc, failedClose, stored);
        opened.session = native;
        return backend;
      });
      if (result.ok && sharedSession()) {
        if (opened.session) nativePeer = createNativeTestPeer(opened.session);
        return result;
      }
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
  const hook = {
    enter: () => enter(),
    enterFrom: (state: string | Uint8Array | ArrayBuffer) => enter(sharedTestBytes(state)),
    leave,
    enterRetained: (retained: RetainedSharedScript) => enter(undefined, retained),
    snapshot: () => nativePeer?.snapshot(),
    nativePeer: {
      type: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["type"]>) => nativePeer?.type(...args),
      field: (...args: Parameters<NonNullable<typeof nativePeer>["field"]>) => nativePeer?.field(...args),
      join: (lower: string, upper: string) => nativePeer?.join(lower, upper),
      unjoin: (lower: string) => nativePeer?.unjoin(lower),
      split: (beat: string, offset: number) => nativePeer?.split(beat, offset),
      removeBeat: (id: string) => nativePeer?.removeBeat(id),
      replaceAll: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["replaceAll"]>) => nativePeer?.replaceAll(...args),
      undoPeer: () => nativePeer?.undoPeer(),
      seedReader: () => nativePeer?.seedReader(),
      readLateReader: () => nativePeer?.readLateReader() ?? null,
      typeReader: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["typeReader"]>) =>
        nativePeer?.typeReader(...args) ?? null,
      undoReader: () => nativePeer?.undoReader() ?? null,
      queuedReaderUpdates: () => nativePeer?.queuedReaderUpdates() ?? [],
      deliverReaderUpdates: () => nativePeer?.deliverReaderUpdates() ?? [],
      deliverToReader: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["deliverToReader"]>) =>
        nativePeer?.deliverToReader(...args) ?? false,
      freshSnapshot: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["freshSnapshot"]>) =>
        nativePeer?.freshSnapshot(...args) ?? null,
      moveBeat: (...args: Parameters<NonNullable<typeof nativePeer>["moveBeat"]>) => nativePeer?.moveBeat(...args),
      removeComment: (id: string) => nativePeer?.removeComment(id),
      registry: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["registry"]>) => nativePeer?.registry(...args),
      format: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["format"]>) => nativePeer?.format(...args),
      hold: (mode?: "updates") => nativePeer?.hold(mode),
      queuedUpdates: () => nativePeer?.queuedUpdates(),
      drain: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["drain"]>) => nativePeer?.drain(...args),
      release: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["release"]>) => nativePeer?.release(...args),
      deliver: () => nativePeer?.deliver(),
      step: (direction: "undo" | "redo") => nativePeer?.step(direction),
      delete: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["delete"]>) => nativePeer?.delete(...args)
    },
    read: () => ({ app: documentReader.read(doc => doc ? JSON.parse(JSON.stringify(doc)) as unknown : null), peer: nativePeer?.read() ?? null })
  };
  exposeTestHook("__sharedTest", () => hook, release => { withdraw = release; });
  return () => {
    live = false;
    lifetime.abort();
    try { forceLeaveSharedSession(); } finally {
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
  stopNativeCaretWait();
  stop?.();
}
