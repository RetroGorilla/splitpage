import { SCHEMA_VERSION } from "../../core/document/fields.ts";
import { cloneState } from "../../core/document/clone.ts";
import { fileKindFromName } from "../../../shared/file-names.js";

function startLocalFiles(ports) {
  var currentDocument = ports.document.current;
  var { noteAbsorbedDirty, noteReload } = ports.session;
  var documentTransitions = function () { return ports.transitions; };
  var keepSnapshot = ports.history.keep;
  var confirmSavedNow = ports.saving.confirmSavedNow;
  var unsavedChanges = ports.saves.unsaved;
  var fileConflicts = function () { return ports.conflicts; };
  var { amendHome, setHome, fileHome, importHome } = ports.location;
  var { load: loadLastFileHandle, remember: rememberLastFileHandle } = ports.lastFile;
  var syncDocIdentity = ports.syncIdentity;
  var stampRow = ports.stamps.stampRow;
  var { begin: beginBusy, end: endBusy } = ports.notices.busy;
  var showToast = ports.notices.show;
  var resetProductionPanelState = ports.resetProductionPanel;
  var sidePanels = function () { return ports.panels; };
  var flushEdits = ports.undo.flush;
  var { detectTwoColumnFormat, parseImportRows, docxToRows, csvToRows, normalizeImportedRows, parseProjectFileState } = ports.imports;
  var sanitizeHtml = ports.text.sanitizeHtml;
  var showResumeBanner = ports.resumeNeeded;
  var runningOnDesktop = ports.desktop.running;
  var desktopPort = function () { return ports.desktop; };
  var makeDesktopHandle = ports.files.desktopHandle;
function projectFileSource() {
  return {
    id: "project-file",
    takes: function (opening) { return opening.kind === "file"; },
    open: function (opening) {
      var parsed = opening.parsed;
      if (parsed) return adoptProjectState(parsed.state, opening.file, opening.handle || null, parsed.kind, opening.options);
      return openProjectFile(opening.file, opening.handle || null, opening.options);
    }
  };
}

async function openProjectFile(file, handle, opts) {
  opts = opts || {};
  var parsed = await parseProjectFileState(file);
  if (!parsed) return loadFileIntoEditor(file, handle);
  if (parsed.error === "unreadable") {
    showToast("Could not read " + file.name + ".", "error");
    return false;
  }
  if (parsed.error === "not-splitpage") {
    showToast(file.name + " doesn't look like a Splitpage file.", "error");
    return false;
  }
  return adoptProjectState(parsed.state, file, handle, parsed.kind, opts);
}

function adoptProjectState(newState, file, handle, kind, opts) {
  opts = opts || {};
  sidePanels().close("newtab-page");

  resetProductionPanelState();
  documentTransitions().open({
    from: { document: newState },
    reason: "adoptProjectState: the project file as it was just read",
    keep: opts.skipSnapshot ? undefined : "Before opening " + file.name,
    destination: { kind: "file", fields: { handle: handle || null, format: kind, lastModified: file.lastModified || null,
                                           name: file.name, diskBase: cloneState(newState) } },
    writtenOut: true
  });

  confirmSavedNow();
  var commentNote = currentDocument().comments.length
    ? ", " + currentDocument().comments.length + " comment" + (currentDocument().comments.length === 1 ? "" : "s") : "";
  if (!opts.silent) showToast((opts.resumed ? "Resumed " : "Opened ") + (currentDocument().title || file.name) + " — " +
    currentDocument().rows.length + " row" + (currentDocument().rows.length === 1 ? "" : "s") + commentNote, "ok");

  if (handle) rememberLastFileHandle(handle);
  return true;
}

async function tryResumeLastProject() {
  var handle = await loadLastFileHandle();
  if (!handle) return;
  var perm;
  try {
    perm = await ports.files.permission(handle, { mode: "readwrite" });
  } catch (e) {
    return;
  }
  if (perm === "granted") {
    await resumeFromHandle(handle);
  } else if (perm === "prompt") {
    showResumeBanner(handle);
  }
}

async function resumeFromHandle(handle) {
  try {
    var file = await ports.files.read(handle);
    await openProjectFile(file, handle, { skipSnapshot: !unsavedChanges(), resumed: true });
  } catch (e) {
  }
}

async function loadFileIntoEditor(file, handle, opts) {
  opts = opts || {};
  var kind = fileKindFromName(file.name);
  if (kind === "splitpage" || kind === "html") kind = null;
  if (!kind) { showToast("That file type isn't supported — try .docx, .md, .txt or .csv.", "warn"); return; }

  var newRows, newTitle = null;
  var readBusy = beginBusy("Reading " + file.name + "…");
  try {
    if (kind === "docx") {
      var parsed = await docxToRows(file);
      newTitle = parsed.title;
      newRows = parsed.rows;
      if (!newRows.length && parsed.looseText) {
        var looseMode = detectTwoColumnFormat(parsed.looseText) ? "twocolumn" : "paragraph";
        newRows = normalizeImportedRows(parseImportRows(parsed.looseText, looseMode), sanitizeHtml);
      }
    } else if (kind === "csv") {
      newRows = csvToRows(await ports.files.text(file));
    } else {
      var text = await ports.files.text(file);
      var mode = detectTwoColumnFormat(text) ? "twocolumn" : "paragraph";
      newRows = normalizeImportedRows(parseImportRows(text, mode), sanitizeHtml);
      var firstHeading = /^#\s+(.+)$/m.exec(text);
      if (firstHeading) newTitle = firstHeading[1].trim();
    }
  } catch (err) {
    var msg = "Could not read that file.";
    if (err && err.message === "no-decompression-stream") msg = "This browser can't unzip .docx files — try Chrome or Edge.";
    else if (err && (err.message === "not-a-zip" || err.message === "no-document-xml")) msg = "That doesn't look like a Word document.";
    showToast(msg, "error");
    return;
  } finally {
    endBusy(readBusy);
  }

  if (!newRows || !newRows.length) { showToast("No scenes found in that file.", "warn"); return; }


  newRows.forEach(stampRow);
  var openedTitle = newTitle || file.name.replace(/\.[^.]+$/, "");
  if (opts.reload) {
    flushEdits();
    noteReload({ title: openedTitle, rows: newRows });
  }
  var importFields = {
    name: file.name,
    handle: handle || null,
    format: kind,
    inPlace: !!(handle && handle.createWritable),
    dirty: false,
    lastModified: file.lastModified || null,
    size: file.size || null
  };
  if (opts.reload) {
    setHome("import", importFields);
  } else {
    resetProductionPanelState();
    documentTransitions().open({
      from: { raw: { schema: SCHEMA_VERSION, title: openedTitle, rows: newRows } },
      reason: "loadFileIntoEditor: the imported document as it was just read",
      keep: "Before opening " + file.name,
      destination: { kind: "import", fields: importFields },
      writtenOut: false
    });
  }
  var imported = importHome();

  noteAbsorbedDirty(opts.reload ? "reload" : "adopt");
  amendHome(imported, { dirty: false });
  sidePanels().close("newtab-page");
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  showToast(opts.reload
    ? "Reloaded " + file.name + " — " + newRows.length + " row" + (newRows.length === 1 ? "" : "s")
    : "Opened " + file.name + " — " + newRows.length + " row" + (newRows.length === 1 ? "" : "s") +
      " — as a new document", "ok");
}

async function openLocalFile() {
  if (runningOnDesktop()) {
    var entry = await desktopPort().openFileDialog();
    if (!entry) return;
    var r = await desktopPort().routeOpen({ kind: "file", fileId: entry.id });
    if (!r || r.where !== "this-tab") return;
    var desktopHandle = makeDesktopHandle(entry);
    var desktopFile = await ports.files.read(desktopHandle);
    await openProjectFile(desktopFile, desktopHandle);
    return;
  }
  if (ports.files.openPicker) {
    try {
      var handles = await ports.files.openPicker({
        multiple: false,
        types: [{
          description: "Scripts and documents",
          accept: {
            "application/json": [".splitpage"],
            "text/html": [".html", ".htm"],
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
            "text/markdown": [".md"],
            "text/plain": [".txt"],
            "text/csv": [".csv"]
          }
        }]
      });
      var handle = handles[0];
      await openProjectFile(await ports.files.read(handle), handle);
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  ports.chooseFallback();
}

async function reloadFileFromDisk() {
  fileConflicts().close();
  var imported = importHome();
  if (!imported || !imported.handle) return;
  try {
    keepSnapshot("Before reloading " + imported.name + " from disk");
    await loadFileIntoEditor(await ports.files.read(imported.handle), imported.handle, { reload: true });
  } catch (e) {
    showToast("Could not re-read that file.", "error");
  }
}

async function reloadProjectFromDisk() {
  fileConflicts().close();
  var file = fileHome();
  if (!file || !file.handle) return;
  try {
    await openProjectFile(await ports.files.read(file.handle), file.handle);
  } catch (e) {
    showToast("Could not re-read that file.", "error");
  }
}


  return { projectFileSource, tryResumeLastProject, resumeFromHandle, openLocalFile, reloadFileFromDisk, reloadProjectFromDisk, dispose: function () {} };
}

export function createLocalFilesOwner() {
  var started = null;
  function running() {
    if (!started) throw new Error("The local files is not started yet");
    return started;
  }
  return {
    startLocalFiles: function (ports) {
      if (started) throw new Error("The owner is already started; stop it first");
      var mine = startLocalFiles(ports);
      started = mine;
      return function () { if (started === mine) { started = null; mine.dispose(); } };
    },
    projectFileSource: function (...args) {
      var mine = running();
      var source = mine.projectFileSource(...args);
      return { id: source.id, takes: function (...args) { if (started !== mine) throw new Error("The local files is not started yet"); return source.takes(...args); }, open: function (...args) { if (started !== mine) throw new Error("The local files is not started yet"); return source.open(...args); } };
    },
    tryResumeLastProject: function (...args) { return running().tryResumeLastProject(...args); },
    resumeFromHandle: function (...args) { return running().resumeFromHandle(...args); },
    openLocalFile: function (...args) { return running().openLocalFile(...args); },
    reloadFileFromDisk: function (...args) { return running().reloadFileFromDisk(...args); },
    reloadProjectFromDisk: function (...args) { return running().reloadProjectFromDisk(...args); }
  };
}
