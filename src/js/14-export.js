import { S } from "./_state.js";
import { writePref } from "./00p-prefs.js";
import { fileHome, home, restoreHome, serverOf, setHome } from "./_home.js";
import { rememberLastFileHandle } from "./00-prelude.js";
import { migrateRows } from "./02-state.js";
import {
  copyDocHistorySafe,
  mintDocId,
  normalizeDocId,
  syncDocIdentity
} from "./02b-doc-id.js";
import { ensureBytes } from "../adapters/storage/02c-blobs.js";
import { refsIn } from "../../shared/blob-policy.js";
import {
  RELOAD_GUARD_KEY,
  acceptStash,
  applyMerge,
  clearStash,
  cloneState,
  getEditorName,
  readStash,
  setBaseState
} from "./03-sync.js";
import { nowIso } from "./10-comments.js";
import {
  clearDirty,
  noteSaveStatus,
  setSaveButtons,
  showToast,
  updateSaveStatus
} from "./12-dirty-toast.js";
import {
  SERVER_RESUME_KEY,
  linkTurnedOff,
  onServerDoc,
  saveToServer,
  serverSessionExpired
} from "./13-hosted.js";
import { captureExportDocument } from "./14b-export-kit.js";
import {
  checkFileConflict,
  deliverFile,
  fileKindFromName,
  showFileConflict,
  updateFileChip,
  writeBackToFile
} from "./18-local-files.js";
import { buildMarkdownProject, buildSplitpageFile, fileImagesMissing } from "./20d-formats.js";
import { makeDesktopHandle } from "./20f-desktop.js";
import { existingTarget, isAbort, pickTarget, writeToHandle } from "../adapters/files/file-target.ts";
import { requestSave, saveRunning } from "../legacy/save-bridge.ts";
import { autoSaveMay, autoSaveWhere } from "../application/save/autosave.ts";

export var autoSaveEnabled;

function saveKind(opts) {
  if (opts.saveAs) return "saveAs";
  if (opts.force) return "force";
  return opts.auto ? "auto" : "save";
}

export function saveDoc(opts) {
  opts = opts || {};
  if (!opts.auto) resumeAutoSave();
  return requestSave({ kind: saveKind(opts) }).then(function () {});
}

var SAVED = Object.freeze({ kind: "saved" });
var COPIED = Object.freeze({ kind: "copied" });
var CANCELLED = Object.freeze({ kind: "cancelled" });
var FAILED = Object.freeze({ kind: "failed" });
var CONFLICTED = Object.freeze({ kind: "refused", reason: "The file changed on disk since it was opened" });
var NOT_AUTOSAVING = Object.freeze({ kind: "refused", reason: "Autosave is off, paused, has nowhere to write or nothing to write" });

function finishWriting() {
  S.saveButtonBusy = false;
  setSaveButtons(S.dirty ? "Save •" : "Save", false);
}

function saveDialogs(slug) {
  return {
    desktop: S.DESKTOP ? function () {
      return S.DESKTOP.saveFileDialog({
        suggestedName: slug + ".md",
        filters: [
          { name: "Markdown script", extensions: ["md"] },
          { name: "Splitpage script", extensions: ["splitpage"] }
        ]
      }).then(function (picked) { return picked ? makeDesktopHandle(picked) : null; });
    } : null,
    browser: window.showSaveFilePicker ? function () {
      return window.showSaveFilePicker({
        suggestedName: slug + ".md",
        types: [
          { description: "Markdown script", accept: { "text/markdown": [".md"] } },
          { description: "Splitpage script", accept: { "application/json": [".splitpage"] } }
        ]
      });
    } : null
  };
}

function confirmWrite(captured, published, forkDocId, docIdAtSave, seqAtSave, copyOfHosted, landed) {
  var stamp = captured.document;
  S.state.rev = stamp.rev;
  S.state.lastEditedBy = stamp.lastEditedBy;
  S.state.lastEditedAt = stamp.lastEditedAt;
  if (!copyOfHosted) setBaseState(published, "saveDoc: the bytes just written");
  if (landed) {
    landed.home.diskBase = published;
    if (landed.lastModified !== null) landed.home.lastModified = landed.lastModified;
  }
  adoptSavedCopyDocId(forkDocId, docIdAtSave, true);
  if (!copyOfHosted && S.editSeq === seqAtSave) clearDirty();
}

async function writeDoc(opts, job) {
  opts = opts || {};
  var saveAs = !!opts.saveAs;
  var auto = !!opts.auto;
  if (!auto) resumeAutoSave();
  S.saveButtonBusy = true;
  setSaveButtons("Saving…", true);

  if (onServerDoc() && !saveAs) {
    try {
      var sentToServer = await saveToServer(job);
      if (auto && sentToServer === false) {
        haltAutoSave("Autosave is paused — the last save to the server did not go through. " +
                     "Press Save to try again.");
      }
    } finally {
      finishWriting();
    }
    return sentToServer === false ? FAILED : SAVED;
  }

  var converting = !saveAs && home.kind === "file" && home.format === "html";
  if (converting) {
    saveAs = true;
    showToast("Older .html projects are saved as Markdown from now on — choose where to keep it.", "ok");
  }

  var forkDocId = (saveAs && opts.saveAs && S.docIdWrittenOut) ? mintDocId() : null;
  var docIdAtSave = S.state.docId;
  var homeAtSave = home;
  var copyOfHosted = homeAtSave.kind === "server";
  var captured = captureExportDocument({
    docId: forkDocId,
    stamp: { rev: (S.state.rev || 0) + 1, lastEditedBy: getEditorName(), lastEditedAt: nowIso() }
  });
  var published = cloneState(captured.document);
  var seqAtSave = S.editSeq;
  var slug = slugify(published.title);
  var reusing = !saveAs && fileHome() ? fileHome() : null;
  var kind = saveAs ? "md" : ((reusing && reusing.format) || "md");
  var prevHome = null;
  var retarget = null;
  var pickedFor = null;
  var wrote = false;

  function retargetTo(handle, k) {
    if (!job.owns()) return;
    if (home.kind === "server") { pickedFor = home; return; }
    prevHome = home;
    retarget = setHome("file", { handle: handle, format: k, name: handle.name });
    pickedFor = retarget;
    job.moved();
    if (prevHome.kind === "import") updateFileChip();
  }
  function undoRetarget() {
    if (retarget && !wrote && home === retarget) {
      restoreHome(prevHome);
      if (prevHome.kind === "import") updateFileChip();
    }
    retarget = null;
  }

  var written;
  try {
    var target = reusing ? existingTarget(reusing.handle) : await pickTarget(saveDialogs(slug));
    if (target.kind === "cancelled") return CANCELLED;
    if (target.kind === "handle" && target.picked) {
      kind = fileKindFromName(target.handle.name) === "splitpage" ? "splitpage" : "md";
      retargetTo(target.handle, kind);
    }

    if (reusing && !opts.force) {
      var check = await checkFileConflict(reusing.handle, homeAtSave.lastModified);
      if (!check.ok) {
        if (auto) haltAutoSave("Autosave is paused — " + reusing.handle.name +
                               " changed on disk since it was opened. Press Save to sort it out.");
        else showFileConflict(reusing.handle.name, check.current, { kind: "project" });
        return CONFLICTED;
      }
    }

    await ensureBytes(refsIn(published));
    var imagesLeftOut = fileImagesMissing(captured).length;

    var filename = slug + (kind === "splitpage" ? ".splitpage" : ".md");
    var body;
    try {
      body = kind === "splitpage" ? buildSplitpageFile(captured) : buildMarkdownProject(captured);
    } catch (e) {
      showToast("Could not prepare the file to save.", "error");
      return FAILED;
    }

    if (target.kind === "handle") {
      var handle = target.handle;
      var landedOn = await writeToHandle(handle, body);
      wrote = true;
      if (job.owns()) {
        var landedHome = fileHome() && fileHome().handle === handle ? home : null;
        confirmWrite(captured, published, forkDocId, docIdAtSave, seqAtSave, copyOfHosted,
          landedHome ? { home: landedHome, lastModified: landedOn.lastModified } : null);
        if (forkDocId) job.moved();
      } else adoptSavedCopyDocId(forkDocId, docIdAtSave, false);
      if (pickedFor && home === pickedFor) rememberLastFileHandle(handle);
      if (!auto) showToast((saveAs ? "Saved a new copy: " : "Saved to ") + handle.name, "ok");
      else noteSaveStatus();
      warnImagesLeftOut(imagesLeftOut, handle.name);
      written = copyOfHosted ? COPIED : SAVED;
    } else {
      var ok = await deliverFile(filename, body, { savedMsg: "Downloaded " + filename });
      if (!ok) return CANCELLED;
      wrote = true;
      if (job.owns()) {
        confirmWrite(captured, published, forkDocId, docIdAtSave, seqAtSave, copyOfHosted, null);
        if (forkDocId) job.moved();
      } else adoptSavedCopyDocId(forkDocId, docIdAtSave, false);
      warnImagesLeftOut(imagesLeftOut, filename);
      written = copyOfHosted ? COPIED : SAVED;
    }
  } catch (err) {
    if (isAbort(err)) {
      written = CANCELLED;
    } else {
      var why = err && err.message ? err.message : "please try again";
      showToast("Could not save — " + why + ".", "error");
      if (auto) haltAutoSave("Autosave is paused — the last save failed (" + why + "). Press Save to try again.");
      written = { kind: "failed", error: err };
    }
  } finally {
    undoRetarget();
    finishWriting();
  }
  return written;
}

export function warnImagesLeftOut(n, name) {
  if (!n) return;
  showToast(n + (n === 1 ? " image" : " images") + " could not be included in " + name +
    " — the picture" + (n === 1 ? " was" : "s were") + " not available on this computer.", "warn");
}

function adoptSavedCopyDocId(forkDocId, docIdAtSave, owned) {
  forkDocId = normalizeDocId(forkDocId);
  if (forkDocId) copyDocHistorySafe(docIdAtSave, forkDocId);
  if (!owned) return;
  if (forkDocId && !onServerDoc()) S.state.docId = forkDocId;
  S.docIdWrittenOut = true;
  syncDocIdentity();
}

export function applyStashedWork(loaded, override, apply) {
  var stash = override || readStash();
  if (!override) { try { sessionStorage.removeItem(RELOAD_GUARD_KEY); } catch (e) {} }
  if (!stash || !stash.mine || !Array.isArray(stash.mine.rows)) return { state: loaded, report: null, snapshot: null };
  acceptStash(stash, loaded);
  if (!override) {
    try {
      if (sessionStorage.getItem(SERVER_RESUME_KEY)) return { state: loaded, report: null, snapshot: null };
    } catch (e) {}

    var stashId = normalizeDocId(stash.mine.docId);
    if (stashId) { loaded.docId = stashId; S.docIdWrittenOut = true; }

    clearStash();
  }
  function through(extra) {
    var out = applyMerge(Object.assign(
      { theirs: loaded, source: "stash", mergeOnly: !apply }, extra, apply || {}
    ));
    function answer(o) { return { state: o.state, report: o.result, snapshot: o.snapshot, replaced: !!o.replaced }; }
    return out && typeof out.then === "function" ? out.then(answer) : answer(out);
  }

  if (JSON.stringify(stash.mine) === JSON.stringify(loaded)) return through({ unchanged: true });

  return through({
    base: stash.base || null,
    mine: stash.mine,
    undoPoint: migrateRows(cloneState(loaded))
  });
}

export var AUTOSAVE_KEY = "splitpage-autosave";
export var autoSaveTiming = { idle: 2000, hostedIdle: 5000, max: 15000 };

export function autoSaveIdleFor(target) {
  return target === "server" ? autoSaveTiming.hostedIdle : autoSaveTiming.idle;
}
export var autoSaveIdleTimer = null;
export var autoSaveMaxTimer = null;
export var autoSaveHalt = "";

function readAutoSavePref() {
  try { return localStorage.getItem(AUTOSAVE_KEY) !== "0"; } catch (e) { return true; }
}

export function autoSaveTarget() {
  var file = fileHome();
  return autoSaveWhere({
    onServer: onServerDoc(),
    signedOut: !!serverSessionExpired,
    linkOff: !!linkTurnedOff,
    file: file ? { handle: file.handle, format: file.format || null } : null
  });
}

function autoSaveAllowed() {
  return autoSaveMay({ on: !!autoSaveEnabled, halted: autoSaveHalt, target: autoSaveTarget() });
}

export function setAutoSaveEnabled(on) {
  autoSaveEnabled = !!on;
  writePref(AUTOSAVE_KEY, autoSaveEnabled ? "1" : "0");
  if (!autoSaveEnabled) clearAutoSaveTimers();
  else if (S.dirty) scheduleAutoSave();
  updateAutoSaveMenu();
  updateSaveStatus();
}

export function toggleAutoSave() {
  setAutoSaveEnabled(!autoSaveEnabled);
  showToast(autoSaveEnabled
    ? "Autosave is on — edits go to the file you saved to, a moment after you stop typing."
    : "Autosave is off — your changes are only written when you press Save.", "ok");
}

export function updateAutoSaveMenu() {
  var item = document.getElementById("menu-autosave");
  if (!item) return;
  item.setAttribute("aria-checked", autoSaveEnabled ? "true" : "false");
  item.classList.toggle("is-on", autoSaveEnabled);
}

export function scheduleAutoSave() {
  if (!autoSaveAllowed()) return;
  var target = autoSaveTarget();
  if (autoSaveIdleTimer) clearTimeout(autoSaveIdleTimer);
  autoSaveIdleTimer = setTimeout(runAutoSaveTimer, autoSaveIdleFor(target));
  if (!autoSaveMaxTimer) autoSaveMaxTimer = setTimeout(runAutoSaveTimer, autoSaveTiming.max);
}

export function clearAutoSaveTimers() {
  if (autoSaveIdleTimer) { clearTimeout(autoSaveIdleTimer); autoSaveIdleTimer = null; }
  if (autoSaveMaxTimer) { clearTimeout(autoSaveMaxTimer); autoSaveMaxTimer = null; }
}

function runAutoSaveTimer() {
  clearAutoSaveTimers();
  if (!S.dirty) return;
  queueAutoSave();
}

export function flushAutoSave() {
  if (!autoSaveIdleTimer && !autoSaveMaxTimer) return;
  clearAutoSaveTimers();
  if (S.dirty) queueAutoSave();
}

export function haltAutoSave(reason) {
  clearAutoSaveTimers();
  autoSaveHalt = reason || "Autosave is paused — press Save to try again.";
  updateSaveStatus();
  updateFileChip();
}

export function resumeAutoSave() {
  if (!autoSaveHalt) return;
  autoSaveHalt = "";
  updateSaveStatus();
  updateFileChip();
}

var autoSaveWriting = false;
export function queueAutoSave() {
  if (!autoSaveAllowed()) return;
  clearAutoSaveTimers();
  if (saveRunning() && !autoSaveWriting) { scheduleAutoSave(); return; }
  Promise.resolve().then(function () { return requestSave({ kind: "autosave" }); }).catch(function () {});
}

function writeAutoSave(job) {
  if (!autoSaveAllowed() || !S.dirty) return Promise.resolve(NOT_AUTOSAVING);
  autoSaveWriting = true;
  return writeDoc({ auto: true }, job).then(function (result) {
    autoSaveWriting = false;
    return result;
  }, function (error) {
    autoSaveWriting = false;
    throw error;
  });
}

function writeQueued(job) {
  var kind = job.request.kind;
  if (kind === "autosave") return writeAutoSave(job);
  if (kind === "writeback" || kind === "writebackForce") return writeBackToFile(job);
  if (kind === "server") {
    return saveToServer(job).then(function (sent) { return sent === false ? FAILED : SAVED; });
  }
  return writeDoc({ auto: kind === "auto", force: kind === "force", saveAs: kind === "saveAs" }, job);
}

var NO_DESTINATION_KEY = Object.freeze({});

export function destinationKeyOf(h) {
  if (!h || h.kind === "none") return { owner: NO_DESTINATION_KEY, name: "none" };
  if (h.kind === "server") return { owner: serverOf(h.conn) || h, name: "doc:" + String(h.id) };
  var handle = h.handle;
  if (handle && handle._desktopId) return { owner: "desktop:" + String(handle._desktopId), name: "handle" };
  if (handle) return { owner: handle, name: "handle" };
  return { owner: h, name: h.kind };
}

function reportObsoleteSave(request, here) {
  if (!here || home.kind === "server" || !S.state) return;
  showToast(obsoleteSaveText(S.state.title), "warn");
}

export function obsoleteSaveText(title) {
  return "An earlier save of “" + (title || "Untitled Script") + "” finished after you reopened it. Your open copy is unchanged.";
}

function showSaveRunning(running) {
  S.saveButtonBusy = running;
  setSaveButtons();
}

function saveOwnership(ownership) {
  return {
    capture: ownership.capture,
    stillOwns: function (ctx) {
      if (ownership.stillOwns(ctx)) return true;
      if (ctx.destination && ctx.destination.kind === "server") return false;
      var now = ownership.capture();
      return now.epoch === ctx.epoch && now.docId === ctx.docId && now.destination === ctx.destination;
    }
  };
}

export function legacySavePorts(ownership) {
  return {
    write: writeQueued,
    destination: function () { return home; },
    keyOf: destinationKeyOf,
    obsolete: reportObsoleteSave,
    running: showSaveRunning,
    ownership: saveOwnership(ownership)
  };
}

export function slugify(s) {
  return String(s || "splitpage")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "splitpage";
}

export function __init() {
  autoSaveEnabled = readAutoSavePref();

  window.addEventListener("blur", function () { flushAutoSave(); });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushAutoSave();
  });
}
