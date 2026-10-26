import { deriveDocId } from "../../core/document/ids.ts";
import { cloneState } from "../../core/document/clone.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { ProjectFileServices, MarkdownRowChoice } from "../formats/project-file-services.ts";
import type { DocumentReader } from "../session/document-reader.ts";
import type { DocumentLocation, Home } from "../location/document-location.ts";
import type { ExportKit } from "./export-kit.ts";
import type { AutoSavePolicy } from "./autosave.ts";
import type { AutoSaveTarget } from "./status.ts";

export interface ProjectFileDeferredPorts {
  readonly prepareDocument: ProjectFileServices["migrateDocument"];
  readonly restoreDocument: (snapshot: unknown) => ValidatedDocument | null;
  readonly changeDocumentId: (to: unknown, options?: { readonly fromId?: unknown; readonly otherTitle?: unknown }) => boolean;
  readonly identityEvents: () => unknown[];
  readonly connectIdentity: (factory?: unknown) => unknown;
  readonly standaloneHtml: (doc: ExportDocument) => string;
  readonly replaceSyncBase: (state: null, reason: string) => void;
  readonly tagOccurrences: ProjectFileServices["tagFieldOccurrences"];
}

export interface ProjectFileSavePort {
  readonly save: (options: { readonly auto?: boolean; readonly force?: boolean; readonly saveAs?: boolean }) => Promise<void>;
  readonly autoSave: () => Pick<AutoSavePolicy, "timing" | "enabled" | "halted" | "pending">;
  readonly target: () => AutoSaveTarget;
  readonly toggle: () => void;
  readonly flush: () => void;
}

export interface ProjectFileOpeningPort {
  readonly open: (opening: { readonly kind: "file" | "import"; readonly file: unknown; readonly handle?: unknown; readonly options?: { readonly skipSnapshot: boolean } }) => Promise<unknown>;
}

export interface ProjectFilesPorts {
  readonly deferred: ProjectFileDeferredPorts;
  readonly document: Pick<DocumentReader, "current">;
  readonly heldDocument: () => ValidatedDocument | null;
  readonly location: Pick<DocumentLocation, "writtenOut" | "fileHome" | "amendHome">;
  readonly entry: ProjectFileServices["migrateRows"];
  readonly text: Pick<ProjectFileServices, "sanitizeHtml" | "inertBody">;
  readonly recovery: { readonly stash: () => boolean };
  readonly exports: Pick<ExportKit, "captureExportDocument" | "exportDocumentOf">;
  readonly saving: ProjectFileSavePort;
  readonly opening: ProjectFileOpeningPort;
  readonly codecs: {
    readonly buildSplitpage: (doc: ExportDocument) => string;
    readonly buildMarkdown: (doc: ExportDocument) => string;
    readonly parseMarkdown: (text: string) => unknown;
  };
  readonly page: { readonly getElementById: (id: string) => { textContent: string | null; hidden: boolean | string } | null };
}

export function createProjectFiles(ports: ProjectFilesPorts) {
  let pendingMdRowChoice: ((choice: MarkdownRowChoice) => void) | null = null;

  function askMarkdownRowChoice(blockRows: number, tableRows: number): Promise<MarkdownRowChoice> {
    return new Promise(function (resolve) {
      const modal = ports.page.getElementById("md-rows-modal");
      if (!modal) { resolve("keep"); return; }
      (ports.page.getElementById("md-rows-detail") as { textContent: string | null }).textContent =
        "This file's own record has " + blockRows + " scene" + (blockRows === 1 ? "" : "s") +
        ", but the table in it now has " + tableRows + ". Scenes were added or removed " +
        "somewhere other than Splitpage, so the two can no longer be lined up scene by scene.";
      pendingMdRowChoice = resolve;
      modal.hidden = false;
    });
  }

  function finishMarkdownRowChoice(choice: unknown): void {
    const modal = ports.page.getElementById("md-rows-modal");
    if (modal) modal.hidden = true;
    const resolve = pendingMdRowChoice;
    pendingMdRowChoice = null;
    if (resolve) resolve(choice === "table" ? "table" : "keep");
  }

  const services: ProjectFileServices = {
    migrateRows: ports.entry,
    migrateDocument: ports.deferred.prepareDocument,
    sanitizeHtml: ports.text.sanitizeHtml,
    tagFieldOccurrences: ports.deferred.tagOccurrences,
    inertBody: ports.text.inertBody,
    askMarkdownRows: askMarkdownRowChoice
  };

  const formats = {
    buildSplitpage: function (s?: unknown) { return ports.codecs.buildSplitpage(s ? ports.exports.exportDocumentOf(s) : ports.exports.captureExportDocument()); },
    buildMarkdown: function (s?: unknown) { return ports.codecs.buildMarkdown(s ? ports.exports.exportDocumentOf(s) : ports.exports.captureExportDocument()); },
    parseMarkdown: function (text: string) { return ports.codecs.parseMarkdown(text); },
    buildStandaloneHtml: function () { return ports.deferred.standaloneHtml(ports.exports.captureExportDocument()); },
    docId: function () { return ports.document.current() ? (ports.document.current() as { readonly docId: string }).docId : null; },
    writtenOut: function () { return ports.location.writtenOut(); },
    deriveDocId: deriveDocId,
    adoptRestoredState: ports.deferred.restoreDocument,
    reassignDocId: ports.deferred.changeDocumentId,
    docIdEvents: ports.deferred.identityEvents,
    initDocIdentityChannel: ports.deferred.connectIdentity,
    openFile: function (file: unknown, handle?: unknown) { return ports.opening.open({ kind: "file", file: file, handle: handle || null, options: { skipSnapshot: true } }); },
    importFile: function (file: unknown) { return ports.opening.open({ kind: "import", file: file }); },
    save: function (opts?: Parameters<ProjectFileSavePort["save"]>[0] | null) { return ports.saving.save(opts || {}); },
    autosave: {
      timing: function () { return ports.saving.autoSave().timing; },
      enabled: function () { return ports.saving.autoSave().enabled(); },
      halt: function () { return ports.saving.autoSave().halted(); },
      target: function () { return ports.saving.target(); },
      pending: function () { return ports.saving.autoSave().pending(); },
      toggle: ports.saving.toggle,
      flush: ports.saving.flush
    },
    migrate: ports.entry,
    stash: ports.recovery.stash,
    clone: cloneState,
    state: function () { return ports.heldDocument(); },
    docFile: function () {
      const f = ports.location.fileHome();
      return { name: f && f.handle ? (f.handle as { readonly name: string }).name : null, kind: f ? f.format : null,
        lastModified: f ? f.lastModified : null };
    },
    hasDiskBase: function () { return !!(ports.location.fileHome() && (ports.location.fileHome() as Home).diskBase); },
    forgetDiskBase: function () { if (ports.location.fileHome()) ports.location.amendHome(ports.location.fileHome() as Home, { diskBase: null }); ports.deferred.replaceSyncBase(null, "__splitpageFormats.forgetDiskBase: test hook, drives the two-way fallback"); return true; }
  };

  return { services, formats, finishMarkdownRowChoice };
}
