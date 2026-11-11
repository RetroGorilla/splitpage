import { buildExportDocument } from "../../core/document/export-document.ts";
import type { ExportCaptureOptions, ExportDocument, ExportReadModels } from "../../core/document/export-document.ts";
import type { Clock } from "../../core/document/ports.ts";
import type { CommonDocumentSession, DocumentView } from "../session/document-session.ts";

export type { ExportCaptureOptions, ExportDocument, ExportReadModels };

export interface CapturePorts extends Readonly<Pick<CommonDocumentSession, "read">> {
  readonly readModels: (doc: DocumentView) => ExportReadModels;
  readonly clock: Clock;
}

export const NOTHING_TO_CAPTURE = "There is no document to capture";

export function captureExportDocument(ports: CapturePorts, opts?: ExportCaptureOptions | null): ExportDocument {
  return ports.read(function (doc) {
    if (!doc) throw new Error(NOTHING_TO_CAPTURE);
    return buildExportDocument(doc, ports.clock.nowIso(), ports.readModels(doc), opts);
  });
}
