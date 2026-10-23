import { normalizeDocId } from "../../shared/doc-id-policy.js";
import { mintDocId, nowIso } from "../adapters/identity/ids.ts";
import { documentIdStamp, editStamp } from "../application/commands/save-stamps.ts";
import { currentDocument, stampDocument } from "../legacy/session-bridge.ts";
import { amendHome, currentHome, documentLocation, fileHome, serverStatus, setHome } from "../legacy/location-bridge.ts";
import { rememberLastFileHandle } from "./00-prelude.js";
import {
  copyDocHistorySafe,
  syncDocIdentity
} from "./02b-doc-id.js";
import { ensureBytes } from "../adapters/storage/02c-blobs.js";
import { refsIn } from "../../shared/blob-policy.js";
import {
  getEditorName,
  setBaseState
} from "./03-sync.js";
import { captureExportDocument } from "./14b-export-kit.js";
import { buildMarkdownProject, buildSplitpageFile, fileImagesMissing } from "./20d-formats.js";
import { makeDesktopHandle } from "../adapters/desktop/desktop-handle.ts";
import { checkFileConflict, existingTarget, isAbort, pickTarget, writeToHandle } from "../adapters/files/file-target.ts";
import { deliverFile } from "../legacy/file-delivery.ts";
import { autoSavePolicy, confirmSavedNow, flushAutoSave, haltAutoSave, resumeAutoSave, saveChanges } from "../legacy/save-bridge.ts";
import { showToast, warnImagesLeftOut } from "../legacy/effects-bridge.ts";
import { preferences } from "../legacy/preferences-bridge.ts";
import { autoSaveWhere } from "../application/save/autosave.ts";
import { cloneState } from "../core/document/clone.ts";
import { fileKindFromName } from "../../shared/file-names.js";
import { slugify } from "../../shared/text.js";
import { desktopPort } from "../adapters/desktop/desktop-port.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";

var SAVED = Object.freeze({ kind: "saved" });
var COPIED = Object.freeze({ kind: "copied" });
var CANCELLED = Object.freeze({ kind: "cancelled" });
var FAILED = Object.freeze({ kind: "failed" });
var FILE_CHANGED = "The file changed on disk since it was opened";
var CONFLICTED = Object.freeze({ kind: "refused", reason: FILE_CHANGED });

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
  if (!copyOfHosted && saveChanges() === seqAtSave) confirmSavedNow();
}

async function writeDoc(opts, job) {
  opts = opts || {};
  var saveAs = !!opts.saveAs;
  var auto = !!opts.auto;
  if (!auto) resumeAutoSave();

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
        if (!auto) return { kind: "refused", reason: FILE_CHANGED, conflict: { fileName: reusing.handle.name, current: check.current, kind: "project" } };
        haltAutoSave("Autosave is paused — " + reusing.handle.name +
                     " changed on disk since it was opened. Press Save to sort it out.");
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
  }
  return written;
}

function adoptSavedCopyDocId(forkDocId, docIdAtSave, owned) {
  forkDocId = normalizeDocId(forkDocId);
  if (forkDocId) copyDocHistorySafe(docIdAtSave, forkDocId);
  if (!owned) return;
  if (forkDocId && currentHome().kind !== "server") stampDocument(documentIdStamp(null, forkDocId));
  documentLocation().markWrittenOut(true);
  syncDocIdentity();
}

function readAutoSavePref() {
  return preferences().autosave();
}

function fileAutoSaveTarget() {
  var file = fileHome();
  return autoSaveWhere({
    onServer: false,
    signedOut: !!serverStatus().sessionExpired(),
    linkOff: !!serverStatus().linkTurnedOff(),
    file: file ? { handle: file.handle, format: file.format || null } : null
  });
}

export function updateAutoSaveMenu() {
  var item = document.getElementById("menu-autosave");
  if (!item) return;
  var on = autoSavePolicy().enabled();
  item.setAttribute("aria-checked", on ? "true" : "false");
  item.classList.toggle("is-on", on);
}

function autoSaveChanged(what) {
  if (what === "enabled") updateAutoSaveMenu();
}

var TAKEN_OFF_THE_SERVER = ["save", "auto", "autosave", "force"];

function fileTakes(request, place) {
  if (request.kind === "saveAs") return true;
  return TAKEN_OFF_THE_SERVER.indexOf(request.kind) !== -1 && !(place && place.kind === "server");
}

function writeToFile(job) {
  var kind = job.request.kind;
  return writeDoc({ auto: kind === "auto" || kind === "autosave", force: kind === "force", saveAs: kind === "saveAs" }, job);
}

export function legacyFileDestination() {
  return { id: "file", takes: fileTakes, autoSaveTarget: fileAutoSaveTarget, write: writeToFile };
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
    destination: function () { return currentHome(); },
    keyOf: destinationKeyOf,
    obsolete: reportObsoleteSave,
    ownership: saveOwnership(ownership),
    autosave: {
      enabledAtStart: readAutoSavePref,
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
