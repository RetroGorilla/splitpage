import { createLocalFilesOwner } from "../../application/transitions/local-files.js";
import type { LocalFilesOwner, LocalFileOpening } from "../../application/transitions/local-files-ports.ts";
import { createImportSavingOwner } from "../../application/save/import-saving.js";
import type { ImportSavingOwner, ImportSaveRequest } from "../../application/save/import-saving-ports.ts";
import type { DocumentSource } from "../../application/transitions/sources.ts";
import type { SaveDestination } from "../../application/save/destinations.ts";
import { startLocalFileMenu } from "../../features/file-menu/local-files.js";
import type { LocalFileMenuControls } from "../../features/file-menu/local-files-ports.ts";
import { fileWritebackActions as definitions } from "../../features/file-menu/actions.ts";
import type { ActionDefinition } from "../../application/actions.ts";
import type { ResumeHandle } from "../../features/file-menu/mount.ts";
import { localFilesOwnerPorts, importSavingPorts, localFileMenuPorts } from "./ports/local-files.ts";
import { screen } from "./ports/screen.ts";

let opening: LocalFilesOwner | null = null;
let saving: ImportSavingOwner | null = null;
let menu: LocalFileMenuControls | null = null;
let stop: (() => void) | null = null;

export function localFilesOwner(): LocalFilesOwner {
  if (!opening) throw new Error("The local files is not started yet");
  return opening;
}

export function importSavingOwner(): ImportSavingOwner {
  if (!saving) throw new Error("The import saving is not started yet");
  return saving;
}

export function localFileMenuControls(): LocalFileMenuControls {
  if (!menu) throw new Error("The local file menu is not started yet");
  return menu;
}

export function mountLocalFilesFeature(): LocalFileMenuControls {
  stopLocalFilesFeature();
  const files: LocalFilesOwner = createLocalFilesOwner();
  const writeback: ImportSavingOwner = createImportSavingOwner();
  const stopFiles = files.startLocalFiles(localFilesOwnerPorts(localFileMenuControls));
  const stopSaving = writeback.startImportSaving(importSavingPorts(localFileMenuControls));
  const view = startLocalFileMenu(localFileMenuPorts(writeback)) as LocalFileMenuControls;
  opening = files;
  saving = writeback;
  menu = view;
  stop = () => { view.dispose(); stopSaving(); stopFiles(); menu = null; saving = null; opening = null; };
  return view;
}

export function stopLocalFilesFeature(): void {
  const dispose = stop;
  stop = null;
  dispose?.();
}

export function projectFileSource(): DocumentSource<LocalFileOpening> {
  return { id: "project-file", takes: (request) => request.kind === "file", open: (request) => localFilesOwner().projectFileSource().open(request) };
}

export function importSaveDestination(): SaveDestination<ImportSaveRequest> {
  return {
    id: "import",
    takes: (request) => ["writeback", "writebackForce"].indexOf(request.kind) !== -1,
    autoSaveTarget: () => null,
    write: (job) => importSavingOwner().writeBackToFile(job)
  };
}

export function fileWritebackActions(): ActionDefinition[] { return definitions(() => saving, screen); }

export const openLocalFile: LocalFilesOwner["openLocalFile"] = (...args) => localFilesOwner().openLocalFile(...args);
export const tryResumeLastProject: LocalFilesOwner["tryResumeLastProject"] = (...args) => localFilesOwner().tryResumeLastProject(...args);
export const resumeFromHandle: LocalFilesOwner["resumeFromHandle"] = (...args) => localFilesOwner().resumeFromHandle(...args);
export const reloadFileFromDisk: LocalFilesOwner["reloadFileFromDisk"] = (...args) => localFilesOwner().reloadFileFromDisk(...args);
export const reloadProjectFromDisk: LocalFilesOwner["reloadProjectFromDisk"] = (...args) => localFilesOwner().reloadProjectFromDisk(...args);
export const saveBackToFile: ImportSavingOwner["saveBackToFile"] = (...args) => importSavingOwner().saveBackToFile(...args);
export const saveBackItemState: ImportSavingOwner["saveBackItemState"] = (...args) => importSavingOwner().saveBackItemState(...args);
export const buildFileData: LocalFileMenuControls["buildFileData"] = (...args) => localFileMenuControls().buildFileData(...args);
export const exportAs: LocalFileMenuControls["exportAs"] = (...args) => localFileMenuControls().exportAs(...args);
export const exportFileName: LocalFileMenuControls["exportFileName"] = (...args) => localFileMenuControls().exportFileName(...args);
export const exportBaseName: LocalFileMenuControls["exportBaseName"] = (...args) => localFileMenuControls().exportBaseName(...args);
export const exportRequest: LocalFileMenuControls["exportRequest"] = (...args) => localFileMenuControls().exportRequest(...args);
export const runExport: LocalFileMenuControls["runExport"] = (...args) => localFileMenuControls().runExport(...args);
export const runExportAction: LocalFileMenuControls["runExportAction"] = (...args) => localFileMenuControls().runExportAction(...args);
export const handleFileMenuAction: LocalFileMenuControls["handleFileMenuAction"] = (...args) => localFileMenuControls().handleFileMenuAction(...args);
export const onFileMenuChoice: LocalFileMenuControls["onFileMenuChoice"] = (...args) => localFileMenuControls().onFileMenuChoice(...args);
export const noteFileMenuChoice: LocalFileMenuControls["noteFileMenuChoice"] = (...args) => localFileMenuControls().noteFileMenuChoice(...args);
export const hideResumeBanner: LocalFileMenuControls["hideResumeBanner"] = (...args) => localFileMenuControls().hideResumeBanner(...args);
export const updateFileChip: LocalFileMenuControls["updateFileChip"] = (...args) => localFileMenuControls().updateFileChip(...args);
export const mirrorFileChipToWriter: LocalFileMenuControls["mirrorFileChipToWriter"] = (...args) => localFileMenuControls().mirrorFileChipToWriter(...args);
export const fileChipListeners: LocalFileMenuControls["fileChipListeners"] = (...args) => localFileMenuControls().fileChipListeners(...args);
export const showFileConflictView: LocalFileMenuControls["showFileConflictView"] = (...args) => localFileMenuControls().showFileConflictView(...args);
export const pendingHandle = (): ResumeHandle | null => localFileMenuControls().pendingHandle() as ResumeHandle | null;
