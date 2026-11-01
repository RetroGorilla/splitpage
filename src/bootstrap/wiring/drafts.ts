import { presence } from "./ports/desktop-presence.ts";
import { startDrafts as mountDrafts } from "../../application/recovery/drafts.ts";
import type { DraftsMount, DraftsPorts } from "../../application/recovery/drafts-ports.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { makeDesktopHandle } from "../../adapters/desktop/desktop-handle.ts";
import { parseProjectFileState } from "../../adapters/formats/project-file.ts";
import { inlineStateJson, internDataUrl, persist } from "../../adapters/storage/02c-blobs.ts";
import { owned } from "../../features/routing/owned.ts";
import { migrateRows } from "../document-ports.ts";
import { documentIdentity } from "./ports/document-identity-controls.ts";
import { notifyDesktopDocumentState } from "./desktop-owners.ts";
import { documentLocation } from "./location-owner.ts";
import { applyMerge } from "./document-merge.ts";
import { resetProductionPanelState } from "./production-editing-owners.ts";
import { applyStashedWork, captureRestore, desktopDrafts, draftResume, stillRestoring } from "./recovery-owners.ts";
import type { LegacyDraftPorts } from "./recovery-owners.ts";
import { saveChanges, unsavedChanges } from "./save-owners.ts";
import { mergeBase, noteAbsorbedDirty } from "./session-owner.ts";
import { openDocument } from "./transition-owners.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { place as portPlace } from "./ports/location.ts";
import { transitions as portTransitions } from "./ports/transitions.ts";

const drafts = owned<DraftsMount>();

function draftsPorts(): DraftsPorts {
  return {
    running: presence.running,
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
      draftResume: draftResume,
      desktopDrafts: desktopDrafts,
      captureRestore: captureRestore,
      stillRestoring: stillRestoring,
      applyStashedWork: applyStashedWork
    },
    documentState: { notify: () => { notifyDesktopDocumentState(); } }
  };
}

function listenToPage(mounted: DraftsMount): () => void {
  const blur = (): void => { void mounted.flush(); };
  const visibility = (): void => { if (document.visibilityState === "hidden") void mounted.flush(); };
  const pagehide = (): void => { void mounted.flush(); };
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", pagehide);
  return () => {
    window.removeEventListener("blur", blur);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", pagehide);
  };
}

export function mountDraftsFeature(): DraftsMount {
  return drafts.replace(() => {
    const mounted = mountDrafts(draftsPorts());
    let unlisten: () => void;
    try {
      unlisten = listenToPage(mounted);
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

export function draftsTesting(): DraftsMount["testing"] | undefined {
  return drafts.owner()?.testing;
}

export function draftRecoveryPorts() {
  return {
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

export function draftTaker(): ReturnType<DraftsMount["taker"]> {
  const mounted = drafts.owner();
  return mounted ? mounted.taker() : null;
}

export function applyTakenDraft(taken: unknown): Promise<string> {
  const mounted = drafts.owner();
  return mounted ? mounted.applyTaken(taken) : Promise.resolve("failed");
}
