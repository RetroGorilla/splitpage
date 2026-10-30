import { closedStamp, createImportCompletion } from "./save-completion.ts";
import type { LocalFileHandle, LocalFileWritable } from "../files/local-file-access.ts";
import type { Home } from "../location/document-location.ts";
import type { SaveJob, WriterResult } from "./coordinator.ts";
import type { SaveDestination } from "./destinations.ts";
import type { BuiltLocalFile, ImportSaveItem, ImportSaveRequest, ImportSavingOwner, ImportSavingPorts } from "./import-saving-ports.ts";

type StartedImportSaving = Omit<ImportSavingOwner, "startImportSaving"> & { readonly dispose: () => void };

function startImportSaving(ports: ImportSavingPorts): StartedImportSaving {
  let active = true;
  async function discardWritable(writable: LocalFileWritable | undefined): Promise<void> {
    if (writable && typeof writable.abort === "function") {
      try { await writable.abort(); } catch (e) {}
    }
  }
  const { importHome, amendHome } = ports.location;
  const { request: requestSave } = ports.saving;
  const completion = createImportCompletion(ports);
  const buildFileData = ports.buildFileData;
  const checkFileConflict = ports.files.checkConflict;
  const deliverFile = ports.delivery.deliver;
  const showToast = ports.notices.show;
function saveBackItemState(): ImportSaveItem {
  const imported = importHome();
  if (!imported) return { hidden: false, disabled: true, reason: "", label: "Save to file" };
  return { hidden: false, disabled: false, reason: "",
           label: imported.inPlace ? "Save to " + (imported.name as string) : "Save a new copy of " + (imported.name as string) };
}

const WRITTEN_BACK: WriterResult = Object.freeze({ kind: "saved" });
const WRITEBACK_FAILED: WriterResult = Object.freeze({ kind: "failed" });
const WRITEBACK_CANCELLED: WriterResult = Object.freeze({ kind: "cancelled" });
const FILE_CHANGED = "The file changed on disk since it was opened";
const NOTHING_IMPORTED: WriterResult = Object.freeze({ kind: "refused", reason: "The document has no imported file to write back to" });
const IMPORT_REPLACED: WriterResult = Object.freeze({ kind: "refused", reason: "The imported file this write back was asked for is no longer open" });

function saveBackToFile(opts?: { force?: boolean }): Promise<void> {
  const imported = importHome();
  if (!imported) return Promise.resolve();
  return requestSave({ kind: opts && opts.force ? "writebackForce" : "writeback", target: imported }).then(function (outcome) {
    if (!active) return;
    if (outcome.kind === "saved" && outcome.acknowledged) completion.acknowledged(imported);
  });
}

function stillWritingBack(job: SaveJob<ImportSaveRequest>, imported: Home): boolean {
  return active && importHome() === imported && job.owns();
}

async function writeBackToFile(job: SaveJob<ImportSaveRequest>): Promise<WriterResult> {
  const imported = importHome();
  if (!imported) return NOTHING_IMPORTED;
  if (job.request.target !== imported || !stillWritingBack(job, imported)) return IMPORT_REPLACED;
  const baseName = (imported.name as string).replace(/\.[^.]+$/, "");
  let built: BuiltLocalFile;
  try {
    built = await buildFileData(imported.format as string, baseName);
  } catch (e) {
    if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
    showToast("Could not build the file.", "error");
    return WRITEBACK_FAILED;
  }
  if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;

  const canWriteInPlace = imported.handle && (imported.handle as LocalFileHandle).createWritable;
  let denied = false;
  if (canWriteInPlace && job.request.kind !== "writebackForce") {
    const check = await checkFileConflict(imported.handle, imported.lastModified);
    if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
    if (!check.ok) {
      if (!("denied" in check)) {
        return { kind: "refused", reason: FILE_CHANGED, conflict: { fileName: imported.name as string, current: check.current, kind: "import" } };
      }
      denied = true;
      amendHome(imported, { inPlace: false });
    }
  }

  if (canWriteInPlace && !denied) {
    let writable: LocalFileWritable | undefined;
    try {
      writable = await ports.files.createWritable(imported.handle);
      if (!stillWritingBack(job, imported)) { await discardWritable(writable); return IMPORT_REPLACED; }
      await writable.write(built.data);
      if (!stillWritingBack(job, imported)) { await discardWritable(writable); return IMPORT_REPLACED; }
      const closed = await writable.close();
      if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
      const stamped = closedStamp(closed);
      if (stamped !== null) {
        completion.landed(imported, { lastModified: stamped, size: null });
      } else {
        try {
          const after = await ports.files.read(imported.handle);
          if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
          completion.landed(imported, after);
        } catch (e) {
          if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
          completion.landedUnread(imported, closed);
        }
      }
      if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
      completion.writtenBack(job.generation);
      showToast("Saved to " + (imported.name as string), "ok");
      return WRITTEN_BACK;
    } catch (err) {
      if (!stillWritingBack(job, imported)) { await discardWritable(writable); return IMPORT_REPLACED; }
      if (err && (err as Error).name === "AbortError") return WRITEBACK_CANCELLED;
      amendHome(imported, { inPlace: false });
    }
  }

  if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
  const ok = await deliverFile(imported.name as string, built.data, {
    savedMsg: "Saved a copy of " + (imported.name as string) + " to your downloads"
  });
  if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
  if (!ok) return WRITEBACK_FAILED;
  completion.writtenBack(job.generation);
  return WRITTEN_BACK;
}

const IMPORT_KINDS: readonly string[] = ["writeback", "writebackForce"];

function importSaveDestination(): SaveDestination<ImportSaveRequest> {
  return {
    id: "import",
    takes: function (request) { return IMPORT_KINDS.indexOf(request.kind) !== -1; },
    autoSaveTarget: function () { return null; },
    write: writeBackToFile
  };
}


  return { saveBackItemState, saveBackToFile, writeBackToFile, importSaveDestination, dispose: function () { active = false; } };
}

export function createImportSavingOwner(): ImportSavingOwner {
  let started: StartedImportSaving | null = null;
  function running(): StartedImportSaving {
    if (!started) throw new Error("The import saving is not started yet");
    return started;
  }
  return {
    startImportSaving: function (ports) {
      if (started) throw new Error("The owner is already started; stop it first");
      const mine = startImportSaving(ports);
      started = mine;
      return function () { if (started === mine) { started = null; mine.dispose(); } };
    },
    saveBackItemState: function (...args: Parameters<StartedImportSaving["saveBackItemState"]>) { return running().saveBackItemState(...args); },
    saveBackToFile: function (...args: Parameters<StartedImportSaving["saveBackToFile"]>) { return running().saveBackToFile(...args); },
    writeBackToFile: function (...args: Parameters<StartedImportSaving["writeBackToFile"]>) { return running().writeBackToFile(...args); },
    importSaveDestination: function (...args: Parameters<StartedImportSaving["importSaveDestination"]>) {
      const mine = running();
      const destination = mine.importSaveDestination(...args);
      return { id: destination.id, takes: function (...args: Parameters<typeof destination.takes>) { if (started !== mine) throw new Error("The import saving is not started yet"); return destination.takes(...args); }, autoSaveTarget: function (...args: Parameters<typeof destination.autoSaveTarget>) { if (started !== mine) throw new Error("The import saving is not started yet"); return destination.autoSaveTarget(...args); }, write: function (...args: Parameters<typeof destination.write>) { if (started !== mine) throw new Error("The import saving is not started yet"); return destination.write(...args); } };
    }
  };
}
