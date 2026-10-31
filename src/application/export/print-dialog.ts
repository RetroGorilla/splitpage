import type { ExportDocument } from "../../core/document/export-document.ts";
import type { ExportAssets } from "./assets.ts";

export interface ExportPrintRequest {
  readonly doc: ExportDocument;
  readonly assets: ExportAssets;
  readonly options: Readonly<Record<string, unknown>>;
}

export type PrintDialogResult = "opened" | "closed";

export interface PrintDialogJob {
  readonly ended: Promise<"closed" | "failed">;
  readonly print: (html: string) => Promise<PrintDialogResult>;
  readonly close: () => void;
}

export interface PrintDialogPort {
  readonly reserve: (alive: () => boolean) => PrintDialogJob;
}
