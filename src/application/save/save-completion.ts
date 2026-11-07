import type { ValidatedDocument } from "../../core/document/validated.ts";
import { normalizeDocId } from "../../../shared/doc-id-policy.ts";
import { documentIdStamp, editStamp } from "../commands/save-stamps.ts";
import { fileTitleCommand } from "../commands/title.ts";
import { pathVideoLinks } from "../../core/document/gallery.ts";
import type { BundledPathLink } from "../../core/document/gallery.ts";
import type { FileTitleChange } from "../../core/document/file-title.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import type { LocalFileData } from "../files/local-file-access.ts";
import type { DocumentLocation, Home } from "../location/document-location.ts";
import type { SaveConfirmation } from "./save-state.ts";
import type { FileSavingDeferredPorts, FileSavingPorts } from "./file-saving-ports.ts";

export interface LandedWrite<B = ValidatedDocument> {
  readonly home: Home<B>;
  readonly lastModified: number | null;
}

export interface CompletedWrite<B = ValidatedDocument, P extends B = B> {
  readonly naming?: FileTitleChange | null;
  readonly links?: readonly BundledPathLink[] | null;
  readonly retargeted?: boolean;
  readonly captured: ExportDocument;
  readonly published: P;
  readonly forkDocId: string | null;
  readonly docIdAtSave: string;
  readonly seqAtSave: number;
  readonly landed: LandedWrite<B> | null;
}

export interface SaveCompletionPorts<B = ValidatedDocument, P extends B = B> {
  readonly edits: FileSavingPorts["edits"];
  readonly history: FileSavingPorts["history"];
  readonly document: Pick<FileSavingPorts["document"], "stamp">;
  readonly location: Pick<DocumentLocation<B>, "markWrittenOut" | "amendHome">;
  readonly deferred: FileSavingDeferredPorts<P>;
  readonly saves: Pick<FileSavingPorts["saves"], "changes" | "confirmSavedNow">;
}

export interface SaveCompletion<B = ValidatedDocument, P extends B = B> {
  readonly confirmWrite: (write: CompletedWrite<B, P>) => void;
  readonly adoptSavedCopyDocId: (forkDocId: string | null, docIdAtSave: string, owned: boolean) => void;
}


export function createSaveCompletion<B, P extends B = B>(ports: SaveCompletionPorts<B, P>): SaveCompletion<B, P> {
  function adoptSavedCopyDocId(forkDocId: string | null, docIdAtSave: string, owned: boolean): void {
    forkDocId = normalizeDocId(forkDocId);
    if (forkDocId) ports.deferred.copyHistory(docIdAtSave, forkDocId);
    if (!owned) return;
    if (forkDocId) ports.document.stamp(documentIdStamp(null, forkDocId));
    ports.location.markWrittenOut(true);
    ports.deferred.syncIdentity();
  }

  function confirmWrite(write: CompletedWrite<B, P>): void {
    const stamp = write.captured.document;
    ports.document.stamp(editStamp({ rev: stamp.rev, lastEditedBy: stamp.lastEditedBy, lastEditedAt: stamp.lastEditedAt }));
    ports.deferred.setBaseline(write.published, "saveDoc: the bytes just written");
    if (write.landed) {
      ports.location.amendHome(write.landed.home, { diskBase: write.published, lastModified: write.landed.lastModified });
    }
    adoptSavedCopyDocId(write.forkDocId, write.docIdAtSave, true);
    const links = write.links && write.links.length ? write.links : null;
    const relinked = links ? ports.history.amendRows(function (rows) { return pathVideoLinks(rows, links); }) : "unchanged";
    let named: boolean;
    try {
      named = !write.naming || ports.edits.edit(fileTitleCommand(write.naming));
    } finally {
      if (write.retargeted) ports.history.reset();
    }
    const savedChanges = write.seqAtSave + (write.naming ? 1 : 0) + (relinked === "applied" ? 1 : 0);
    if (named && relinked !== "refused" && ports.saves.changes() === savedChanges) ports.saves.confirmSavedNow();
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
