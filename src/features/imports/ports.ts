import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { Operations } from "../../application/session/operation.ts";
import type { HistoryPort } from "../../application/transitions/ports.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { ImportFormats } from "../../application/formats/import-formats.ts";
import type { ImportMode } from "../../application/import-mode.ts";
import type { DocumentRow } from "../../core/document/validated.ts";
import type { ImportIntoNewDocument } from "../../application/formats/import-formats.ts";
import type { LocalFileOpening } from "../../application/transitions/local-files-ports.ts";
import type { DocumentSource } from "../../application/transitions/sources.ts";

export interface ImportDialogPorts {
  readonly document: Pick<DocumentReader, "read">;
  readonly edits: Pick<DocumentEdits, "run" | "allowed" | "stamps">;
  readonly ownership: Operations;
  readonly history: Pick<HistoryPort, "keep">;
  readonly text: Pick<TextServices, "sanitizeHtml">;
  readonly notices: Pick<NoticePort, "show">;
  readonly formats: ImportFormats;
  readonly desktop: { readonly running: () => boolean; readonly openExternal: (url: string) => unknown };
  readonly noteEdit: () => void;
  readonly stampRow: (row: DocumentRow) => void;
  readonly mode: Pick<ImportMode, "touched" | "reset">;
}

export interface ImportDialogOptions {
  readonly intoNewDocument?: ImportIntoNewDocument | null | undefined;
}

export interface ImportDialogSource extends DocumentSource<Pick<LocalFileOpening, "kind" | "file">, void> {
  readonly id: "import";
}

export interface ImportDialogControls {
  readonly maybeAutoDetectTwoColumn: (text: string) => void;
  readonly updateImportPreview: () => void;
  readonly clearPendingFileRows: () => void;
  readonly captureImportPreview: () => () => boolean;
  readonly openImportModal: (options?: ImportDialogOptions) => void;
  readonly closeImportModal: () => void;
  readonly importDocumentSource: () => ImportDialogSource;
  readonly confirmImport: () => void;
  readonly openGdocModal: () => void;
  readonly closeGdocModal: () => void;
  readonly confirmGdocImport: () => void;
  readonly dispose: () => void;
}
