import { normalizeDocId } from "../../../shared/doc-id-policy.js";
import { documentIdStamp, editStamp } from "../commands/save-stamps.ts";
import { refsIn } from "../../../shared/blob-policy.js";
import { autoSaveWhere } from "./autosave.ts";
import { cloneState } from "../../core/document/clone.ts";
import { fileKindFromName } from "../../../shared/file-names.js";
import { slugify } from "../../../shared/text.js";

var ports = null;

function mintDocId() { return ports.ids.docId(); }
function nowIso() { return ports.clock.nowIso(); }
function currentDocument() { return ports.document.current(); }
function stampDocument(stamp) { return ports.document.stamp(stamp); }
function documentLocation() { return ports.location; }
function currentHome() { return ports.location.home(); }
function fileHome() { return ports.location.fileHome(); }
function setHome(kind, fields) { return ports.location.setHome(kind, fields); }
function amendHome(record, fields) { return ports.location.amendHome(record, fields); }
function rememberLastFileHandle(handle) { return ports.lastFile.remember(handle); }
function copyDocHistorySafe(fromId, toId) { return ports.deferred.copyHistory(fromId, toId); }
function syncDocIdentity() { return ports.deferred.syncIdentity(); }
function setBaseState(state, reason) { return ports.deferred.setBaseline(state, reason); }
function ensureBytes(shas) { return ports.pictures.ensureBytes(shas); }
function captureExportDocument(opts) { return ports.exports.captureExportDocument(opts); }
function buildSplitpageFile(doc) { return ports.formats.buildSplitpage(doc); }
function buildMarkdownProject(doc) { return ports.formats.buildMarkdown(doc); }
function fileImagesMissing(doc) { return ports.formats.imagesMissing(doc); }
function saveDialogs(slug) { return ports.files.dialogs(slug); }
function pickTarget(dialogs) { return ports.files.pick(dialogs); }
function existingTarget(handle) { return ports.files.existing(handle); }
function checkFileConflict(handle, lastModified) { return ports.files.checkConflict(handle, lastModified); }
function writeToHandle(handle, body) { return ports.files.write(handle, body); }
function isAbort(error) { return ports.files.isAbort(error); }
function deliverFile(filename, data, opts) { return ports.delivery.deliver(filename, data, opts); }
function autoSavePolicy() { return ports.saves.policy(); }
function confirmSavedNow() { return ports.saves.confirmSavedNow(); }
function haltAutoSave(reason) { return ports.saves.halt(reason); }
function resumeAutoSave() { return ports.saves.resume(); }
function saveChanges() { return ports.saves.changes(); }
function showToast(message, kind, sticky) { return ports.notices.show(message, kind, sticky); }
function warnImagesLeftOut(count, name) { return ports.notices.imagesLeftOut(count, name); }
function getEditorName() { return ports.preferences.editorName(); }
function preferences() { return ports.preferences; }

var SAVED = Object.freeze({ kind: "saved" });
var CANCELLED = Object.freeze({ kind: "cancelled" });
var FAILED = Object.freeze({ kind: "failed" });
var FILE_CHANGED = "The file changed on disk since it was opened";
var CONFLICTED = Object.freeze({ kind: "refused", reason: FILE_CHANGED });

function confirmWrite(captured, published, forkDocId, docIdAtSave, seqAtSave, landed) {
  var stamp = captured.document;
  stampDocument(editStamp({ rev: stamp.rev, lastEditedBy: stamp.lastEditedBy, lastEditedAt: stamp.lastEditedAt }));
  setBaseState(published, "saveDoc: the bytes just written");
  if (landed) {
    amendHome(landed.home, landed.lastModified !== null
      ? { diskBase: published, lastModified: landed.lastModified }
      : { diskBase: published });
  }
  adoptSavedCopyDocId(forkDocId, docIdAtSave, true);
  if (saveChanges() === seqAtSave) confirmSavedNow();
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
        confirmWrite(captured, published, forkDocId, docIdAtSave, seqAtSave,
          landedHome ? { home: landedHome, lastModified: landedOn.lastModified } : null);
        if (forkDocId) job.moved();
      } else adoptSavedCopyDocId(forkDocId, docIdAtSave, false);
      if (pickedFor && currentHome() === pickedFor) rememberLastFileHandle(handle);
      if (!auto) showToast((saveAs ? "Saved a new copy: " : "Saved to ") + handle.name, "ok");
      warnImagesLeftOut(imagesLeftOut, handle.name);
      written = SAVED;
    } else {
      var ok = await deliverFile(filename, body, { savedMsg: "Downloaded " + filename });
      if (!ok) return CANCELLED;
      wrote = true;
      if (job.owns()) {
        confirmWrite(captured, published, forkDocId, docIdAtSave, seqAtSave, null);
        if (forkDocId) job.moved();
      } else adoptSavedCopyDocId(forkDocId, docIdAtSave, false);
      warnImagesLeftOut(imagesLeftOut, filename);
      written = SAVED;
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
  if (forkDocId) stampDocument(documentIdStamp(null, forkDocId));
  documentLocation().markWrittenOut(true);
  syncDocIdentity();
}

function readAutoSavePref() {
  return preferences().autosave();
}

function fileAutoSaveTarget() {
  var file = fileHome();
  return autoSaveWhere({
    file: file ? { handle: file.handle, format: file.format || null } : null
  });
}

function updateAutoSaveMenu() {
  var item = ports.page.getElementById("menu-autosave");
  if (!item) return;
  var on = autoSavePolicy().enabled();
  item.setAttribute("aria-checked", on ? "true" : "false");
  item.classList.toggle("is-on", on);
}

function autoSaveChanged(what) {
  if (what === "enabled") updateAutoSaveMenu();
}

var FILE_REQUESTS = ["saveAs", "save", "auto", "autosave", "force"];

function fileTakes(request) {
  return FILE_REQUESTS.indexOf(request.kind) !== -1;
}

function writeToFile(job) {
  var kind = job.request.kind;
  return writeDoc({ auto: kind === "auto" || kind === "autosave", force: kind === "force", saveAs: kind === "saveAs" }, job);
}

function fileDestination() {
  return { id: "file", takes: fileTakes, autoSaveTarget: fileAutoSaveTarget, write: writeToFile };
}

var NO_DESTINATION_KEY = Object.freeze({});

function destinationKeyOf(h) {
  if (!h || h.kind === "none") return { owner: NO_DESTINATION_KEY, name: "none" };
  var handle = h.handle;
  if (handle && handle._desktopId) return { owner: "desktop:" + String(handle._desktopId), name: "handle" };
  if (handle) return { owner: handle, name: "handle" };
  return { owner: h, name: h.kind };
}

function reportObsoleteSave(request, here) {
  if (!here || !currentDocument()) return;
  showToast(obsoleteSaveText(currentDocument().title), "warn");
}

export function obsoleteSaveText(title) {
  return "An earlier save of “" + (title || "Untitled Script") + "” finished after you reopened it. Your open copy is unchanged.";
}

function savePorts(ownership) {
  return {
    destination: function () { return currentHome(); },
    keyOf: destinationKeyOf,
    obsolete: reportObsoleteSave,
    ownership: ownership,
    autosave: {
      enabledAtStart: readAutoSavePref,
      changed: autoSaveChanged
    }
  };
}

export function mountFileSaving(given) {
  ports = given;
  var mounted = given;
  return {
    destination: fileDestination,
    savePorts: savePorts,
    updateAutoSaveMenu: updateAutoSaveMenu,
    dispose: function () {
      if (ports === mounted) ports = null;
    }
  };
}
