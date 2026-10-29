import type { ProjectFileOpeningPort, ProjectFileSavePort, ProjectFilesPorts } from "../../../application/save/project-files.ts";
import { captureExportDocument, exportDocumentOf } from "../export-capture.ts";
import { amendHome } from "../../../legacy/location-bridge.ts";
import { stashLocalWork } from "../recovery-owners.ts";
import { autoSavePolicy, autoSaveTarget, flushAutoSave, saveDoc, toggleAutoSave } from "../../../legacy/save-bridge.ts";
import { heldDocument } from "../../../legacy/session-bridge.ts";
import { openDocument } from "../../../legacy/transition-bridge.ts";
import { migrateRows } from "../../../legacy/document-ports.ts";
import { place } from "./location.ts";

export const projectFileLocation: ProjectFilesPorts["location"] = { writtenOut: place.writtenOut, fileHome: place.fileHome, amendHome };
export const projectFileDocument: Pick<ProjectFilesPorts, "heldDocument" | "entry"> = { heldDocument, entry: migrateRows };
export const projectFileExports: ProjectFilesPorts["exports"] = { captureExportDocument, exportDocumentOf };
export const projectFileRecovery: ProjectFilesPorts["recovery"] = { stash: stashLocalWork };
export const projectFileSaving: ProjectFileSavePort = { save: saveDoc, autoSave: autoSavePolicy, target: autoSaveTarget, toggle: toggleAutoSave, flush: flushAutoSave };
export const projectFileOpening: ProjectFileOpeningPort = { open: openDocument };
