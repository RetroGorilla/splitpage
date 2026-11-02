import type { ImageRef } from "../../core/document/ports.ts";
import type { DocumentRow, ValidatedDocument } from "../../core/document/validated.ts";

export type ImportIntoNewDocument = (rows: DocumentRow[], scan: (doc: ValidatedDocument) => void) => void;

export interface ImportTextRow {
  readonly visualText?: string | null | undefined;
  readonly audioText?: string | null | undefined;
}

export interface ImportedRow extends DocumentRow {
  id: string;
  visualText: string;
  audioText: string;
  imageRef: ImageRef | null;
}

export interface ImportFormats {
  readonly parse: (text: string, mode: string) => ImportTextRow[] | null;
  readonly detect: (text: string) => string | null;
  readonly normalize: (rows: readonly ImportTextRow[] | null, sanitize: (html: string) => string) => ImportedRow[];
  readonly csv: (text: string) => DocumentRow[];
  readonly docx: (file: { arrayBuffer: () => Promise<ArrayBuffer> }) => Promise<{ title: string | null; rows: ImportedRow[]; looseText: string }>;
  readonly anchorBroll: (doc: ValidatedDocument, rows: readonly DocumentRow[]) => number;
  readonly declineBroll: (rows: readonly DocumentRow[]) => void;
}
