import { formatTimestamp } from "../common/comment-time.js";
import { exportToggleOptions } from "../../application/export/registry.ts";
import { unshownCharactersText } from "../../application/export/diagnostics.ts";
import { slugify } from "../../../shared/text.js";

var mounted = null;

function mountLocalFileMenu(next) {
var ports = next;
var active = true;
var conflictTimers = new Set();

function running() {
  if (!active) throw new Error("The local file menu is not started yet");
  return ports;
}

function currentDocument(...args) { return running().document.current(...args); }
function preferences() { return running().preferences; }
function importHome(...args) { return running().place.importHome(...args); }
function fileHome(...args) { return running().place.fileHome(...args); }
function saveBackItemState(...args) { return running().writeback.saveBackItemState(...args); }
function captureExportDocument(...args) { return running().exports.captureExportDocument(...args); }
function loadExportAssets(...args) { return running().exports.loadExportAssets(...args); }
function exportAssetsRequest(...args) { return running().assets.request(...args); }
function standaloneHtmlFor(...args) { return running().standaloneHtml(...args); }
function warnImagesLeftOut(...args) { return running().imagesLeftOut(...args); }
function withBusyBar(...args) { return running().notices.busy.withBar(...args); }
function deliverFile(...args) { return running().delivery.deliver(...args); }
function setMenuItemLabel(...args) { return running().menuItems.setLabel(...args); }
function showToast(...args) { return running().notices.show(...args); }
function offerFileMerge(...args) { return running().merge.offer(...args); }
function resetMergeOffer(...args) { return running().merge.reset(...args); }
function isExportAction(...args) { return running().exportControls.isExportAction(...args); }
function rememberExport(...args) { return running().exportControls.rememberExport(...args); }

function updateFileChip() {
  updateHeaderFileChip();
}

function fileChipListeners(refresh) {
  return {
    session: function (change) {
      if (!active) return;
      if (change.kind === "adopt" || change.kind === "server" || change.kind === "recovery" || change.kind === "reload") refresh();
    },
    location: function (change) {
      if (!active) return;
      if (change !== "writtenOut") refresh();
    },
    save: function (change) {
      if (!active) return;
      if (change === "clean" || change === "halt") refresh();
    }
  };
}

function mirrorFileChipToWriter() {
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

function paintSaveBackItem() {
  var saveBack = document.getElementById("menu-save-back");
  var state = saveBackItemState();
  saveBack.disabled = state.disabled;
  setMenuItemLabel(saveBack, state.label);
}

function updateHeaderFileChip() {
  var chip = document.getElementById("file-chip");
  paintSaveBackItem();
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

function exportFileName(kind, baseName, opts) {
  var exporter = running().formats.byId(kind);
  return exporter ? exporter.fileName(baseName, opts || {}) : baseName + "." + kind;
}

function exportBaseName() {
  return importHome() ? importHome().name.replace(/\.[^.]+$/, "") : slugify(currentDocument().title);
}

function exportRequest(kind, opts) {
  opts = opts || {};
  var exporter = running().formats.byId(kind) || running().formats.byId("md");
  var doc = captureExportDocument();
  return Object.freeze({
    kind: kind,
    doc: doc,
    options: Object.freeze(Object.assign(exportToggleOptions(running().formats, exporter, opts), {
      allowImageBundle: !!opts.allowImageBundle,
      brollView: Object.freeze(running().brollView.printView(opts.brollView))
    })),
    assets: exportAssetsRequest(doc)
  });
}

async function buildFileData(kind, baseName, opts) {
  var request = exportRequest(kind, opts);
  var registered = running().formats.byId(kind);
  var exporter = registered || running().formats.byId("md");
  var assets = await loadExportAssets(request.assets);
  if (!active) throw new Error("The local file menu is not started yet");
  var made = await exporter.build({
    doc: request.doc,
    options: request.options,
    assets: assets,
    ports: { standaloneHtml: standaloneHtmlFor }
  }, baseName);
  if (!active) throw new Error("The local file menu is not started yet");
  var filename = registered
    ? exporter.fileName(baseName, { imageBundle: !!made.imageBundle })
    : baseName + "." + kind;
  if (made.diagnostics) {
    warnImagesLeftOut(made.diagnostics.imagesLeftOut, filename);
    if (made.diagnostics.unshownCharacters) showToast(unshownCharactersText(made.diagnostics.unshownCharacters), "warn");
  }
  return { data: made.data, filename: filename };
}

var pendingResumeHandle = null;

function showResumeBanner(handle) {
  pendingResumeHandle = handle;
  var banner = document.getElementById("resume-banner");
  document.getElementById("resume-banner-text").textContent =
    " " + (handle.name || "your last project") + " needs a click to reopen.";
  banner.hidden = false;
}

function hideResumeBanner() {
  pendingResumeHandle = null;
  document.getElementById("resume-banner").hidden = true;
}

var fileConflictShowToken = 0;

function fileConflictHome(conflict) {
  return conflict.kind === "project" ? fileHome() : importHome();
}

function showFileConflictView(conflict) {
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
    ? formatTimestamp(new Date(currentFile.lastModified).toISOString(), preferences().clock())
    : "recently";
  document.getElementById("file-conflict-detail").textContent =
    fileName + " changed on disk at " + when +
    ", after you opened it here. Saving now would overwrite that version.";
  var token = ++fileConflictShowToken;
  var show = function () {
    if (!active || token !== fileConflictShowToken) return;
    document.getElementById("file-conflict-modal").hidden = false;
  };
  var probe = offerFileMerge(currentFile, fileConflictHome(conflict));
  var timer = setTimeout(show, 1500);
  conflictTimers.add(timer);
  probe.then(function () { clearTimeout(timer); conflictTimers.delete(timer); show(); },
             function () { clearTimeout(timer); conflictTimers.delete(timer); show(); });
}

function hideFileConflictView() {
  fileConflictShowToken++;
  document.getElementById("file-conflict-modal").hidden = true;
  resetMergeOffer();
}

async function exportAs(kind, more) {
  var base = exportBaseName();
  var built;
  try {
    built = await withBusyBar("Building the " + kind.toUpperCase() + " file…", function () {
      return buildFileData(kind, base, Object.assign({ allowImageBundle: true }, more));
    });
  } catch (e) {
    if (!active) return;
    showToast("Could not build the " + kind.toUpperCase() + " file.", "error");
    return;
  }
  if (!active) return;
  await deliverFile(built.filename, built.data, { savedMsg: "Exported " + built.filename });
}

async function runExport(action) {
  var exporter = running().formats.byAction(action);
  if (!exporter) return false;
  var why = exporter.reason ? exporter.reason(captureExportDocument()) : "";
  if (!active) return false;
  if (why) {
    showToast(exporter.refusal || why + ".", "warn");
    return false;
  }
  await exportAs(exporter.id, exporter.defaults);
  return active;
}

var fileMenuChoiceListeners = [];

function onFileMenuChoice(listener) {
  fileMenuChoiceListeners.push(listener);
  return function () {
    var index = fileMenuChoiceListeners.indexOf(listener);
    if (index !== -1) fileMenuChoiceListeners.splice(index, 1);
  };
}

function noteFileMenuChoice(action) {
  fileMenuChoiceListeners.forEach(function (listener) { listener(action); });
}

function runExportAction(action) {
  if (!running().formats.isAction(action)) return false;
  handleFileMenuAction(action, "command-menu");
  return true;
}

function handleFileMenuAction(action, source) {
  noteFileMenuChoice(action);
  if (action !== "autosave" && action !== "toggle-hide-shot" && action !== "toggle-rundown-min") running().actions.invoke("close-file-menu", "button");
  if (isExportAction(action)) rememberExport(action);
  if (running().actions.has(action)) {
    running().actions.invoke(action, source || "menu");
    return;
  }
  if (!currentDocument()) {
    showToast("Still loading…", "warn"); return;
  }
  if (running().formats.isAction(action)) runExport(action);
}


  var controls = { updateFileChip, fileChipListeners, mirrorFileChipToWriter, exportFileName, exportBaseName, exportRequest, buildFileData, showResumeBanner, hideResumeBanner, showFileConflictView, exportAs, runExport, onFileMenuChoice, noteFileMenuChoice, runExportAction, handleFileMenuAction, pendingHandle: function () { return pendingResumeHandle; }, dispose: function () {
    if (!active) return;
    active = false;
    fileConflictShowToken++;
    conflictTimers.forEach(clearTimeout);
    conflictTimers.clear();
    fileMenuChoiceListeners = [];
    pendingResumeHandle = null;
    ports = null;
    if (mounted === controls) mounted = null;
  } };
  Object.keys(controls).forEach(function (key) {
    if (key === "dispose") return;
    var call = controls[key];
    controls[key] = function (...args) {
      if (!active) throw new Error("The local file menu is not started yet");
      return call(...args);
    };
  });
  return controls;
}

export function startLocalFileMenu(next) {
  if (mounted) throw new Error("The local file menu is already started; stop it first");
  var mine = mountLocalFileMenu(next);
  mounted = mine;
  return mine;
}
