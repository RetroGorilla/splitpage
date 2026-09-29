import { S } from "./_state.js";
import { writePref } from "./00p-prefs.js";
import { fileHome, home, restoreHome, setHome } from "./_home.js";
import { rememberLastFileHandle } from "./00-prelude.js";
import { migrateRows } from "./02-state.js";
import {
  copyDocHistorySafe,
  mintDocId,
  normalizeDocId,
  syncDocIdentity
} from "./02b-doc-id.js";
import {
  ensureBytes,
  has as hasBlob,
  rowImage,
  rowImageBytes,
  rowImageDataUrl,
  rowImageKey
} from "./02c-blobs.js";
import { morePictureRefs, pictureBytes, rowVideoLinks, videoLinkLabel } from "./02d-gallery.js";
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
import { htmlToMarkdown, inertBody } from "./04-richtext.js";
import { cellOf, toMarkdown } from "./04c-doc-model.js";
import { pad2 } from "./05-render.js";
import { healTagRegistry } from "./07-production-tags.js";
import { breakdownRows } from "./08-production-panels.js";
import { brollEntries } from "./08c-broll.js";
import { commentBodyText, commentEntries, nowIso } from "./10-comments.js";
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
import {
  breakdownGroups,
  brollSummaryText,
  commentNumbers,
  exportBrollScenes,
  exportComments,
  exportFacts,
  exportSummaryParts,
  sceneFacts
} from "./14b-export-kit.js";
import {
  checkFileConflict,
  deliverFile,
  fileKindFromName,
  showFileConflict,
  updateFileChip
} from "./18-local-files.js";
import { buildMarkdownProject, buildSplitpageFile, fileImagesMissing } from "./20d-formats.js";
import { makeDesktopHandle } from "./20f-desktop.js";

export var autoSaveEnabled;

function settleDerivedRecords() {
  if (!S.state) return;
  healTagRegistry();
  brollEntries();
}

export async function saveDoc(opts) {
  opts = opts || {};
  var saveAs = !!opts.saveAs;
  var auto = !!opts.auto;
  if (!auto) resumeAutoSave();
  // Decided on opts.saveAs, not local saveAs (legacy html convert)
  var forkDocId = (opts.saveAs && S.docIdWrittenOut) ? mintDocId() : null;
  var docIdAtSave = S.state.docId;
  // Retarget Save only if write lands (invariant #36)
  var prevHome = null;
  var retarget = null;
  var pickedFor = null;
  var wrote = false;
  function retargetTo(handle, k) {
    if (S.state.docId !== docIdAtSave) return;
    if (home.kind === "server") { pickedFor = home; return; }
    prevHome = home;
    retarget = setHome("file", { handle: handle, format: k, name: handle.name });
    pickedFor = retarget;
    if (prevHome.kind === "import") updateFileChip();
  }
  function undoRetarget() {
    if (retarget && !wrote && home === retarget) {
      restoreHome(prevHome);
      if (prevHome.kind === "import") updateFileChip();
    }
    retarget = null;
  }
  settleDerivedRecords();
  S.saveButtonBusy = true;
  setSaveButtons("Saving…", true);

  if (onServerDoc() && !saveAs) {
    try {
      var sentToServer = await saveToServer();
      if (auto && sentToServer === false) {
        haltAutoSave("Autosave is paused — the last save to the server did not go through. " +
                     "Press Save to try again.");
      }
    } finally {
      S.saveButtonBusy = false;
      setSaveButtons(S.dirty ? "Save •" : "Save", false);
    }
    return;
  }

  // Legacy .html is never written back as HTML
  var converting = !saveAs && home.kind === "file" && home.format === "html";
  if (converting) {
    saveAs = true;
    showToast("Older .html projects are saved as Markdown from now on — choose where to keep it.", "ok");
  }

  S.state.rev = (S.state.rev || 0) + 1;
  S.state.lastEditedBy = getEditorName();
  S.state.lastEditedAt = nowIso();
  var published = cloneState(S.state);
  // State adopts fork id only after write succeeds
  if (forkDocId) published.docId = forkDocId;
  var seqAtSave = S.editSeq;
  var slug = slugify(published.title);
  var targetHandle = saveAs || !fileHome() ? null : fileHome().handle;
  var kind = saveAs ? "md" : ((fileHome() && fileHome().format) || "md");

  var reusingHandle = !!targetHandle;

  try {
    // Checked before browser picker; cancel resolves null
    if (!targetHandle && S.DESKTOP) {
      var pickedDesktop = await S.DESKTOP.saveFileDialog({
        suggestedName: slug + ".md",
        filters: [
          { name: "Markdown script", extensions: ["md"] },
          { name: "Splitpage script", extensions: ["splitpage"] }
        ]
      });
      if (!pickedDesktop) {
        S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
        S.saveButtonBusy = false;
        setSaveButtons(S.dirty ? "Save •" : "Save", false);
        return;
      }
      targetHandle = makeDesktopHandle(pickedDesktop);
      kind = fileKindFromName(pickedDesktop.name) === "splitpage" ? "splitpage" : "md";
      retargetTo(targetHandle, kind);
    } else if (!targetHandle && window.showSaveFilePicker) {
      targetHandle = await window.showSaveFilePicker({
        suggestedName: slug + ".md",
        types: [
          { description: "Markdown script", accept: { "text/markdown": [".md"] } },
          { description: "Splitpage script", accept: { "application/json": [".splitpage"] } }
        ]
      });
      kind = fileKindFromName(targetHandle.name) === "splitpage" ? "splitpage" : "md";
      retargetTo(targetHandle, kind);
    }

    if (reusingHandle && !opts.force) {
      var check = await checkFileConflict(targetHandle, home.lastModified);
      if (!check.ok) {
        // Auto writes must not throw modals mid-typing
        if (auto) haltAutoSave("Autosave is paused — " + targetHandle.name +
                               " changed on disk since it was opened. Press Save to sort it out.");
        else showFileConflict(targetHandle.name, check.current, { kind: "project" });
        S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
        S.saveButtonBusy = false;
        setSaveButtons(S.dirty ? "Save •" : "Save", false);
        return;
      }
    }

    await ensureBytes(refsIn(published));
    var imagesLeftOut = fileImagesMissing(published).length;

    var filename = slug + (kind === "splitpage" ? ".splitpage" : ".md");
    var body;
    try {
      body = kind === "splitpage" ? buildSplitpageFile(published) : buildMarkdownProject(published);
    } catch (e) {
      showToast("Could not prepare the file to save.", "error");
      S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
      // Before setSaveButtons, whose identity sync would adopt it
      undoRetarget();
      S.saveButtonBusy = false;
      setSaveButtons(S.dirty ? "Save •" : "Save", false);
      return;
    }

    if (targetHandle) {
      var writable = await targetHandle.createWritable();
      await writable.write(body);
      await writable.close();
      wrote = true;
      var stillOurs = S.state.docId === docIdAtSave;
      var homeAtWrite = fileHome() && fileHome().handle === targetHandle ? home : null;
      if (stillOurs) setBaseState(published, "saveDoc: the bytes just written to the file");
      if (pickedFor && home === pickedFor) rememberLastFileHandle(targetHandle);
      adoptSavedCopyDocId(forkDocId, docIdAtSave);
      var docIdAfterSave = S.state.docId;
      // Ancestor for later Merge; paired with lastModified
      if (homeAtWrite && stillOurs) homeAtWrite.diskBase = published;
      try {
        var afterFile = await targetHandle.getFile();
        if (homeAtWrite && home === homeAtWrite) homeAtWrite.lastModified = afterFile.lastModified;
      } catch (e) { }
      if (stillOurs && S.state.docId === docIdAfterSave && S.editSeq === seqAtSave) clearDirty();
      if (!auto) showToast((saveAs ? "Saved a new copy: " : "Saved to ") + targetHandle.name, "ok");
      else noteSaveStatus();
      warnImagesLeftOut(imagesLeftOut, targetHandle.name);
    } else {
      var ok = await deliverFile(filename, body, { savedMsg: "Downloaded " + filename });
      if (ok) {
        wrote = true;
        var downloadedOurs = S.state.docId === docIdAtSave;
        if (downloadedOurs) setBaseState(published, "saveDoc: the copy just downloaded");
        adoptSavedCopyDocId(forkDocId, docIdAtSave);
        if (downloadedOurs && S.editSeq === seqAtSave) clearDirty();
        warnImagesLeftOut(imagesLeftOut, filename);
      } else {
        S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
      }
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
    } else {
      var why = err && err.message ? err.message : "please try again";
      showToast("Could not save — " + why + ".", "error");
      if (auto) haltAutoSave("Autosave is paused — the last save failed (" + why + "). Press Save to try again.");
      S.state.rev = Math.max(0, (S.state.rev || 1) - 1);
    }
  } finally {
    undoRetarget();
    S.saveButtonBusy = false;
    setSaveButtons(S.dirty ? "Save •" : "Save", false);
  }
}

export function warnImagesLeftOut(n, name) {
  if (!n) return;
  showToast(n + (n === 1 ? " image" : " images") + " could not be included in " + name +
    " — the picture" + (n === 1 ? " was" : "s were") + " not available on this computer.", "warn");
}

function adoptSavedCopyDocId(forkDocId, docIdAtSave) {
  forkDocId = normalizeDocId(forkDocId);
  var sameDocument = !!S.state && S.state.docId === docIdAtSave;
  if (forkDocId) {
    if (sameDocument && !onServerDoc()) S.state.docId = forkDocId;
    copyDocHistorySafe(docIdAtSave, forkDocId);
  }
  if (!sameDocument) return;
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

    // Keep stash id, else equality check never holds
    var stashId = normalizeDocId(stash.mine.docId);
    if (stashId) { loaded.docId = stashId; S.docIdWrittenOut = true; }

    clearStash();
  }
  function through(extra) {
    var out = applyMerge(Object.assign(
      { theirs: loaded, source: "stash", mergeOnly: !apply }, extra, apply || {}
    ));
    function answer(o) { return { state: o.state, report: o.result, snapshot: o.snapshot }; }
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

// Hosted waits longer: short idle conflicts on nearly every save
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
  if (serverSessionExpired || (linkTurnedOff && onServerDoc())) return null;
  if (onServerDoc()) return "server";
  var file = fileHome();
  if (!file || !file.handle) return null;
  if (file.format === "html") return null;
  return "file";
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
  if (!autoSaveEnabled || autoSaveHalt) return;
  var target = autoSaveTarget();
  if (!target) return;
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

// Silent when autosave off; never writes unrequested
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

// Distinct from saveButtonBusy; sharing one flag broke serialization
var saveInFlight = false;
var saveQueued = false;
export function queueAutoSave() {
  if (!autoSaveEnabled) return;
  if (!autoSaveTarget()) return;
  if (autoSaveHalt) return;
  clearAutoSaveTimers();
  if (saveInFlight) { saveQueued = true; return; }
  if (S.saveButtonBusy) { scheduleAutoSave(); return; }
  saveInFlight = true;
  // Catch required or one failure drops all later autosaves
  Promise.resolve()
    .then(function () { return saveDoc({ auto: true }); })
    .catch(function () {})
    .then(function () {
      saveInFlight = false;
      if (saveQueued) { saveQueued = false; queueAutoSave(); }
    });
}

export function slugify(s) {
  return String(s || "splitpage")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "splitpage";
}

function mdCell(value) {
  return String(value == null ? "" : value)
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, " ");
}

function appendMarkdownTail(lines, opts) {
  if (opts && opts.export) { appendExportTail(lines); return; }
  var breakdown = breakdownRows();
  if (breakdown.length) {
    lines.push("## Production breakdown");
    lines.push("");
    lines.push("| Category | Item | Status | Assigned to | Mentions | Scenes | Notes |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    breakdown.forEach(function (r) {
      lines.push("| " + [r.categoryLabel, r.name, r.statusLabel, r.owner, r.mentions,
                         r.scenes.join(", "), r.notes].map(mdCell).join(" | ") + " |");
    });
    lines.push("");
  }

  var comments = commentEntries({ pieces: true });
  if (comments.length) {
    lines.push("## Comments");
    lines.push("");
    comments.forEach(function (c) {
      lines.push("**" + c.location + "**" +
                 (c.resolved ? " _(resolved" + (c.resolvedBy ? " by " + c.resolvedBy : "") + ")_" : "") +
                 (c.assignee ? " _(assigned to " + c.assignee + ")_" : "") +
                 " — " + c.author + (c.when ? " · " + c.when : ""));
      lines.push("");
      if (c.quoted) {
        lines.push("> " + c.quoted.split(/\r\n|\r|\n/).join("  \n> "));
        lines.push("");
      }
      lines.push((commentBodyText(c) || "_(empty)_").split(/\r\n|\r|\n/).join("  \n"));
      c.replies.forEach(function (rp) {
        lines.push("");
        lines.push("> ↳ **" + rp.author + "**" + (rp.when ? " · " + rp.when : "") + ":  " +
                   (commentBodyText(rp) || "_(empty)_").split(/\r\n|\r|\n/).join("  \n> "));
      });
      lines.push("");
      lines.push("---");
      lines.push("");
    });
  }
}

export function exportMetaLine(facts) {
  facts = facts || exportFacts();
  return exportSummaryParts(facts).concat(facts.date).join(" · ");
}

function mdSceneFactsLine(f) {
  return "**" + f.status.label + "** · Read " + f.read + (f.readSet ? ", set by hand" : "");
}

function mdReadCell(f) {
  return f.read + (f.readSet ? ", set by hand" : "");
}

function mdMarkerRun(numbers, marks) {
  return {
    text: numbers.map(function (n) { return "<sup>" + n + "</sup>"; }).join(""),
    marks: marks
  };
}

function markdownWithMarkers(html, nums) {
  var cell = cellOf(html);
  if (!cell.some(function (r) { return r.marks && r.marks.cmt; })) return toMarkdown(cell);
  var out = [];
  cell.forEach(function (r, i) {
    var ids = r.marks && r.marks.cmt;
    var next = cell[i + 1];
    var nextIds = (next && next.marks && next.marks.cmt) || [];
    var ending = (ids || []).filter(function (id) { return nextIds.indexOf(id) === -1 && nums[id]; })
      .map(function (id) { return nums[id]; })
      .sort(function (a, b) { return a - b; });
    if (!ending.length) { out.push(r); return; }
    var own = {};
    Object.keys(r.marks).forEach(function (k) { if (k !== "cmt") own[k] = r.marks[k]; });
    var tail = r.atom ? null : /\s+$/.exec(r.text);
    if (tail && tail.index > 0) {
      out.push({ text: r.text.slice(0, tail.index), marks: r.marks });
      out.push(mdMarkerRun(ending, own));
      out.push({ text: tail[0], marks: r.marks });
      return;
    }
    out.push(r);
    var carried = {};
    Object.keys(own).forEach(function (k) {
      if (k !== "tag" && next && !next.atom && next.marks && next.marks[k] === own[k]) carried[k] = own[k];
    });
    out.push(mdMarkerRun(ending, carried));
  });
  return toMarkdown(out);
}

// Single newline renders as space; reader reverses this
function mdHardBreaks(md) {
  return md.replace(/([^\n])\n(?=[^\n])/g, "$1  \n");
}

function mdLine(value) {
  return String(value == null ? "" : value).replace(/\s*(\r\n|\r|\n)\s*/g, " ").trim();
}

function mdBrollTask(r) {
  var parts = [];
  if (r.location) parts.push(mdLine(r.location));
  if (r.owner) parts.push(mdLine(r.owner));
  if (r.props.length) parts.push("Props: " + r.props.map(mdLine).join(", "));
  if (r.flagged) parts.push("**Flagged**");
  if (r.note) parts.push("Note: " + mdLine(r.note));
  return "- [" + (r.shot ? "x" : " ") + "] " + mdLine(r.name) + (parts.length ? " — " + parts.join(" · ") : "");
}

function appendExportTail(lines) {
  var groups = breakdownGroups();
  if (groups.length) {
    lines.push("## Production breakdown");
    lines.push("");
    groups.forEach(function (g) {
      lines.push("### " + g.label + " (" + g.items.length + ")");
      lines.push("");
      lines.push("| Item | Status | Scenes | Assigned to | Notes |");
      lines.push("| --- | --- | --- | --- | --- |");
      g.items.forEach(function (r) {
        lines.push("| " + [r.name, r.statusLabel, r.scenes.join(", "), r.owner || "—", r.notes].map(mdCell).join(" | ") + " |");
      });
      lines.push("");
    });
  }

  var broll = exportBrollScenes();
  if (broll.length) {
    lines.push("## B-roll shot list");
    lines.push("");
    lines.push("_" + brollSummaryText(broll) + "_");
    lines.push("");
    broll.forEach(function (g) {
      lines.push("**" + g.label + "**" + (g.start ? " · " + g.start : "") + " · " + g.done + "/" + g.total + " shot");
      lines.push("");
      g.items.forEach(function (r) { lines.push(mdBrollTask(r)); });
      lines.push("");
    });
  }

  var comments = exportComments({ pieces: true });
  if (comments.length) {
    lines.push("## Comments");
    lines.push("");
    comments.forEach(function (c) {
      lines.push("**" + (c.number ? c.number + " · " : "") + c.where + "**" +
                 (c.resolved ? " _(resolved" + (c.resolvedBy ? " by " + c.resolvedBy : "") + ")_" : "") +
                 (c.assignee ? " _(assigned to " + c.assignee + ")_" : "") +
                 " — " + c.author + (c.when ? " · " + c.when : ""));
      lines.push("");
      if (c.quoted) {
        lines.push("> " + c.quoted.split(/\r\n|\r|\n/).join("  \n> "));
        lines.push("");
      }
      lines.push((commentBodyText(c) || "_(empty)_").split(/\r\n|\r|\n/).join("  \n"));
      c.replies.forEach(function (rp) {
        lines.push("");
        lines.push("> ↳ **" + rp.author + "**" + (rp.when ? " · " + rp.when : "") + ":  " +
                   (commentBodyText(rp) || "_(empty)_").split(/\r\n|\r|\n/).join("  \n> "));
      });
      lines.push("");
      lines.push("---");
      lines.push("");
    });
  }
}

function dataUrlImageExt(dataUrl) {
  var m = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl || "");
  var t = m ? m[1].toLowerCase() : "jpeg";
  if (t === "jpeg") return "jpg";
  if (t === "svg+xml") return "svg";
  return t;
}

function markdownImagePath(row, i) {
  var img = rowImage(row);
  return "images/scene-" + pad2(i + 1) + "." + dataUrlImageExt(img && img.ref ? "data:" + img.ref.mime : img && img.dataUrl);
}

function markdownHasPicture(row) {
  var img = rowImage(row);
  return !!img && (!!img.dataUrl || hasBlob(img.ref.sha256));
}

function markdownMorePictures(row, i) {
  var out = [];
  morePictureRefs(row).forEach(function (ref, k) {
    var pic = pictureBytes(ref);
    if (!pic) return;
    out.push({ path: "images/scene-" + pad2(i + 1) + "-" + (k + 2) + "." + dataUrlImageExt("data:" + ref.mime), bytes: pic.bytes });
  });
  return out;
}

export function markdownExportImages() {
  var out = [];
  S.state.rows.forEach(function (row, i) {
    var pic = rowImage(row) && rowImageBytes(row);
    if (pic) out.push({ path: markdownImagePath(row, i), bytes: pic.bytes });
    out = out.concat(markdownMorePictures(row, i));
  });
  return out;
}

export function toMarkdownDoc(opts) {
  var limit = opts && opts.scenes;
  var facts = exportFacts();
  var scenes = sceneFacts();
  var nums = commentNumbers();
  var lines = [];
  lines.push("# " + facts.title);
  lines.push("");
  if (!S.state.rows.length) {
    lines.push("_No scenes yet._");
    lines.push("");
  } else {
    lines.push("_" + exportMetaLine(facts) + "_");
    lines.push("");
  }
  (limit ? S.state.rows.slice(0, limit) : S.state.rows).forEach(function (row, i) {
    lines.push("### Scene " + scenes[i].number + " · " + scenes[i].start);
    lines.push("");
    lines.push(mdSceneFactsLine(scenes[i]));
    lines.push("");
    if (markdownHasPicture(row)) {
      lines.push("![visual for scene " + pad2(i + 1) + "](" + markdownImagePath(row, i) + ")");
      lines.push("");
    }
    var more = markdownMorePictures(row, i);
    more.forEach(function (m, k) {
      lines.push("![visual " + (k + 2) + " for scene " + pad2(i + 1) + "](" + m.path + ")");
      lines.push("");
    });
    var vlinks = rowVideoLinks(row);
    vlinks.forEach(function (l) {
      lines.push(l.href
        ? "▶ [" + videoLinkLabel(l).replace(/([[\]()])/g, "\\$1") + "](" + l.href.replace(/[()\s]/g, encodeURIComponent) + ")"
        : "▶ " + l.name.replace(/([\\`*_[\]<>])/g, "\\$1") + " _(video file)_");
    });
    if (vlinks.length) lines.push("");
    var vmd = mdHardBreaks(markdownWithMarkers(row.visualText, nums));
    if (vmd) {
      lines.push("*Visual —* " + vmd);
      lines.push("");
    }
    var amd = mdHardBreaks(markdownWithMarkers(row.audioText, nums));
    if (amd) {
      lines.push(amd);
      lines.push("");
    } else if (!vmd && !markdownHasPicture(row) && !more.length && !vlinks.length) {
      lines.push("_(blank scene)_");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  });
  if (!limit) appendMarkdownTail(lines, { export: true });
  return lines.join("\n");
}

function mdRichTableCell(md) {
  return String(md || "").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

export function mdSceneCellSource(row, i, model) {
  var toMd = model ? function (html) { return toMarkdown(cellOf(html)); } : htmlToMarkdown;
  var text = toMd(row.visualText);
  var visual = text;
  var image = rowImageDataUrl(row);
  if (image) {
    visual = "![visual for scene " + pad2(i + 1) + "](" + image + ")" + (visual ? "<br>" + visual : "");
  }
  return {
    visual: String(visual).replace(/\r\n|\r|\n/g, "<br>").trim(),
    visualText: String(text).replace(/\r\n|\r|\n/g, "<br>").trim(),
    image: image ? rowImageKey(row) : null,
    audio: String(toMd(row.audioText)).replace(/\r\n|\r|\n/g, "<br>").trim()
  };
}

export function toMarkdownTableDoc(s, opts) {
  s = s || S.state;
  var exporting = !!(opts && opts.export);
  var limit = exporting && opts.scenes;
  var lines = [];
  lines.push("# " + (s.title || "Untitled Script"));
  lines.push("");
  if (exporting && s.rows.length) {
    lines.push("_" + exportMetaLine() + "_");
    lines.push("");
  }
  if (!s.rows.length) {
    lines.push(exporting ? "_No scenes yet._" : "_No rows yet._");
  } else if (exporting) {
    var scenes = sceneFacts();
    lines.push("| # | Start | Status | Visual | Audio | Read |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    (limit ? s.rows.slice(0, limit) : s.rows).forEach(function (row, i) {
      var cell = mdSceneCellSource(row, i);
      lines.push("| " + [scenes[i].number, scenes[i].start, scenes[i].status.label].join(" | ") + " | " +
                 mdRichTableCell(cell.visual) + " | " + mdRichTableCell(cell.audio) + " | " +
                 mdReadCell(scenes[i]) + " |");
    });
  } else {
    lines.push("| # | Visual | Audio | Status |");
    lines.push("| --- | --- | --- | --- |");
    s.rows.forEach(function (row, i) {
      var cell = mdSceneCellSource(row, i);
      lines.push("| " + pad2(i + 1) + " | " + mdRichTableCell(cell.visual) + " | " +
                 mdRichTableCell(cell.audio) + " | " + (row.status || "todo") + " |");
    });
  }
  lines.push("");
  if (!limit) appendMarkdownTail(lines, { export: exporting });
  return lines.join("\n");
}

export function strBytes(s) { return new TextEncoder().encode(s); }

export function latin1Bytes(s) {
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function concatBytes(chunks) {
  var total = 0, i;
  for (i = 0; i < chunks.length; i++) total += chunks[i].length;
  var out = new Uint8Array(total), at = 0;
  for (i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
  return out;
}

var CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]); }
function u32(n) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]); }

export function zipWrite(entries) {
  var now = new Date();
  var dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() / 2) & 0x1f);
  var dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f);

  var local = [], central = [], offset = 0;
  entries.forEach(function (e) {
    var nameB = strBytes(e.name);
    var crc = crc32(e.data);
    var lh = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(nameB.length), u16(0), nameB
    ]);
    local.push(lh, e.data);
    central.push(concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB
    ]));
    offset += lh.length + e.data.length;
  });

  var cd = concatBytes(central);
  var eocd = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0)
  ]);
  return concatBytes([concatBytes(local), cd, eocd]);
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("no-decompression-stream");
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  var buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function zipRead(arrayBuffer) {
  var bytes = new Uint8Array(arrayBuffer);
  var dv = new DataView(arrayBuffer);

  var eocd = -1;
  for (var i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("not-a-zip");

  var count = dv.getUint16(eocd + 10, true);
  var cdOffset = dv.getUint32(eocd + 16, true);
  var files = {};
  var p = cdOffset;

  for (var n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    var method = dv.getUint16(p + 10, true);
    var compSize = dv.getUint32(p + 20, true);
    var nameLen = dv.getUint16(p + 28, true);
    var extraLen = dv.getUint16(p + 30, true);
    var commentLen = dv.getUint16(p + 32, true);
    var localOff = dv.getUint32(p + 42, true);
    var name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    var lNameLen = dv.getUint16(localOff + 26, true);
    var lExtraLen = dv.getUint16(localOff + 28, true);
    var dataStart = localOff + 30 + lNameLen + lExtraLen;
    var raw = bytes.subarray(dataStart, dataStart + compSize);
    files[name] = { method: method, raw: raw };
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    async get(name) {
      var f = files[name];
      if (!f) return null;
      return f.method === 0 ? f.raw : await inflateRaw(f.raw);
    },
    names: Object.keys(files)
  };
}

export function htmlToPlainText(html) {
  if (!html) return "";
  var c = inertBody(String(html).replace(/<br\s*\/?>/gi, "\n"));
  return (c.textContent || "").replace(/\u00A0/g, " ").trim();
}

export function xmlEscape(s) {
  return String(s == null ? "" : s)
    /* eslint-disable-next-line no-control-regex -- see the line above. */
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export var TAG_PRINT_COLORS = {
  prop: "764AA2",
  location: "2A7449",
  cast: "A53C75",
  vfx: "5E6C00",
  sound: "AB413E",
  gear: "44693C"
};

export function tagPrintColor(catId) {
  return Object.prototype.hasOwnProperty.call(TAG_PRINT_COLORS, catId) ? TAG_PRINT_COLORS[catId] : null;
}

export function htmlToRuns(html) {
  var container = inertBody(html);
  var runs = [];
  (function walk(node, fmt) {
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) {
        var t = (child.nodeValue || "").replace(/\u00A0/g, " ");
        if (t) runs.push({ text: t, b: fmt.b, i: fmt.i, u: fmt.u, s: fmt.s, mark: fmt.mark, href: fmt.href });
        return;
      }
      if (child.nodeType !== 1) return;
      var tag = child.tagName;
      if (tag === "BR") { runs.push({ text: "\n" }); return; }
      var next = {
        b: fmt.b || tag === "STRONG" || tag === "B",
        i: fmt.i || tag === "EM" || tag === "I",
        u: fmt.u || tag === "U",
        s: fmt.s || tag === "S" || tag === "STRIKE" || tag === "DEL",
        mark: fmt.mark || tag === "MARK",
        href: tag === "A" ? (child.getAttribute("href") || fmt.href) : fmt.href
      };
      walk(child, next);
    });
  })(container, { b: false, i: false, u: false, s: false, mark: false, href: null });
  return runs;
}

export function __init() {
  autoSaveEnabled = readAutoSavePref();

  window.addEventListener("blur", function () { flushAutoSave(); });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushAutoSave();
  });
}
