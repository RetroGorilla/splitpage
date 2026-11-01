import type { ImageRef } from "../../core/document/ports.ts";
import type { DocumentRow, ValidatedDocument } from "../../core/document/validated.ts";

export interface ImportTextRow {
  readonly visualText?: unknown;
  readonly audioText?: unknown;
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
  readonly normalize: (rows: readonly ImportTextRow[], sanitize: (html: string) => string) => ImportedRow[];
  readonly csv: (text: string) => DocumentRow[];
  readonly docx: (file: { arrayBuffer: () => Promise<ArrayBuffer> }) => Promise<{ title: string | null; rows: ImportedRow[]; looseText: string }>;
  readonly anchorBroll: (doc: ValidatedDocument, rows: readonly DocumentRow[]) => number;
  readonly declineBroll: (rows: readonly DocumentRow[]) => void;
}
