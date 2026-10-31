import type { ExportDocument } from "../../core/document/export-document.ts";

export interface PdfPrinter {
  readonly print: (html: string, doc: ExportDocument) => Promise<Uint8Array>;
}
