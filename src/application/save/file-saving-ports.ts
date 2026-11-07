import type { FileSaveCheck } from "../files/local-file-access.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import type { Clock, IdSource } from "../../core/document/ports.ts";
import type { NoticePort } from "../effects/ports.ts";
import type { FileDelivery } from "../files/file-delivery.ts";
import type { DocumentLocation } from "../location/document-location.ts";
import type { PictureStore } from "../media/picture-store.ts";
import type { DocumentReader } from "../session/document-reader.ts";
import type { DocumentEdits } from "../session/document-edits.ts";
import type { Stamp } from "../session/document-session.ts";
import type { Operations } from "../session/operation.ts";
import type { AutoSaveChange, AutoSavePolicy } from "./autosave.ts";
import type { DestinationKey } from "./coordinator.ts";
import type { SaveDestination } from "./destinations.ts";
import type { ExportKit } from "./export-kit.ts";

export interface FileSaveRequest {
  readonly kind: string;
}

export interface FileSaveHandle {
  readonly name: string;
}

export interface FileSaveDialogs {
  readonly desktop: (() => Promise<FileSaveHandle | null>) | null;
  readonly browser: (() => Promise<FileSaveHandle>) | null;
}

export type FileSaveTarget =
  | { readonly kind: "handle"; readonly handle: FileSaveHandle; readonly picked: boolean }
  | { readonly kind: "download" };

export interface FileSaveTargets {
  readonly dialogs: (slug: string) => FileSaveDialogs;
  readonly pick: (dialogs: FileSaveDialogs) => Promise<FileSaveTarget | { readonly kind: "cancelled" }>;
  readonly existing: (handle: FileSaveHandle) => FileSaveTarget;
  readonly checkConflict: (handle: FileSaveHandle, lastModified: number | null | undefined) => Promise<FileSaveCheck>;
  readonly write: (handle: FileSaveHandle, body: string) => Promise<{ readonly lastModified: number | null }>;
  readonly isAbort: (error: unknown) => boolean;
}

export interface FileSavingDeferredPorts<B = ValidatedDocument> {
  readonly copyHistory: (fromId: string, toId: string) => void;
  readonly syncIdentity: () => void;
  readonly setBaseline: (state: B | null, reason: string) => void;
}

export interface AutoSaveMenuItem {
  readonly setAttribute: (name: string, value: string) => void;
  readonly classList: { readonly toggle: (token: string, force?: boolean) => boolean };
}

export interface FileSavingPorts {
  readonly edits: Pick<DocumentEdits, "edit">;
  readonly deferred: FileSavingDeferredPorts;
  readonly ids: Pick<IdSource, "docId">;
  readonly clock: Clock;
  readonly document: Pick<DocumentReader, "current"> & { readonly stamp: (stamp: Stamp) => unknown };
  readonly location: Pick<DocumentLocation, "home" | "fileHome" | "setHome" | "amendHome" | "restoreHome" | "writtenOut" | "markWrittenOut">;
  readonly lastFile: { readonly remember: (handle: FileSaveHandle) => Promise<void> };
  readonly pictures: Pick<PictureStore, "ensureBytes">;
  readonly exports: Pick<ExportKit, "captureExportDocument">;
  readonly formats: {
    readonly buildSplitpage: (doc: ExportDocument) => string;
    readonly buildMarkdown: (doc: ExportDocument) => string;
    readonly imagesMissing: (doc: ExportDocument) => readonly string[];
  };
  readonly files: FileSaveTargets;
  readonly delivery: FileDelivery;
  readonly saves: {
    readonly policy: () => Pick<AutoSavePolicy, "enabled">;
    readonly confirmSavedNow: () => void;
    readonly halt: (reason: string) => void;
    readonly resume: () => void;
    readonly changes: () => number;
  };
  readonly notices: Pick<NoticePort, "show"> & { readonly imagesLeftOut: (count: number, name: string) => void };
  readonly preferences: { readonly editorName: () => string; readonly autosave: () => boolean };
  readonly page: { readonly getElementById: (id: string) => AutoSaveMenuItem | null };
  readonly bundles: { readonly carry: (from: FileSaveHandle, to: FileSaveHandle, names: readonly string[]) => void };
}

export interface FileSavePorts {
  readonly destination: () => unknown;
  readonly keyOf: (identity: unknown) => DestinationKey;
  readonly obsolete: (request: FileSaveRequest, here: boolean) => void;
  readonly ownership: Operations;
  readonly autosave: {
    readonly enabledAtStart: () => boolean;
    readonly changed: (what: AutoSaveChange) => void;
  };
}

export interface FileSavingMount {
  readonly destination: () => SaveDestination<FileSaveRequest, unknown>;
  readonly savePorts: (ownership: Operations) => FileSavePorts;
  readonly updateAutoSaveMenu: () => void;
  readonly dispose: () => void;
}
