import { flushEdits } from "./12a-undo.js";
import { sanitizeHtml } from "../legacy/richtext.ts";
import { currentDocument, noteAbsorbedDirty, noteReload } from "../legacy/session-bridge.ts";
import { documentTransitions, keepSnapshot } from "../legacy/transition-bridge.ts";
import { autoSavePolicy, confirmSavedNow, fileConflicts, requestSave, unsavedChanges, unsavedFor } from "../legacy/save-bridge.ts";
import { deliverFile } from "../legacy/file-delivery.ts";
import { checkFileConflict } from "../adapters/files/file-target.ts";
import { amendHome, currentHome, fileHome, importHome, serverStatus, setHome } from "../legacy/location-bridge.ts";
import { SCHEMA_VERSION, loadLastFileHandle, rememberLastFileHandle } from "./00-prelude.js";
import {
  standaloneHtmlFor,
  syncDocIdentity
} from "./02b-doc-id.js";
import { stampRow } from "./03-sync.js";
import { beginBusy, endBusy, withBusyBar } from "../features/notices/busy.js";
import { resetProductionPanelState } from "../legacy/production-editing-bridge.ts";
import { brollPrintView } from "./08d-broll-panel.js";
import { formatTimestamp } from "../bootstrap/wiring/comments.ts";
import { captureExportDocument, loadExportAssets } from "./14b-export-kit.js";
import { exportAssetsRequest } from "../adapters/formats/export-assets.ts";
import {
  detectTwoColumnFormat,
  parseImportRows
} from "./11-import.js";
import {
  blobSourceNow,
  onServerDoc
} from "./13-hosted.js";
import { docxToRows } from "../adapters/formats/docx.ts";
import { csvToRows } from "../adapters/formats/csv.ts";
import { normalizeImportedRows } from "../adapters/formats/import-rows.ts";
import { offerFileMerge, resetMergeOffer } from "./18a-local-merge.js";
import { isExportAction, rememberExport } from "./18c-export-dialog.js";
import { parseProjectFileState } from "../adapters/formats/project-file.ts";
import { makeDesktopHandle } from "../adapters/desktop/desktop-handle.ts";
import { sidePanels } from "../legacy/panels-bridge.ts";
import { exportToggleOptions } from "../application/export/registry.ts";
import { appActions } from "../legacy/app-actions.ts";
import { exportFormats } from "../legacy/export-formats.ts";
import { setMenuItemLabel, showToast, warnImagesLeftOut } from "../legacy/effects-bridge.ts";
import { cloneState } from "../core/document/clone.ts";
import { slugify } from "../../shared/text.js";
import { fileKindFromName } from "../../shared/file-names.js";
import { desktopPort } from "../adapters/desktop/desktop-port.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";

export function updateFileChip() {
  updateHeaderFileChip();
  updateReadonlyBanner();
}

export function fileChipListeners(refresh) {
  return {
    session: function (change) {
      if (change.kind === "adopt" || change.kind === "server" || change.kind === "recovery" || change.kind === "reload") refresh();
    },
    location: function (change) {
      if (change !== "writtenOut") refresh();
    },
    status: function (change) {
      if (change !== "bookmarks") refresh();
    },
    save: function (change) {
      if (change === "clean" || change === "halt" || (change === "change" && onServerDoc())) refresh();
    }
  };
}

function updateReadonlyBanner() {
  var banner = document.getElementById("readonly-banner");
  if (!banner) return;
  banner.hidden = !(serverStatus().mode().readOnly && onServerDoc());
}

export function mirrorFileChipToWriter() {
  var src = document.getElementById("file-chip");
  var dst = document.getElementById("wr-file-chip");
  if (!src || !dst) return;
  dst.hidden = src.hidden;
  document.getElementById("wr-file-chip-name").textContent =
    document.getElementById("file-chip-name").textContent;
  var srcState = document.getElementById("file-chip-state");
  var dstState = document.getElementById("wr-file-chip-state");
  dstState.textContent = srcState.textContent;
  dstState.classList.toggle("unsaved", srcState.classList.contains("unsaved"));
}

export function saveBackItemState() {
  var imported = onServerDoc() ? null : importHome();
  if (!imported) return { hidden: false, disabled: true, reason: "", label: "Save to file" };
  return { hidden: false, disabled: false, reason: "",
           label: imported.inPlace ? "Save to " + imported.name : "Save a new copy of " + imported.name };
}

function paintSaveBackItem() {
  var saveBack = document.getElementById("menu-save-back");
  var state = saveBackItemState();
  saveBack.disabled = state.disabled;
  setMenuItemLabel(saveBack, state.label);
}

function updateHeaderFileChip() {
  var chip = document.getElementById("file-chip");
  paintSaveBackItem();
  if (onServerDoc()) {
    chip.hidden = false;
    document.getElementById("file-chip-name").textContent = "On the server";
    var srvState = document.getElementById("file-chip-state");
    var unsaved = unsavedChanges();
    srvState.textContent = serverStatus().sessionExpired()
      ? "· signed out — reload"
      : serverStatus().linkTurnedOff() ? "· link turned off — not saving"
      : unsaved && autoSavePolicy().halted() ? "· not saved yet"
      : (unsaved ? "· saving…" : "· v" + currentHome().rev + ", everyone sees this");
    srvState.classList.toggle("unsaved", serverStatus().sessionExpired() || serverStatus().linkTurnedOff() || unsaved);
    return;
  }
  var imported = importHome();
  if (!imported) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  document.getElementById("file-chip-name").textContent = imported.name;
  var stateEl = document.getElementById("file-chip-state");
  stateEl.textContent = imported.dirty ? "· unsaved changes" : "· up to date";
  stateEl.classList.toggle("unsaved", !!imported.dirty);
}

export function exportFileName(kind, baseName, opts) {
  var exporter = exportFormats.byId(kind);
  return exporter ? exporter.fileName(baseName, opts || {}) : baseName + "." + kind;
}

export function exportBaseName() {
  return importHome() ? importHome().name.replace(/\.[^.]+$/, "") : slugify(currentDocument().title);
}

export function exportRequest(kind, opts) {
  opts = opts || {};
  var exporter = exportFormats.byId(kind) || exportFormats.byId("md");
  var doc = captureExportDocument();
  return Object.freeze({
    kind: kind,
    doc: doc,
    options: Object.freeze(Object.assign(exportToggleOptions(exportFormats, exporter, opts), {
      allowImageBundle: !!opts.allowImageBundle,
      brollView: Object.freeze(brollPrintView(opts.brollView))
    })),
    assets: exportAssetsRequest(doc, blobSourceNow())
  });
}

export async function buildFileData(kind, baseName, opts) {
  var request = exportRequest(kind, opts);
  var registered = exportFormats.byId(kind);
  var exporter = registered || exportFormats.byId("md");
  var assets = await loadExportAssets(request.assets);
  var made = await exporter.build({
    doc: request.doc,
    options: request.options,
    assets: assets,
    ports: { standaloneHtml: standaloneHtmlFor }
  }, baseName);
  var filename = registered
    ? exporter.fileName(baseName, { imageBundle: !!made.imageBundle })
    : baseName + "." + kind;
  if (made.diagnostics) warnImagesLeftOut(made.diagnostics.imagesLeftOut, filename);
  return { data: made.data, filename: filename };
}

export function projectFileSource() {
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

export var pendingResumeHandle = null;

export async function tryResumeLastProject() {
  var handle = await loadLastFileHandle();
  if (!handle) return;
  var perm;
  try {
    perm = await handle.queryPermission({ mode: "readwrite" });
  } catch (e) {
    return;
  }
  if (perm === "granted") {
    await resumeFromHandle(handle);
  } else if (perm === "prompt") {
    showResumeBanner(handle);
  }
}

export async function resumeFromHandle(handle) {
  try {
    var file = await handle.getFile();
    await openProjectFile(file, handle, { skipSnapshot: !unsavedChanges(), resumed: true });
  } catch (e) {
  }
}

function showResumeBanner(handle) {
  pendingResumeHandle = handle;
  var banner = document.getElementById("resume-banner");
  document.getElementById("resume-banner-text").textContent =
    " " + (handle.name || "your last project") + " needs a click to reopen.";
  banner.hidden = false;
}

export function hideResumeBanner() {
  pendingResumeHandle = null;
  document.getElementById("resume-banner").hidden = true;
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
      newRows = csvToRows(await file.text());
    } else {
      var text = await file.text();
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

export async function openLocalFile() {
  if (runningOnDesktop()) {
    var entry = await desktopPort().openFileDialog();
    if (!entry) return;
    var r = await desktopPort().routeOpen({ kind: "file", fileId: entry.id });
    if (!r || r.where !== "this-tab") return;
    var desktopHandle = makeDesktopHandle(entry);
    var desktopFile = await desktopHandle.getFile();
    await openProjectFile(desktopFile, desktopHandle);
    return;
  }
  if (window.showOpenFilePicker) {
    try {
      var handles = await window.showOpenFilePicker({
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
      await openProjectFile(await handle.getFile(), handle);
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  document.getElementById("open-file-input").click();
}

var fileConflictShowToken = 0;

function fileConflictHome(conflict) {
  return conflict.kind === "project" ? fileHome() : importHome();
}

var WRITTEN_BACK = Object.freeze({ kind: "saved" });
var WRITEBACK_FAILED = Object.freeze({ kind: "failed" });
var WRITEBACK_CANCELLED = Object.freeze({ kind: "cancelled" });
var FILE_CHANGED = "The file changed on disk since it was opened";
var NOTHING_IMPORTED = Object.freeze({ kind: "refused", reason: "The document has no imported file to write back to" });
var IMPORT_REPLACED = Object.freeze({ kind: "refused", reason: "The imported file this write back was asked for is no longer open" });

export function saveBackToFile(opts) {
  var imported = importHome();
  if (!imported) return Promise.resolve();
  return requestSave({ kind: opts && opts.force ? "writebackForce" : "writeback", target: imported }).then(function (outcome) {
    if (outcome.kind === "saved" && outcome.acknowledged) amendHome(imported, { dirty: unsavedFor(imported) });
  });
}

function stillWritingBack(job, imported) {
  return importHome() === imported && job.owns();
}

export async function writeBackToFile(job) {
  var imported = importHome();
  if (!imported) return NOTHING_IMPORTED;
  if (job.request.target !== imported || !stillWritingBack(job, imported)) return IMPORT_REPLACED;
  var baseName = imported.name.replace(/\.[^.]+$/, "");
  var built;
  try {
    built = await buildFileData(imported.format, baseName);
  } catch (e) {
    showToast("Could not build the file.", "error");
    return WRITEBACK_FAILED;
  }
  if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;

  if (imported.handle && imported.handle.createWritable) {
    if (job.request.kind !== "writebackForce") {
      var check = await checkFileConflict(imported.handle, imported.lastModified);
      if (!check.ok) {
        return { kind: "refused", reason: FILE_CHANGED, conflict: { fileName: imported.name, current: check.current, kind: "import" } };
      }
      if (!stillWritingBack(job, imported)) return IMPORT_REPLACED;
    }
    try {
      var writable = await imported.handle.createWritable();
      await writable.write(built.data);
      await writable.close();
      try {
        var after = await imported.handle.getFile();
        amendHome(imported, { lastModified: after.lastModified, size: after.size });
      } catch (e) { }
      showToast("Saved to " + imported.name, "ok");
      return WRITTEN_BACK;
    } catch (err) {
      if (err && err.name === "AbortError") return WRITEBACK_CANCELLED;
      amendHome(imported, { inPlace: false });
    }
  }

  var ok = await deliverFile(imported.name, built.data, {
    savedMsg: "Saved a copy of " + imported.name + " to your downloads"
  });
  return ok ? WRITTEN_BACK : WRITEBACK_FAILED;
}

var IMPORT_KINDS = ["writeback", "writebackForce"];

export function importSaveDestination() {
  return {
    id: "import",
    takes: function (request) { return IMPORT_KINDS.indexOf(request.kind) !== -1; },
    autoSaveTarget: function () { return null; },
    write: writeBackToFile
  };
}

export function showFileConflictView(conflict) {
  if (!conflict) {
    hideFileConflictView();
    return;
  }
  var fileName = conflict.fileName;
  var currentFile = conflict.current;
  if (!currentFile) {
    document.getElementById("file-conflict-detail").textContent =
      "Could not check whether " + fileName + " is still there — it may have been moved, " +
      "deleted, or is on a drive that isn't connected right now. Saving now would recreate it.";
    resetMergeOffer();
    document.getElementById("file-conflict-modal").hidden = false;
    return;
  }
  var when = currentFile.lastModified
    ? formatTimestamp(new Date(currentFile.lastModified).toISOString())
    : "recently";
  document.getElementById("file-conflict-detail").textContent =
    fileName + " changed on disk at " + when +
    ", after you opened it here. Saving now would overwrite that version.";
  var token = ++fileConflictShowToken;
  var show = function () {
    if (token !== fileConflictShowToken) return;
    document.getElementById("file-conflict-modal").hidden = false;
  };
  var probe = offerFileMerge(currentFile, fileConflictHome(conflict));
  var timer = setTimeout(show, 1500);
  probe.then(function () { clearTimeout(timer); show(); },
             function () { clearTimeout(timer); show(); });
}

function hideFileConflictView() {
  fileConflictShowToken++;
  document.getElementById("file-conflict-modal").hidden = true;
  resetMergeOffer();
}

export async function reloadFileFromDisk() {
  fileConflicts().close();
  var imported = importHome();
  if (!imported || !imported.handle) return;
  try {
    keepSnapshot("Before reloading " + imported.name + " from disk");
    await loadFileIntoEditor(await imported.handle.getFile(), imported.handle, { reload: true });
  } catch (e) {
    showToast("Could not re-read that file.", "error");
  }
}

export async function reloadProjectFromDisk() {
  fileConflicts().close();
  var file = fileHome();
  if (!file || !file.handle) return;
  try {
    await openProjectFile(await file.handle.getFile(), file.handle);
  } catch (e) {
    showToast("Could not re-read that file.", "error");
  }
}

export async function exportAs(kind, more) {
  var base = exportBaseName();
  var built;
  try {
    built = await withBusyBar("Building the " + kind.toUpperCase() + " file…", function () {
      return buildFileData(kind, base, Object.assign({ allowImageBundle: true }, more));
    });
  } catch (e) {
    showToast("Could not build the " + kind.toUpperCase() + " file.", "error");
    return;
  }
  await deliverFile(built.filename, built.data, { savedMsg: "Exported " + built.filename });
}

export async function runExport(action) {
  var exporter = exportFormats.byAction(action);
  if (!exporter) return false;
  var why = exporter.reason ? exporter.reason(captureExportDocument()) : "";
  if (why) {
    showToast(exporter.refusal || why + ".", "warn");
    return false;
  }
  await exportAs(exporter.id, exporter.defaults);
  return true;
}

var fileMenuChoiceListeners = [];

export function onFileMenuChoice(listener) {
  fileMenuChoiceListeners.push(listener);
}

export function noteFileMenuChoice(action) {
  fileMenuChoiceListeners.forEach(function (listener) { listener(action); });
}

export function runExportAction(action) {
  if (!exportFormats.isAction(action)) return false;
  handleFileMenuAction(action, "command-menu");
  return true;
}

export function handleFileMenuAction(action, source) {
  noteFileMenuChoice(action);
  if (action !== "autosave" && action !== "toggle-hide-shot" && action !== "toggle-rundown-min") appActions.invoke("close-file-menu", "button");
  if (isExportAction(action)) rememberExport(action);
  if (appActions.has(action)) {
    appActions.invoke(action, source || "menu");
    return;
  }
  if (!currentDocument()) {
    showToast("Still loading…", "warn"); return;
  }
  if (exportFormats.isAction(action)) runExport(action);
}

export function __init() {}
