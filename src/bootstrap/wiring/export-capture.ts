import type { ExportKit } from "../../application/save/export-kit.ts";
import type { ExportCaptureOptions, ExportDocument } from "../../core/document/export-document.ts";
import type { ExportAssetRequest, ExportAssets } from "../../application/export/assets.ts";

let started: ExportKit | null = null;

function running(): ExportKit {
  if (!started) throw new Error("The export kit is not started yet");
  return started;
}

export function startExportKit(owner: ExportKit): () => void {
  if (started) throw new Error("The export kit is already started; stop it first");
  started = owner;
  return () => { if (started === owner) started = null; };
}

export function exportKitStarted(): boolean { return started !== null; }

export function captureExportDocument(opts?: ExportCaptureOptions | null): ExportDocument {
  return running().captureExportDocument(opts);
}

export function exportDocumentOf(state: unknown, opts?: ExportCaptureOptions | null): ExportDocument {
  return running().exportDocumentOf(state, opts);
}

export function loadExportAssets(request: ExportAssetRequest): Promise<ExportAssets> {
  return running().loadExportAssets(request);
}
