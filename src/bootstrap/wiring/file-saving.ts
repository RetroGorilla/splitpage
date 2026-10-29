import { mountFileSaving } from "../../application/save/file-saving.ts";
import type { FileSavingDeferredPorts, FileSavingMount, FileSavingPorts } from "../../application/save/file-saving-ports.ts";
import { checkFileConflict, existingTarget, isAbort, pickTarget, writeToHandle } from "../../adapters/files/file-target.ts";
import type { FileHandle, SaveDialogs } from "../../adapters/files/file-target.ts";
import { rememberLastFileHandle } from "../../adapters/files/last-file.ts";
import { saveDialogs } from "../../adapters/files/save-dialogs.ts";
import { buildMarkdownProject, buildSplitpageFile, fileImagesMissing } from "../../adapters/formats/project-file.ts";
import { owned } from "../../features/routing/owned.ts";
import { warnImagesLeftOut } from "../../legacy/effects-bridge.ts";
import { captureExportDocument } from "./export-capture.ts";
import { amendHome, currentHome, documentLocation, fileHome, setHome } from "../../legacy/location-bridge.ts";
import { getEditorName, preferences } from "../../legacy/preferences-bridge.ts";
import { autoSavePolicy, confirmSavedNow, flushAutoSave, haltAutoSave, resumeAutoSave, saveChanges } from "../../legacy/save-bridge.ts";
import { stampDocument } from "./session-owner.ts";
import { documentReader } from "./ports/document.ts";
import { notices } from "./ports/effects.ts";
import { fileDelivery } from "./ports/files.ts";
import { clock, ids } from "./ports/identity.ts";
import { pictures } from "./ports/pictures.ts";

let started: FileSavingMount | null = null;

function fileSavingPorts(deferred: FileSavingDeferredPorts): FileSavingPorts {
  return {
    deferred,
    ids,
    clock,
    document: { current: documentReader.current, stamp: (stamp) => stampDocument(stamp) },
    location: {
      home: () => currentHome(),
      fileHome: () => fileHome(),
      setHome: (kind, fields) => setHome(kind, fields),
      amendHome: (record, fields) => amendHome(record, fields),
      restoreHome: (record) => documentLocation().restoreHome(record),
      writtenOut: () => documentLocation().writtenOut(),
      markWrittenOut: (writtenOut) => { documentLocation().markWrittenOut(writtenOut); }
    },
    lastFile: { remember: (handle) => rememberLastFileHandle(handle) },
    pictures,
    exports: { captureExportDocument },
    formats: {
      buildSplitpage: (doc) => buildSplitpageFile(doc),
      buildMarkdown: (doc) => buildMarkdownProject(doc),
      imagesMissing: (doc) => fileImagesMissing(doc)
    },
    files: {
      dialogs: (slug) => saveDialogs(slug),
      pick: (dialogs) => pickTarget(dialogs as SaveDialogs<FileHandle>),
      existing: (handle) => existingTarget(handle as FileHandle),
      checkConflict: (handle, lastModified) => checkFileConflict(handle as FileHandle, lastModified),
      write: (handle, body) => writeToHandle(handle as FileHandle, body),
      isAbort
    },
    delivery: fileDelivery,
    saves: {
      policy: () => autoSavePolicy(),
      confirmSavedNow: () => { confirmSavedNow(); },
      halt: (reason) => { haltAutoSave(reason); },
      resume: () => { resumeAutoSave(); },
      changes: () => saveChanges()
    },
    notices: { show: notices.show, imagesLeftOut: (count, name) => { warnImagesLeftOut(count, name); } },
    preferences: { editorName: () => getEditorName(), autosave: () => preferences().autosave() },
    page: document
  };
}

export function wireFileSaving(deferred: FileSavingDeferredPorts): FileSavingMount {
  started?.dispose();
  const mounted = mountFileSaving(fileSavingPorts(deferred)) as FileSavingMount;
  started = mounted;
  return mounted;
}

export function updateAutoSaveMenu(): void {
  started?.updateAutoSaveMenu();
}

const pageListeners = owned<{ readonly dispose: () => void }>();

export function mountFileSavingFeature(): void {
  pageListeners.replace(() => {
    const blur = function (): void { flushAutoSave(); };
    const visibility = function (): void {
      if (document.visibilityState === "hidden") flushAutoSave();
    };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return {
      dispose: () => {
        window.removeEventListener("blur", blur);
        document.removeEventListener("visibilitychange", visibility);
      }
    };
  });
}

export const stopFileSavingFeature = pageListeners.stop;
