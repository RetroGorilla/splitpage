import type { ResumeHandle } from "./mount.ts";
import type { ActionRegistry } from "../../application/actions.ts";
import type { BusyNotices, MenuItemPort, NoticePort } from "../../application/effects/ports.ts";
import type { ExportAssetRequest } from "../../application/export/assets.ts";
import type { ExportRegistry, FileNameOptions } from "../../application/export/registry.ts";
import type { FileDelivery } from "../../application/files/file-delivery.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { BrollView } from "../../application/preferences/broll-view.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { FileConflict } from "../../application/save/file-conflict.ts";
import type { BuiltLocalFile, ImportSavingOwner } from "../../application/save/import-saving-ports.ts";
import type { ExportKit } from "../../application/save/export-kit.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SessionChange } from "../../application/session/change-set.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import type { FileMenuExportMount } from "./ports.ts";

export interface LocalFileMenuPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly preferences: Pick<Preferences, "clock">;
  readonly place: Pick<DocumentPlace, "importHome" | "fileHome">;
  readonly writeback: Pick<ImportSavingOwner, "saveBackItemState">;
  readonly exports: Pick<ExportKit, "captureExportDocument" | "loadExportAssets">;
  readonly formats: Pick<ExportRegistry, "byId" | "byAction" | "isAction" | "card">;
  readonly assets: { readonly request: (doc: ExportDocument) => ExportAssetRequest };
  readonly standaloneHtml: (doc: ExportDocument) => unknown;
  readonly imagesLeftOut: (count: number, filename: string) => void;
  readonly brollView: Pick<BrollView, "printView">;
  readonly notices: Pick<NoticePort, "show"> & { readonly busy: Pick<BusyNotices, "withBar"> };
  readonly delivery: FileDelivery;
  readonly menuItems: Pick<MenuItemPort<Element>, "setLabel">;
  readonly merge: { readonly offer: (file: unknown, home: unknown) => Promise<void>; readonly reset: () => void };
  readonly exportControls: Pick<FileMenuExportMount, "isExportAction" | "rememberExport">;
  readonly actions: Pick<ActionRegistry, "invoke" | "has">;
}

export interface LocalFileChipListeners {
  readonly session: (change: SessionChange) => void;
  readonly location: (change: string) => void;
  readonly save: (change: string) => void;
}

export interface LocalFileMenuControls {
  readonly updateFileChip: () => void;
  readonly fileChipListeners: (refresh: () => void) => LocalFileChipListeners;
  readonly mirrorFileChipToWriter: () => void;
  readonly exportFileName: (kind: string, baseName: string, options?: FileNameOptions) => string;
  readonly exportBaseName: () => string;
  readonly exportRequest: (kind: string, options?: Readonly<Record<string, unknown>>) => unknown;
  readonly buildFileData: (kind: string, baseName: string, options?: Readonly<Record<string, unknown>>) => Promise<BuiltLocalFile>;
  readonly showResumeBanner: (handle: unknown) => void;
  readonly hideResumeBanner: () => void;
  readonly pendingHandle: () => ResumeHandle | null;
  readonly showFileConflictView: (conflict: FileConflict | null) => void;
  readonly exportAs: (kind: string, more?: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly runExport: (action: string) => Promise<boolean>;
  readonly onFileMenuChoice: (listener: (action: string) => void) => () => void;
  readonly noteFileMenuChoice: (action: string) => void;
  readonly runExportAction: (action: string) => boolean;
  readonly handleFileMenuAction: (action: string | null, source?: string) => void;
  readonly dispose: () => void;
}
