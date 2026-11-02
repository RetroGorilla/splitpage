import type { BusyNotices, NoticePort } from "../effects/ports.ts";
import type { UndoControl } from "../editing/undo-control.ts";
import type { LocalFileAccess, LocalFileData, LocalFileReference } from "../files/local-file-access.ts";
import type { DocumentLocation } from "../location/document-location.ts";
import type { FileConflicts } from "../save/file-conflict.ts";
import type { SaveConfirmation, SaveState } from "../save/save-state.ts";
import type { DocumentReader } from "../session/document-reader.ts";
import type { SessionMergeOwner } from "../session/session-merge-ports.ts";
import type { SidePanels } from "../side-panels.ts";
import type { TextServices } from "../text/services.ts";
import type { DocumentDestination, HistoryPort } from "./ports.ts";
import type { DocumentSource } from "./sources.ts";
import type { Transitions } from "./transitions.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { DraftParsedFile } from "../recovery/drafts-ports.ts";
import type { ImportFormats, ImportedRow } from "../formats/import-formats.ts";
import type { DesktopIpcArgs, DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";

export interface LocalFileOpening {
  readonly kind: string;
  readonly file?: LocalFileData | null | undefined;
  readonly handle?: LocalFileReference | null;
  readonly parsed?: { readonly state: ValidatedDocument; readonly kind: string };
  readonly options?: { readonly skipSnapshot?: boolean; readonly silent?: boolean; readonly resumed?: boolean; readonly reload?: boolean } | null;
}

export interface LocalFileImports {
  readonly parseProjectFileState: (file: unknown) => Promise<DraftParsedFile | null>;
  readonly docxToRows: (file: LocalFileData) => ReturnType<ImportFormats["docx"]>;
  readonly csvToRows: (text: string) => ImportedRow[];
  readonly detectTwoColumnFormat: (text: string) => string | null;
  readonly parseImportRows: (text: string, mode: string) => unknown;
  readonly normalizeImportedRows: (rows: unknown, sanitize: TextServices["sanitizeHtml"]) => ImportedRow[];
}

export interface LocalFilesOwnerPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly session: {
    readonly noteAbsorbedDirty: (kind: "reload" | "adopt") => void;
    readonly noteReload: (content: unknown) => void;
  };
  readonly transitions: Pick<Transitions<DocumentDestination>, "open">;
  readonly history: HistoryPort;
  readonly saving: SaveConfirmation;
  readonly saves: Pick<SaveState, "unsaved">;
  readonly conflicts: Pick<FileConflicts, "close">;
  readonly location: Pick<DocumentLocation, "amendHome" | "setHome" | "fileHome" | "importHome">;
  readonly lastFile: { readonly load: () => Promise<LocalFileReference | null>; readonly remember: (handle: LocalFileReference | null | undefined) => Promise<void> };
  readonly syncIdentity: () => void;
  readonly stamps: Pick<SessionMergeOwner, "stampRow">;
  readonly notices: Pick<NoticePort, "show"> & { readonly busy: Pick<BusyNotices, "begin" | "end"> };
  readonly resetProductionPanel: () => void;
  readonly panels: Pick<SidePanels, "close">;
  readonly undo: Pick<UndoControl, "flush">;
  readonly imports: LocalFileImports;
  readonly text: Pick<TextServices, "sanitizeHtml">;
  readonly resumeNeeded: (handle: LocalFileReference) => void;
  readonly desktop: {
    readonly running: () => boolean;
    readonly openFileDialog: () => Promise<DesktopIpcResult<"splitpage:open-file-dialog">>;
    readonly routeOpen: (...args: DesktopIpcArgs<"splitpage:route-open">) => Promise<DesktopIpcResult<"splitpage:route-open">>;
  };
  readonly files: LocalFileAccess;
  readonly chooseFallback: () => void;
}

export interface LocalFilesOwner {
  readonly startLocalFiles: (ports: LocalFilesOwnerPorts) => () => void;
  readonly projectFileSource: () => DocumentSource<LocalFileOpening>;
  readonly tryResumeLastProject: () => Promise<void>;
  readonly resumeFromHandle: (handle: LocalFileReference | null | undefined) => Promise<void>;
  readonly openLocalFile: () => Promise<void>;
  readonly reloadFileFromDisk: () => Promise<void>;
  readonly reloadProjectFromDisk: () => Promise<void>;
}
