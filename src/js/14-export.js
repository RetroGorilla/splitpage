import { normalizeDocId } from "../../shared/doc-id-policy.js";
import { mintDocId, nowIso } from "../adapters/identity/ids.ts";
import { documentIdStamp, editStamp } from "../application/commands/save-stamps.ts";
import { currentDocument, stampDocument } from "../legacy/session-bridge.ts";
import { amendHome, currentHome, documentLocation, fileHome, serverStatus, setHome } from "../legacy/location-bridge.ts";
import { rememberLastFileHandle } from "./00-prelude.js";
import { migrateRows } from "./02-state.js";
import {
  copyDocHistorySafe,
  syncDocIdentity
} from "./02b-doc-id.js";
import { ensureBytes } from "../adapters/storage/02c-blobs.js";
import { refsIn } from "../../shared/blob-policy.js";
import {
  applyMerge,
  getEditorName,
  setBaseState
} from "./03-sync.js";
import { clearDirty, noteSaveStatus, setSaveButtons, updateSaveStatus } from "./12-dirty-toast.js";
import {
  onServerDoc,
  saveToServer
} from "./13-hosted.js";
import { captureExportDocument } from "./14b-export-kit.js";
import {
  checkFileConflict,
  deliverFile,
  showFileConflict,
  writeBackToFile
} from "./18-local-files.js";
import { buildMarkdownProject, buildSplitpageFile, fileImagesMissing } from "./20d-formats.js";
import { makeDesktopHandle } from "./20f-desktop.js";
import { existingTarget, isAbort, pickTarget, writeToHandle } from "../adapters/files/file-target.ts";
import { autoSavePolicy, requestSave, saveChanges, saveRunning, unsavedChanges } from "../legacy/save-bridge.ts";
import { showToast } from "../legacy/effects-bridge.ts";
import { preferences } from "../legacy/preferences-bridge.ts";
import { conflictStash } from "../legacy/recovery-bridge.ts";
import { autoSaveWhere } from "../application/save/autosave.ts";
import { cloneState } from "../core/document/clone.ts";
import { fileKindFromName } from "../../shared/file-names.js";
import { slugify } from "../../shared/text.js";
import { desktopPort } from "../adapters/desktop/desktop-port.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";
import { SERVER_RESUME_KEY } from "../application/location/server-status.ts";

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

function saveDialogs(slug) {
  return {
    desktop: runningOnDesktop() ? function () {
      return desktopPort().saveFileDialog({
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
  stampDocument(editStamp({ rev: stamp.rev, lastEditedBy: stamp.lastEditedBy, lastEditedAt: stamp.lastEditedAt }));
  if (!copyOfHosted) setBaseState(published, "saveDoc: the bytes just written");
  if (landed) {
    amendHome(landed.home, landed.lastModified !== null
      ? { diskBase: published, lastModified: landed.lastModified }
      : { diskBase: published });
  }
  adoptSavedCopyDocId(forkDocId, docIdAtSave, true);
  if (!copyOfHosted && saveChanges() === seqAtSave) clearDirty();
}

async function writeDoc(opts, job) {
  opts = opts || {};
  var saveAs = !!opts.saveAs;
  var auto = !!opts.auto;
  if (!auto) resumeAutoSave();

  if (onServerDoc() && !saveAs) {
    try {
      var sentToServer = await saveToServer(job);
      if (auto && sentToServer === false) {
        haltAutoSave("Autosave is paused — the last save to the server did not go through. " +
                     "Press Save to try again.");
      }
    } finally {
      setSaveButtons();
    }
    return sentToServer === false ? FAILED : SAVED;
  }

  var converting = !saveAs && currentHome().kind === "file" && currentHome().format === "html";
  if (converting) {
    saveAs = true;
    showToast("Older .html projects are saved as Markdown from now on — choose where to keep it.", "ok");
  }

  var forkDocId = (saveAs && opts.saveAs && documentLocation().writtenOut()) ? mintDocId() : null;
  var docIdAtSave = currentDocument().docId;
  var homeAtSave = currentHome();
  var copyOfHosted = homeAtSave.kind === "server";
  var captured = captureExportDocument({
    docId: forkDocId,
    stamp: { rev: (currentDocument().rev || 0) + 1, lastEditedBy: getEditorName(), lastEditedAt: nowIso() }
  });
  var published = cloneState(captured.document);
  var seqAtSave = saveChanges();
  var slug = slugify(published.title);
  var reusing = !saveAs && fileHome() ? fileHome() : null;
  var kind = saveAs ? "md" : ((reusing && reusing.format) || "md");
  var prevHome = null;
  var retarget = null;
  var pickedFor = null;
  var wrote = false;

  function retargetTo(handle, k) {
    if (!job.owns()) return;
    if (currentHome().kind === "server") { pickedFor = currentHome(); return; }
    prevHome = currentHome();
    retarget = setHome("file", { handle: handle, format: k, name: handle.name });
    pickedFor = retarget;
    job.moved();
  }
  function undoRetarget() {
    if (retarget && !wrote && currentHome() === retarget) {
      documentLocation().restoreHome(prevHome);
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
        var landedHome = fileHome() && fileHome().handle === handle ? currentHome() : null;
        confirmWrite(captured, published, forkDocId, docIdAtSave, seqAtSave, copyOfHosted,
          landedHome ? { home: landedHome, lastModified: landedOn.lastModified } : null);
        if (forkDocId) job.moved();
      } else adoptSavedCopyDocId(forkDocId, docIdAtSave, false);
      if (pickedFor && currentHome() === pickedFor) rememberLastFileHandle(handle);
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
    setSaveButtons();
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
  if (forkDocId && !onServerDoc()) stampDocument(documentIdStamp(null, forkDocId));
  documentLocation().markWrittenOut(true);
  syncDocIdentity();
}

export function applyStashedWork(loaded, override, apply) {
  var stashes = conflictStash();
  var stash = override || stashes.read();
  if (!override) stashes.dropReloadGuard();
  if (!stash || !stash.mine || !Array.isArray(stash.mine.rows)) return { state: loaded, report: null, snapshot: null };
  stashes.accept(stash, loaded);
  if (!override) {
    try {
      if (sessionStorage.getItem(SERVER_RESUME_KEY)) return { state: loaded, report: null, snapshot: null };
    } catch (e) {}

    var stashId = normalizeDocId(stash.mine.docId);
    if (stashId) { loaded.docId = stashId; documentLocation().markWrittenOut(true); }

    stashes.clear();
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


function readAutoSavePref() {
  return preferences().autosave();
}

export function autoSaveTarget() {
  var file = fileHome();
  return autoSaveWhere({
    onServer: onServerDoc(),
    signedOut: !!serverStatus().sessionExpired(),
    linkOff: !!serverStatus().linkTurnedOff(),
    file: file ? { handle: file.handle, format: file.format || null } : null
  });
}

function autoSaveAllowed() {
  return autoSavePolicy().may(autoSaveTarget());
}

export function setAutoSaveEnabled(on) {
  preferences().setAutosave(!!on);
  autoSavePolicy().setEnabled(on);
  if (on && unsavedChanges()) scheduleAutoSave();
}

export function toggleAutoSave() {
  var on = !autoSavePolicy().enabled();
  setAutoSaveEnabled(on);
  showToast(on
    ? "Autosave is on — edits go to the file you saved to, a moment after you stop typing."
    : "Autosave is off — your changes are only written when you press Save.", "ok");
}

export function updateAutoSaveMenu() {
  var item = document.getElementById("menu-autosave");
  if (!item) return;
  var on = autoSavePolicy().enabled();
  item.setAttribute("aria-checked", on ? "true" : "false");
  item.classList.toggle("is-on", on);
}

export function scheduleAutoSave() {
  autoSavePolicy().schedule(autoSaveTarget());
}

export function clearAutoSaveTimers() {
  autoSavePolicy().clear();
}

function autoSaveDue() {
  if (!unsavedChanges()) return;
  queueAutoSave();
}

function autoSaveChanged(what) {
  if (what === "enabled") updateAutoSaveMenu();
  updateSaveStatus();
}

export function flushAutoSave() {
  var policy = autoSavePolicy();
  if (!policy.pending()) return;
  policy.clear();
  if (unsavedChanges()) queueAutoSave();
}

export function haltAutoSave(reason) {
  autoSavePolicy().halt(reason);
}

export function resumeAutoSave() {
  autoSavePolicy().resume();
}

var autoSaveWriting = false;
export function queueAutoSave() {
  if (!autoSaveAllowed()) return;
  clearAutoSaveTimers();
  if (saveRunning() && !autoSaveWriting) { scheduleAutoSave(); return; }
  Promise.resolve().then(function () { return requestSave({ kind: "autosave" }); }).catch(function () {});
}

function writeAutoSave(job) {
  if (!autoSaveAllowed() || !unsavedChanges()) return Promise.resolve(NOT_AUTOSAVING);
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
  if (h.kind === "server") return { owner: documentLocation().serverOf(h.conn) || h, name: "doc:" + String(h.id) };
  var handle = h.handle;
  if (handle && handle._desktopId) return { owner: "desktop:" + String(handle._desktopId), name: "handle" };
  if (handle) return { owner: handle, name: "handle" };
  return { owner: h, name: h.kind };
}

function reportObsoleteSave(request, here) {
  if (!here || currentHome().kind === "server" || !currentDocument()) return;
  showToast(obsoleteSaveText(currentDocument().title), "warn");
}

export function obsoleteSaveText(title) {
  return "An earlier save of “" + (title || "Untitled Script") + "” finished after you reopened it. Your open copy is unchanged.";
}

function showSaveRunning() {
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
    destination: function () { return currentHome(); },
    keyOf: destinationKeyOf,
    obsolete: reportObsoleteSave,
    running: showSaveRunning,
    ownership: saveOwnership(ownership),
    autosave: {
      enabledAtStart: readAutoSavePref,
      due: autoSaveDue,
      changed: autoSaveChanged
    }
  };
}

export function __init() {
  window.addEventListener("blur", function () { flushAutoSave(); });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushAutoSave();
  });
}
