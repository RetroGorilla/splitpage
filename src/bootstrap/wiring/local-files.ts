import { createLocalFilesOwner } from "../../application/transitions/local-files.js";
import type { LocalFilesOwner, LocalFileOpening } from "../../application/transitions/local-files-ports.ts";
import { createImportSavingOwner } from "../../application/save/import-saving.ts";
import type { ImportSavingOwner, ImportSaveRequest } from "../../application/save/import-saving-ports.ts";
import type { DocumentSource } from "../../application/transitions/sources.ts";
import type { SaveDestination } from "../../application/save/destinations.ts";
import { startLocalFileMenu } from "../../features/file-menu/local-files.js";
import type { LocalFileMenuControls } from "../../features/file-menu/local-files-ports.ts";
import { localFilesOwnerPorts, importSavingPorts, localFileMenuPorts } from "./ports/local-files.ts";

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
  const view = startLocalFileMenu(localFileMenuPorts()) as LocalFileMenuControls;
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
