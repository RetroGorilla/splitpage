import type { ValidatedDocument } from "../../core/document/validated.ts";
import { normalizeDocId } from "../../../shared/doc-id-policy.js";
import { documentIdStamp, editStamp } from "../commands/save-stamps.ts";
import { fileTitleCommand } from "../commands/title.ts";
import type { FileTitleChange } from "../../core/document/file-title.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import type { LocalFileData } from "../files/local-file-access.ts";
import type { DocumentLocation, Home, HomeFields } from "../location/document-location.ts";
import type { SaveConfirmation } from "./save-state.ts";
import type { FileSavingDeferredPorts, FileSavingPorts } from "./file-saving-ports.ts";

export interface LandedWrite {
  readonly home: Home;
  readonly lastModified: number | null;
}

export interface CompletedWrite<B = ValidatedDocument> {
  readonly naming?: FileTitleChange | null;
  readonly captured: ExportDocument;
  readonly published: B;
  readonly forkDocId: string | null;
  readonly docIdAtSave: string;
  readonly seqAtSave: number;
  readonly landed: LandedWrite | null;
}

export interface SaveCompletionPorts<B = ValidatedDocument> {
  readonly edits: FileSavingPorts["edits"];
  readonly document: Pick<FileSavingPorts["document"], "stamp">;
  readonly location: Pick<DocumentLocation, "markWrittenOut"> & { readonly amendHome: (home: Home, fields: HomeFields<B>) => Home };
  readonly deferred: FileSavingDeferredPorts<B>;
  readonly saves: Pick<FileSavingPorts["saves"], "changes" | "confirmSavedNow">;
}

export interface SaveCompletion<B = ValidatedDocument> {
  readonly confirmWrite: (write: CompletedWrite<B>) => void;
  readonly adoptSavedCopyDocId: (forkDocId: string | null, docIdAtSave: string, owned: boolean) => void;
}

export function createSaveCompletion<B>(ports: SaveCompletionPorts<B>): SaveCompletion<B> {
  function adoptSavedCopyDocId(forkDocId: string | null, docIdAtSave: string, owned: boolean): void {
    forkDocId = normalizeDocId(forkDocId);
    if (forkDocId) ports.deferred.copyHistory(docIdAtSave, forkDocId);
    if (!owned) return;
    if (forkDocId) ports.document.stamp(documentIdStamp(null, forkDocId));
    ports.location.markWrittenOut(true);
    ports.deferred.syncIdentity();
  }

  function confirmWrite(write: CompletedWrite<B>): void {
    const stamp = write.captured.document;
    ports.document.stamp(editStamp({ rev: stamp.rev, lastEditedBy: stamp.lastEditedBy, lastEditedAt: stamp.lastEditedAt }));
    ports.deferred.setBaseline(write.published, "saveDoc: the bytes just written");
    if (write.landed) {
      ports.location.amendHome(write.landed.home, { diskBase: write.published, lastModified: write.landed.lastModified });
    }
    adoptSavedCopyDocId(write.forkDocId, write.docIdAtSave, true);
    const named = !write.naming || ports.edits.edit(fileTitleCommand(write.naming));
    const savedChanges = write.seqAtSave + (write.naming ? 1 : 0);
    if (named && ports.saves.changes() === savedChanges) ports.saves.confirmSavedNow();
  }

  return Object.freeze({ confirmWrite, adoptSavedCopyDocId });
}

export interface ImportCompletionPorts {
  readonly location: Pick<DocumentLocation, "amendHome">;
  readonly saving: { readonly unsavedFor: (target: unknown) => boolean };
}

export interface ImportCompletion {
  readonly landed: (imported: Home, after: Pick<LocalFileData, "lastModified" | "size">) => void;
  readonly landedUnread: (imported: Home, closed: unknown) => void;
  readonly acknowledged: (imported: Home) => void;
}

function closedStamp(closed: unknown): number | null {
  if (!closed || typeof closed !== "object") return null;
  const stamp = (closed as { lastModified?: unknown }).lastModified;
  return typeof stamp === "number" && Number.isFinite(stamp) ? stamp : null;
}

export function createImportCompletion(ports: ImportCompletionPorts): ImportCompletion {
  return Object.freeze({
    landed: function (imported: Home, after: Pick<LocalFileData, "lastModified" | "size">): void {
      ports.location.amendHome(imported, { lastModified: after.lastModified, size: after.size });
    },
    landedUnread: function (imported: Home, closed: unknown): void {
      ports.location.amendHome(imported, { lastModified: closedStamp(closed), size: null });
    },
    acknowledged: function (imported: Home): void {
      ports.location.amendHome(imported, { dirty: ports.saving.unsavedFor(imported) });
    }
  });
}

export interface AdoptionCompletionPorts {
  readonly location: Pick<DocumentLocation, "amendHome">;
  readonly saving: SaveConfirmation;
}

export interface AdoptionCompletion {
  readonly projectOpened: () => void;
  readonly importOpened: (imported: Home) => void;
}

export function createAdoptionCompletion(ports: AdoptionCompletionPorts): AdoptionCompletion {
  return Object.freeze({
    projectOpened: function (): void { ports.saving.confirmSavedNow(); },
    importOpened: function (imported: Home): void { ports.location.amendHome(imported, { dirty: false }); }
  });
}
