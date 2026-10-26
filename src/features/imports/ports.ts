import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { Operations } from "../../application/session/operation.ts";
import type { HistoryPort } from "../../application/transitions/ports.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { ImportFormats } from "../../application/formats/import-formats.ts";
import type { DocumentRow } from "../../core/document/validated.ts";
import type { mountImportDialog } from "./imports.js";

export interface ImportDialogPorts {
  readonly document: Pick<DocumentReader, "read">;
  readonly edits: Pick<DocumentEdits, "run" | "allowed" | "stamps">;
  readonly ownership: Operations;
  readonly history: Pick<HistoryPort, "keep">;
  readonly text: Pick<TextServices, "sanitizeHtml">;
  readonly notices: Pick<NoticePort, "show">;
  readonly formats: ImportFormats;
  readonly desktop: { readonly running: () => boolean; readonly openExternal: (url: string) => unknown };
  readonly reviewOnly: string;
  readonly noteEdit: () => void;
  readonly stampRow: (row: DocumentRow) => void;
}

export type ImportDialogControls = ReturnType<typeof mountImportDialog>;
