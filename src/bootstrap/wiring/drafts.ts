import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { startDrafts as mountDrafts } from "../../application/recovery/drafts.js";
import type { DraftsMount, DraftsPorts } from "../../application/recovery/drafts-ports.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { makeDesktopHandle } from "../../adapters/desktop/desktop-handle.ts";
import { parseProjectFileState } from "../../adapters/formats/project-file.ts";
import { inlineStateJson, internDataUrl, persist } from "../../adapters/storage/02c-blobs.js";
import { DRAFT_LIMITS, browserDraftKey, draftBaseOf } from "../../adapters/storage/draft-store-idb.ts";
import { browserWriterId, browserWriterIsLive, holdBrowserWriterLock, releaseBrowserWriterLock } from "../../adapters/storage/draft-writer-lock.js";
import { owned } from "../../features/routing/owned.ts";
import { migrateRows } from "../../legacy/document-ports.ts";
import { documentIdentity } from "./ports/document-identity-controls.ts";
import { notifyDesktopDocumentState } from "./desktop-owners.ts";
import { documentLocation } from "../../legacy/location-bridge.ts";
import { applyMerge } from "./document-merge.ts";
import { resetProductionPanelState } from "../../legacy/production-editing-bridge.ts";
import { applyStashedWork, browserDrafts, captureRestore, desktopDrafts, draftResume, recoveryStarted, stillRestoring, useBrowserDraftFactory } from "./recovery-owners.ts";
import type { LegacyDraftPorts } from "./recovery-owners.ts";
import { saveChanges, unsavedChanges } from "../../legacy/save-bridge.ts";
import { mergeBase, noteAbsorbedDirty } from "../../legacy/session-bridge.ts";
import { openDocument } from "../../legacy/transition-bridge.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { place as portPlace } from "./ports/location.ts";
import { transitions as portTransitions } from "./ports/transitions.ts";

const drafts = owned<DraftsMount>();

function draftsPorts(): DraftsPorts {
  return {
    running: runningOnDesktop,
    clock: { now: () => Date.now() },
    timers: {
      set: (run, ms) => setTimeout(run, ms),
      clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); }
    },
    report: (error) => { if (window.console && window.console.error) window.console.error(error); },
    document: portDocument,
    session: { mergeBase: () => mergeBase(), noteAbsorbedDirty: (reason) => { noteAbsorbedDirty(reason as Parameters<typeof noteAbsorbedDirty>[0]); } },
    place: portPlace,
    markWrittenOut: (on) => { documentLocation().markWrittenOut(on); },
    saves: { unsaved: () => unsavedChanges(), editSeq: () => saveChanges() },
    notices: portNotices,
    entry: { migrate: (raw) => migrateRows(raw) },
    identity: { copyHistory: (fromId, toId) => { documentIdentity.copyDocHistorySafe(fromId, toId); }, sync: () => { documentIdentity.syncDocIdentity(); } },
    transitions: portTransitions,
    documents: { open: (opening) => openDocument(opening as Parameters<typeof openDocument>[0]) },
    resetProductionPanel: () => { resetProductionPanelState(); },
    pictures: { persist: (refs) => persist(refs), inline: (json, failed) => inlineStateJson(json, failed) as string },
    files: {
      handle: (entry) => makeDesktopHandle(entry as Parameters<typeof makeDesktopHandle>[0]),
      parse: (file) => parseProjectFileState(file as Parameters<typeof parseProjectFileState>[0])
    },
    recovery: {
      started: recoveryStarted,
      draftResume: draftResume,
      browserDrafts: browserDrafts,
      desktopDrafts: desktopDrafts,
      captureRestore: captureRestore,
      stillRestoring: stillRestoring,
      applyStashedWork: applyStashedWork,
      useBrowserDraftFactory: (factory) => useBrowserDraftFactory(factory as IDBFactory | null)
    },
    browserDraft: {
      key: (base, docId) => browserDraftKey(base, docId),
      base: (serverUrl) => draftBaseOf(serverUrl, location.href)
    },
    lock: {
      writerId: () => browserWriterId,
      hold: () => { holdBrowserWriterLock(); },
      release: () => { releaseBrowserWriterLock(); },
      isLive: (writerId) => browserWriterIsLive(writerId)
    },
    documentState: { notify: () => { notifyDesktopDocumentState(); } }
  };
}

function listenToPage(mounted: DraftsMount): () => void {
  const blur = (): void => { void mounted.flush(); };
  const visibility = (): void => { if (document.visibilityState === "hidden") void mounted.flush(); };
  const pagehide = (): void => {
    void mounted.flush();
    mounted.releaseLock();
  };
  const pageshow = (e: PageTransitionEvent): void => { if (e && e.persisted) mounted.holdLock(); };
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("pageshow", pageshow);
  return () => {
    window.removeEventListener("blur", blur);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("pageshow", pageshow);
  };
}

export function mountDraftsFeature(): DraftsMount {
  return drafts.replace(() => {
    const mounted = mountDrafts(draftsPorts());
    let unlisten: () => void;
    try {
      unlisten = listenToPage(mounted);
      mounted.holdLock();
      const hooks = (window as { __desktopTest?: Record<string, unknown> }).__desktopTest;
      if (hooks) hooks["drafts"] = mounted.testing;
    } catch (error) {
      mounted.dispose();
      throw error;
    }
    return {
      ...mounted,
      dispose: () => {
        unlisten();
        mounted.dispose();
      }
    };
  });
}

export const stopDraftsFeature = drafts.stop;

export function draftRecoveryPorts() {
  let factory: IDBFactory | null;
  try { factory = window.indexedDB || null; } catch { factory = null; }
  return {
    indexedDB: factory,
    limits: DRAFT_LIMITS,
    now: function () { return Date.now(); },
    writerId: browserWriterId,
    desktop: desktopPort,
    sessionStorage: function () { return sessionStorage; },
    localStorage: function () { return localStorage; },
    internImage: internDataUrl,
    merge: applyMerge,
    drafts: draftPorts
  };
}

const draftPorts: LegacyDraftPorts = {
  flush: (opts) => { const mounted = drafts.owner(); return mounted ? mounted.flush(opts) : Promise.resolve({ ok: true }); },
  noteChange: () => { drafts.owner()?.noteChange(); }
};

export function draftTaker(): (() => Promise<unknown>) | null {
  const mounted = drafts.owner();
  return mounted ? mounted.taker() : null;
}

export function applyTakenDraft(taken: unknown): Promise<string> {
  const mounted = drafts.owner();
  return mounted ? mounted.applyTaken(taken) : Promise.resolve("failed");
}
