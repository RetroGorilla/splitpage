function startImportSaving(ports) {
  var active = true;
  async function discardWritable(writable) {
    if (writable && typeof writable.abort === "function") {
      try { await writable.abort(); } catch (e) {}
    }
  }
  var { importHome, amendHome } = ports.location;
  var { request: requestSave, unsavedFor } = ports.saving;
  var buildFileData = ports.buildFileData;
  var checkFileConflict = ports.files.checkConflict;
  var deliverFile = ports.delivery.deliver;
  var showToast = ports.notices.show;
function saveBackItemState() {
  var imported = importHome();
  if (!imported) return { hidden: false, disabled: true, reason: "", label: "Save to file" };
  return { hidden: false, disabled: false, reason: "",
           label: imported.inPlace ? "Save to " + imported.name : "Save a new copy of " + imported.name };
}

var WRITTEN_BACK = Object.freeze({ kind: "saved" });
var WRITEBACK_FAILED = Object.freeze({ kind: "failed" });
var WRITEBACK_CANCELLED = Object.freeze({ kind: "cancelled" });
var FILE_CHANGED = "The file changed on disk since it was opened";
var NOTHING_IMPORTED = Object.freeze({ kind: "refused", reason: "The document has no imported file to write back to" });
var IMPORT_REPLACED = Object.freeze({ kind: "refused", reason: "The imported file this write back was asked for is no longer open" });

function saveBackToFile(opts) {
  var imported = importHome();
  if (!imported) return Promise.resolve();
  return requestSave({ kind: opts && opts.force ? "writebackForce" : "writeback", target: imported }).then(function (outcome) {
    if (!active) return;
    if (outcome.kind === "saved" && outcome.acknowledged) amendHome(imported, { dirty: unsavedFor(imported) });
  });
}

function stillWritingBack(job, imported) {
  return active && importHome() === imported && job.owns();
}

async function writeBackToFile(job) {
  var imported = importHome();
  if (!imported) return NOTHING_IMPORTED;
  if (job.request.target !== imported || !stillWritingBack(job, imported)) return IMPORT_REPLACED;
  var baseName = imported.name.replace(/\.[^.]+$/, "");
  var built;
  try {
    built = await buildFileData(imported.format, baseName);
  } catch (e) {
    if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
    showToast("Could not build the file.", "error");
    return WRITEBACK_FAILED;
  }
  if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;

  if (imported.handle && imported.handle.createWritable) {
    if (job.request.kind !== "writebackForce") {
      var check = await checkFileConflict(imported.handle, imported.lastModified);
      if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
      if (!check.ok) {
        return { kind: "refused", reason: FILE_CHANGED, conflict: { fileName: imported.name, current: check.current, kind: "import" } };
      }
    }
    try {
      var writable = await ports.files.createWritable(imported.handle);
      if (!stillWritingBack(job, imported)) { await discardWritable(writable); return IMPORT_REPLACED; }
      await writable.write(built.data);
      if (!stillWritingBack(job, imported)) { await discardWritable(writable); return IMPORT_REPLACED; }
      await writable.close();
      if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
      try {
        var after = await ports.files.read(imported.handle);
        if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
        amendHome(imported, { lastModified: after.lastModified, size: after.size });
      } catch (e) { }
      if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
      showToast("Saved to " + imported.name, "ok");
      return WRITTEN_BACK;
    } catch (err) {
      if (!stillWritingBack(job, imported)) { await discardWritable(writable); return IMPORT_REPLACED; }
      if (err && err.name === "AbortError") return WRITEBACK_CANCELLED;
      amendHome(imported, { inPlace: false });
    }
  }

  if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
  var ok = await deliverFile(imported.name, built.data, {
    savedMsg: "Saved a copy of " + imported.name + " to your downloads"
  });
  if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
  return ok ? WRITTEN_BACK : WRITEBACK_FAILED;
}

var IMPORT_KINDS = ["writeback", "writebackForce"];

function importSaveDestination() {
  return {
    id: "import",
    takes: function (request) { return IMPORT_KINDS.indexOf(request.kind) !== -1; },
    autoSaveTarget: function () { return null; },
    write: writeBackToFile
  };
}


  return { saveBackItemState, saveBackToFile, writeBackToFile, importSaveDestination, dispose: function () { active = false; } };
}

export function createImportSavingOwner() {
  var started = null;
  function running() {
    if (!started) throw new Error("The import saving is not started yet");
    return started;
  }
  return {
    startImportSaving: function (ports) {
      if (started) throw new Error("The owner is already started; stop it first");
      var mine = startImportSaving(ports);
      started = mine;
      return function () { if (started === mine) { started = null; mine.dispose(); } };
    },
    saveBackItemState: function (...args) { return running().saveBackItemState(...args); },
    saveBackToFile: function (...args) { return running().saveBackToFile(...args); },
    writeBackToFile: function (...args) { return running().writeBackToFile(...args); },
    importSaveDestination: function (...args) {
      var mine = running();
      var destination = mine.importSaveDestination(...args);
      return { id: destination.id, takes: function (...args) { if (started !== mine) throw new Error("The import saving is not started yet"); return destination.takes(...args); }, autoSaveTarget: function (...args) { if (started !== mine) throw new Error("The import saving is not started yet"); return destination.autoSaveTarget(...args); }, write: function (...args) { if (started !== mine) throw new Error("The import saving is not started yet"); return destination.write(...args); } };
    }
  };
}
