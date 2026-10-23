import type { MenuItemPort, NoticePort } from "../../application/effects/ports.ts";
import type { ExportCardDecl, ExportChoice, ExportRegistry, FileNameOptions } from "../../application/export/registry.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { ExportCaptureOptions, ExportDocument } from "../../core/document/export-document.ts";
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
