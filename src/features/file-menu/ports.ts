import type { MenuItemPort, NoticePort } from "../../application/effects/ports.ts";
import type { ExportCardDecl, ExportChoice, ExportRegistry, FileNameOptions } from "../../application/export/registry.ts";
import type { RecentFileData, RecentFiles } from "../../application/files/recent-files.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { SaveConfirmation, SaveState } from "../../application/save/save-state.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { DocumentDestination, HistoryPort } from "../../application/transitions/ports.ts";
import type { DocumentOpening } from "../../application/transitions/sources.ts";
import type { Transitions } from "../../application/transitions/transitions.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { ExportCaptureOptions, ExportDocument } from "../../core/document/export-document.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { DocxRun } from "../../core/text/projections.ts";

export interface ExportPreviewPort {
  readonly facts: (doc: ExportDocument) => {
    seconds: number; runtime: string; words: number; date: string;
    target: { seconds: number } | null;
    status: { todo: number; ready: number; shot: number };
  };
  readonly scenes: (doc: ExportDocument) => {
    number: string; start: string; seconds: number; read: string; readSet: boolean;
    status: { id: string; label: string };
  }[];
  readonly breakdown: (doc: ExportDocument) => {
    catId: string; categoryLabel: string; name: string; status: string; statusLabel: string;
    owner: string; notes: string; inScript: string; scenes: string[];
  }[];
  readonly shots: (doc: ExportDocument) => {
    scene: string; start: string;
    items: { shot: boolean; name: string; location: string; props: string[]; flagged: boolean }[];
  }[];
  readonly runs: (html: unknown, numbers: Readonly<Record<string, number>>) => (Omit<DocxRun, "tag"> & {
    tag?: { color?: string | null }; markers?: number[];
  })[];
  readonly narration: (doc: ExportDocument, options: { directions?: boolean }) => ExportDocument["scenes"];
  readonly meta: (doc: ExportDocument) => string;
  readonly shotSummary: (doc: ExportDocument) => string;
  readonly commentCount: (doc: ExportDocument) => number;
  readonly markdown: (doc: ExportDocument) => string;
  readonly markdownTable: (doc: ExportDocument) => string;
  readonly tagColor: (category: string) => string | null;
}

export interface FileMenuExportPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly text: Pick<TextServices, "cellOf">;
  readonly notices: Pick<NoticePort, "show">;
  readonly menuItems: MenuItemPort<Element>;
  readonly exports: Pick<ExportRegistry, "cards" | "card" | "byAction" | "isAction" | "exporters" | "onChange">;
  readonly capture: (options?: ExportCaptureOptions) => ExportDocument;
  readonly preview: ExportPreviewPort;
  readonly fileName: (format: string, options: FileNameOptions) => string;
  readonly exportAction: (action: string) => boolean;
  readonly share: () => void;
  readonly onMenuRefresh: (listener: () => void) => () => void;
}

export interface ExportAgainState {
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly reason: string;
  readonly label: string;
}

export interface FileMenuExportControls {
  readonly openExportDialog: (options?: { action?: string }) => boolean;
  readonly exportAgain: () => void;
  readonly exportAgainItemState: () => ExportAgainState;
}

export interface ExportDialogFormat extends ExportCardDecl {
  readonly action?: string;
  readonly choices?: readonly (ExportChoice & { readonly action: string })[];
}

export interface FileMenuExportMount extends FileMenuExportControls {
  readonly captureExportDocument: (options?: ExportCaptureOptions) => ExportDocument;
  readonly exportFormatList: () => ExportDialogFormat[];
  readonly exportActionName: (action: string) => string;
  readonly isExportAction: (action: unknown) => boolean;
  readonly lastExportAction: () => string | null;
  readonly rememberExport: (action: string) => void;
  readonly exportActionReason: (action: string) => string;
  readonly exportSummary: (action: string) => string;
  readonly exportFileNameFor: (action: string) => string;
  readonly exportDialogOpen: () => boolean;
  readonly closeExportDialog: () => void;
  readonly dispose: () => void;
}

export interface FileMenuExportActionPorts {
  readonly screen: () => ScreenState;
  readonly closeMenu: () => void;
}

export interface MenuItemState {
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly reason: string;
}

export interface FileMenuControls {
  readonly toggleFileMenu: (force?: boolean, options?: { focusFirst?: boolean; returnFocus?: boolean }) => void;
  readonly fileMenuOpen: () => boolean;
  readonly toggleSubmenu: (name: string | null, force?: boolean, focusFirst?: boolean) => void;
  readonly refreshFileMenu: () => void;
  readonly refreshOpenFileMenu: () => void;
  readonly onFileMenuRefresh: (listener: () => void) => () => void;
  readonly startNewScript: () => boolean;
  readonly openLongDemo: () => boolean;
}

export interface FileMenuDropdownMount extends FileMenuControls {
  readonly dispose: () => void;
}

export interface FileMenuDropdownPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly place: Pick<DocumentPlace, "home" | "sessionExpired" | "linkTurnedOff">;
  readonly desktop: () => boolean;
  readonly recents: Pick<RecentFiles, "available" | "list" | "routeOpen" | "read">;
  readonly recentHandle: (entry: RecentFileData) => { readonly getFile: () => Promise<File> };
  readonly canOpenPrompter: { readonly browser: () => boolean; readonly chromium: () => boolean };
  readonly opening: DocumentOpening;
  readonly transitions: Pick<Transitions<DocumentDestination>, "startNew">;
  readonly history: HistoryPort;
  readonly notices: Pick<NoticePort, "show">;
  readonly saves: Pick<SaveState, "busy" | "unsaved">;
  readonly saving: SaveConfirmation;
  readonly preferences: Pick<Preferences, "defaultWpm" | "clock">;
  readonly panels: Pick<SidePanels, "close">;
  readonly resetProductionPanel: () => void;
  readonly ids: Pick<IdSource, "id">;
  readonly prepareDocument: (raw: unknown) => ValidatedDocument;
  readonly syncIdentity: () => void;
  readonly longDemo: { readonly state: { readonly title: string; readonly rows: readonly unknown[] } };
}

export interface FileMenuActionPorts {
  readonly screen: () => ScreenState;
  readonly desktop: () => boolean;
  readonly saves: Pick<SaveState, "busy">;
  readonly save: (options?: { saveAs?: boolean }) => Promise<void>;
  readonly openFile: () => Promise<unknown>;
  readonly openImport: () => void;
}
