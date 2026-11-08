import type { LocalFilesOwnerPorts } from "../../../application/transitions/local-files-ports.ts";
import type { LocalFileMenuPorts, LocalFileMenuControls } from "../../../features/file-menu/local-files-ports.ts";
import type { ImportSavingPorts } from "../../../application/save/import-saving-ports.ts";
import type { LocalFileAccess } from "../../../application/files/local-file-access.ts";
import { localFileAccess } from "../../../adapters/files/local-files.ts";
import { loadLastFileHandle, rememberLastFileHandle } from "../../../adapters/files/last-file.ts";
import { detectTwoColumnFormat, parseImportRows } from "../../../adapters/formats/import-text.ts";
import { docxToRows } from "../../../adapters/formats/docx.ts";
import { csvToRows } from "../../../adapters/formats/csv.ts";
import { normalizeImportedRows } from "../../../adapters/formats/import-rows.ts";
import { parseProjectFileState } from "../../../adapters/formats/project-file.ts";
import { exportAssetsRequest } from "../../../adapters/formats/export-assets.ts";
import { standaloneHtmlFor } from "../../../adapters/page/standalone-html.ts";
import { desktopPort } from "../../../adapters/desktop/desktop-port.ts";
import { presence } from "./desktop-presence.ts";
import { noteAbsorbedDirty, noteReload } from "../session-owner.ts";
import { amendHome, fileHome, importHome, setHome } from "../location-owner.ts";
import { unsavedFor, requestSave } from "../save-owners.ts";
import { warnImagesLeftOut } from "../effects-owner.ts";
import { documentIdentity } from "./document-identity-controls.ts";
import { stampRow } from "../session-merge.ts";
import { captureExportDocument, loadExportAssets } from "../export-capture.ts";
import { offerFileMerge, resetMergeOffer } from "../merge-review.ts";
import { isExportAction, rememberExport } from "../file-menu-export-controls.ts";
import { documentReader } from "./document.ts";
import { notices } from "./effects.ts";
import { exports as formats, fileDelivery } from "./files.ts";
import { place } from "./location.ts";
import { confirmation, saves, fileConflicts } from "./saving.ts";
import { transitions, history } from "./transitions.ts";
import { panelControl } from "./panels.ts";
import { brollView, preferenceValues } from "./preferences.ts";
import { resetProductionPanel } from "./production.ts";
import { text } from "./text.ts";
import { undoControl } from "./editing.ts";
import { actions } from "./actions.ts";
import { pdfPrinter, printDialog } from "./printing.ts";
import { exportBrowserPdf } from "../../../features/file-menu/browser-pdf.ts";
import { exportDesktopPdf } from "../../../features/file-menu/desktop-pdf.ts";
import { exportScriptWithFiles } from "../gallery.ts";

export function localFilesOwnerPorts(menu: () => LocalFileMenuControls): LocalFilesOwnerPorts {
  const files: LocalFileAccess = localFileAccess(window);
  return {
    document: documentReader,
    session: { noteAbsorbedDirty, noteReload: (content) => { noteReload(content as Parameters<typeof noteReload>[0]); } },
    transitions,
    history,
    saving: confirmation,
    saves,
    conflicts: fileConflicts,
    location: { amendHome, setHome, fileHome, importHome },
    lastFile: { load: loadLastFileHandle, remember: rememberLastFileHandle },
    syncIdentity: () => { documentIdentity.syncDocIdentity(); },
    stamps: { stampRow },
    notices,
    resetProductionPanel,
    panels: panelControl,
    undo: undoControl,
    imports: {
      parseProjectFileState: (file) => parseProjectFileState(file as Parameters<typeof parseProjectFileState>[0]),
      detectTwoColumnFormat,
      parseImportRows,
      docxToRows: (file) => docxToRows(file as Parameters<typeof docxToRows>[0]),
      csvToRows,
      normalizeImportedRows: (rows, sanitize) => normalizeImportedRows(rows as Parameters<typeof normalizeImportedRows>[0], sanitize)
    },
    text,
    resumeNeeded: (handle) => { menu().showResumeBanner(handle); },
    desktop: {
      running: presence.running,
      openFileDialog: () => requireDesktop().openFileDialog(),
      routeOpen: (request) => requireDesktop().routeOpen(request)
    },
    files,
    chooseFallback: () => { (document.getElementById("open-file-input") as HTMLInputElement).click(); }
  };
}

export function importSavingPorts(menu: () => LocalFileMenuControls): ImportSavingPorts {
  return {
    location: { importHome, amendHome },
    saving: { request: (request) => requestSave(request as Parameters<typeof requestSave>[0]), unsavedFor },
    buildFileData: (kind, base) => menu().buildFileData(kind, base),
    files: localFileAccess(window),
    delivery: fileDelivery,
    notices
  };
}

export function localFileMenuPorts(menu: () => LocalFileMenuControls): LocalFileMenuPorts {
  return {
    document: documentReader,
    preferences: preferenceValues,
    place,
    exports: { captureExportDocument, loadExportAssets },
    formats,
    assets: { request: exportAssetsRequest },
    standaloneHtml: standaloneHtmlFor,
    imagesLeftOut: warnImagesLeftOut,
    brollView,
    notices,
    delivery: fileDelivery,
    scriptFiles: { export: exportScriptWithFiles },
    merge: { offer: offerFileMerge, reset: resetMergeOffer },
    pdfPrint: { export: (kind, options, alive) => exportBrowserPdf({
      exports: { captureExportDocument, loadExportAssets }, formats, assets: { request: exportAssetsRequest },
      brollView, notices, desktop: presence.running, printDialog
    }, kind, options, alive) ?? exportDesktopPdf({
      exports: { captureExportDocument, loadExportAssets }, formats, assets: { request: exportAssetsRequest },
      brollView, notices, delivery: fileDelivery, desktop: presence.running, pdfPrinter,
      baseName: () => menu().exportBaseName()
    }, kind, options, alive) },
    exportControls: { isExportAction, rememberExport },
    actions
  };
}

function requireDesktop(): NonNullable<ReturnType<typeof desktopPort>> {
  const port = desktopPort();
  if (!port) throw new Error("The desktop is unavailable");
  return port;
}
