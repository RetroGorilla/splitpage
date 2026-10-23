import type { ExportCaptureOptions } from "../../core/document/export-document.ts";
import type { FileMenuExportMount } from "../../features/file-menu/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import type { Owned } from "../../features/routing/owned.ts";

const ownFileMenuExport: () => Owned<FileMenuExportMount> = owned;

export const fileMenuExport = ownFileMenuExport();

function current(): FileMenuExportMount {
  const owner = fileMenuExport.owner();
  if (!owner) throw new Error("The export dialog is not mounted");
  return owner;
}

export function captureExportDocument(options?: ExportCaptureOptions) { return current().captureExportDocument(options); }
export function exportFormatList() { return current().exportFormatList(); }
export function exportActionName(action: string) { return current().exportActionName(action); }
export function isExportAction(action: unknown) { return current().isExportAction(action); }
export function lastExportAction() { return current().lastExportAction(); }
export function rememberExport(action: string) { current().rememberExport(action); }
export function exportActionReason(action: string) { return current().exportActionReason(action); }
export function exportSummary(action: string) { return current().exportSummary(action); }
export function exportFileNameFor(action: string) { return current().exportFileNameFor(action); }
export function exportDialogOpen() { return fileMenuExport.owner()?.exportDialogOpen() ?? false; }
export function openExportDialog(options?: { action?: string }) { return current().openExportDialog(options); }
export function closeExportDialog() { fileMenuExport.owner()?.closeExportDialog(); }
export function exportAgain() { current().exportAgain(); }
export function exportAgainItemState() { return current().exportAgainItemState(); }
