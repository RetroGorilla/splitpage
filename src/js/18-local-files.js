import { S } from "./_state.js";
import { absorbRemoteChange, flushEdits } from "./12a-undo.js";
import { fileHome, home, importHome, setHome } from "./_home.js";
import { SCHEMA_VERSION, loadLastFileHandle, rememberLastFileHandle } from "./00-prelude.js";
import { migrateRows } from "./02-state.js";
import {
  docIdEmbeddedIn,
  migrateDocument,
  standaloneHtmlFor,
  syncDocIdentity
} from "./02b-doc-id.js";
import { ensureBytes, missingInlineImages } from "./02c-blobs.js";
import { rowVideoLinks, videoLinkText } from "./02d-gallery.js";
import { refsIn } from "../../shared/blob-policy.js";
import {
  cloneState,
  pushSnapshot,
  setBaseState,
  stampRow,
  updateIdentityChip
} from "./03-sync.js";
import { beginBusy, endBusy, withBusyBar } from "./04b-busy.js";
import { pad2, render } from "./05-render.js";
import {
  productionEntries,
  resetProductionPanelState,
  tagCategory
} from "./07-production-tags.js";
import { breakdownRows, buildBreakdownCsv } from "./08-production-panels.js";
import { brollEntries } from "./08c-broll.js";
import { brollShotListForPrint, buildBrollCsv } from "./08d-broll-panel.js";
import { commentBodyText, commentEntries, formatTimestamp } from "./10-comments.js";
import {
  detectTwoColumnFormat,
  normalizeImportedRows,
  openGdocModal,
  openImportModal,
  parseImportRows
} from "./11-import.js";
import { clearDirty, markDirty, showToast } from "./12-dirty-toast.js";
import {
  linkTurnedOff,
  onServerDoc,
  openDriveModal,
  openServerPicker,
  publishToServer,
  serverSessionExpired
} from "./13-hosted.js";
import { openCollaborate } from "./13b-collaborate.js";
import { cellOf, toPlainText } from "./04c-doc-model.js";
import {
  autoSaveHalt,
  exportMetaLine,
  markdownExportImages,
  slugify,
  strBytes,
  toMarkdownDoc,
  toMarkdownTableDoc,
  toggleAutoSave,
  warnImagesLeftOut,
  zipWrite
} from "./14-export.js";
import {
  buildDocx,
  buildNarrationDocx,
  buildNarrationText,
  docxToRows,
  narrationRows
} from "./15-docx.js";
import { buildCsv, csvToRows } from "./16-csv.js";
import { buildBreakdownXlsx, buildBrollXlsx, buildScriptXlsx } from "./16b-xlsx.js";
import { buildPackingListPdf, buildPdf, buildShotListPdf, pdfCommentImagesFor, pdfImagesFor } from "./17-pdf.js";
import { offerFileMerge, resetMergeOffer } from "./18a-local-merge.js";
import { refreshFileMenu, setMenuItemLabel, startNewScript, toggleFileMenu } from "./18b-file-menu.js";
import { exportAgain, isExportAction, rememberExport } from "./18c-export-dialog.js";
import {
  applyMarkdownProject,
  parseMarkdownProject,
  parseSplitpageFile
} from "./20d-formats.js";
import {
  makeDesktopHandle, notifyDesktopDocumentState, openPrompterInBrowser, openPrompterInChromium
} from "./20f-desktop.js";
import { closeNewTabPage } from "./20j-newtab.js";
import { appActions } from "../legacy/app-actions.ts";

export function fileKindFromName(name) {
  var m = /\.([a-z0-9]+)$/i.exec(name || "");
  var ext = m ? m[1].toLowerCase() : "";
  if (ext === "docx") return "docx";
  if (ext === "csv") return "csv";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "txt") return "txt";
  if (ext === "splitpage") return "splitpage";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

export function updateFileChip() {
  updateHeaderFileChip();
  mirrorFileChipToWriter();
  updateReadonlyBanner();
  var menu = document.getElementById("file-menu");
  if (menu && !menu.hidden) refreshFileMenu();
}

function updateReadonlyBanner() {
  var banner = document.getElementById("readonly-banner");
  if (!banner) return;
  banner.hidden = !(S.serverMode.readOnly && onServerDoc());
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

function updateHeaderFileChip() {
  var chip = document.getElementById("file-chip");
  var saveBack = document.getElementById("menu-save-back");
  if (onServerDoc()) {
    chip.hidden = false;
    document.getElementById("file-chip-name").textContent = "On the server";
    var srvState = document.getElementById("file-chip-state");
    srvState.textContent = serverSessionExpired
      ? "· signed out — reload"
      : linkTurnedOff ? "· link turned off — not saving"
      : S.dirty && autoSaveHalt ? "· not saved yet"
      : (S.dirty ? "· saving…" : "· v" + home.rev + ", everyone sees this");
    srvState.classList.toggle("unsaved", serverSessionExpired || linkTurnedOff || !!S.dirty);
    saveBack.disabled = true;
    setMenuItemLabel(saveBack, "Save to file");
    return;
  }
  var imported = importHome();
  if (!imported) {
    chip.hidden = true;
    saveBack.disabled = true;
    setMenuItemLabel(saveBack, "Save to file");
    return;
  }
  chip.hidden = false;
  document.getElementById("file-chip-name").textContent = imported.name;
  var stateEl = document.getElementById("file-chip-state");
  stateEl.textContent = imported.dirty ? "· unsaved changes" : "· up to date";
  stateEl.classList.toggle("unsaved", !!imported.dirty);
  saveBack.disabled = false;
  setMenuItemLabel(saveBack, imported.inPlace ? "Save to " + imported.name : "Save a new copy of " + imported.name);
}

export function exportFileName(kind, baseName, opts) {
  opts = opts || {};
  if (kind === "breakdown") return baseName + " - breakdown.csv";
  if (kind === "b-roll csv") return baseName + " - b-roll shot list.csv";
  if (kind === "breakdown xlsx") return baseName + " - breakdown.xlsx";
  if (kind === "b-roll xlsx") return baseName + " - b-roll shot list.xlsx";
  if (kind === "b-roll pdf") return baseName + " - b-roll shot list.pdf";
  if (kind === "narration-docx") return baseName + " - narration.docx";
  if (kind === "narration-txt") return baseName + " - narration.txt";
  if (kind.indexOf("packing-") === 0) {
    var packCatId = kind.slice("packing-".length);
    var packCat = tagCategory(packCatId);
    return baseName + " - " + (packCat ? packCat.label : packCatId) + " packing list.pdf";
  }
  if (kind === "md-table") return baseName + " - two column.md";
  if (kind === "html") return baseName + " - SplitShare.html";
  if (kind === "md" && opts.imageBundle) return baseName + " (with images).zip";
  return baseName + "." + kind;
}

export function exportBaseName() {
  return importHome() ? importHome().name.replace(/\.[^.]+$/, "") : slugify(S.state.title);
}

export async function buildFileData(kind, baseName, opts) {
  opts = opts || {};
  await ensureBytes(refsIn(S.state));
  var filename = exportFileName(kind, baseName);
  if (kind === "docx") return { data: buildDocx(), filename: filename };
  if (kind === "csv") return { data: buildCsv(), filename: filename };
  if (kind === "breakdown") return { data: buildBreakdownCsv(), filename: filename };
  if (kind === "b-roll csv") return { data: buildBrollCsv(), filename: filename };
  if (kind === "xlsx") return { data: buildScriptXlsx(), filename: filename };
  if (kind === "breakdown xlsx") return { data: buildBreakdownXlsx(), filename: filename };
  if (kind === "b-roll xlsx") return { data: buildBrollXlsx(), filename: filename };
  if (kind === "b-roll pdf") return { data: buildShotListPdf(brollShotListForPrint(opts.brollView)), filename: filename };
  if (kind === "pdf") return { data: buildPdf(await pdfImagesFor(S.state.rows), await pdfCommentImagesFor()), filename: filename };
  if (kind === "txt") return { data: htmlToPlainScript(), filename: filename };
  if (kind === "narration-docx") return { data: buildNarrationDocx(), filename: filename };
  if (kind === "narration-txt") return { data: buildNarrationText(), filename: filename };
  if (kind.indexOf("packing-") === 0) return { data: buildPackingListPdf(kind.slice("packing-".length)), filename: filename };
  if (kind === "md-table") return { data: toMarkdownTableDoc(null, { export: true }), filename: filename };
  if (kind === "html") {
    warnImagesLeftOut(missingInlineImages(S.state).length, filename);
    return {
      data: standaloneHtmlFor(S.state, {
        title: (S.state.title || "Untitled Script") + " — SplitShare",
        description: exportMetaLine()
      }),
      filename: filename
    };
  }
  if (kind === "md" && opts.allowImageBundle) {
    var images = markdownExportImages();
    if (images.length) {
      var entries = [{ name: baseName + ".md", data: strBytes(toMarkdownDoc()) }];
      images.forEach(function (img) { entries.push({ name: img.path, data: img.bytes }); });
      return { data: zipWrite(entries), filename: exportFileName(kind, baseName, { imageBundle: true }) };
    }
  }
  return { data: toMarkdownDoc(), filename: filename };
}

function htmlToPlainScript() {
  var lines = [S.state.title || "Untitled Script", ""];
  S.state.rows.forEach(function (row, i) {
    lines.push("[" + pad2(i + 1) + "] VISUAL: " + toPlainText(cellOf(row.visualText)));
    rowVideoLinks(row).forEach(function (l) { lines.push("      VIDEO: " + videoLinkText(l)); });
    lines.push("      AUDIO: " + toPlainText(cellOf(row.audioText)));
    lines.push("");
  });

  var breakdown = breakdownRows();
  if (breakdown.length) {
    lines.push("PRODUCTION BREAKDOWN");
    lines.push("====================");
    lines.push("");
    breakdown.forEach(function (r) {
      var where = r.inScript === "no"
        ? "not in script"
        : r.mentions + " mention" + (r.mentions === 1 ? "" : "s") +
          (r.scenes.length ? ", scene" + (r.scenes.length === 1 ? " " : "s ") + r.scenes.join(", ") : "");
      lines.push(r.categoryLabel + ": " + r.name +
        "  [" + r.statusLabel + "]" +
        (r.owner ? "  —  " + r.owner : "") +
        "  (" + where + ")");
      if (r.notes) {
        r.notes.split(/\r\n|\r|\n/).forEach(function (l) { lines.push("    " + l); });
      }
    });
    lines.push("");
  }

  var comments = commentEntries({ pieces: true });
  if (comments.length) {
    lines.push("COMMENTS");
    lines.push("========");
    lines.push("");
    comments.forEach(function (c) {
      lines.push(c.location + (c.resolved ? " (resolved)" : "") +
                 "  —  " + c.author + (c.when ? ", " + c.when : ""));
      if (c.quoted) {
        c.quoted.split(/\r\n|\r|\n/).forEach(function (l) { lines.push('  "' + l + '"'); });
      }
      (commentBodyText(c) || "(empty)").split(/\r\n|\r|\n/).forEach(function (l) { lines.push("  " + l); });
      c.replies.forEach(function (rp) {
        lines.push("");
        var prefix = "  > " + rp.author + (rp.when ? ", " + rp.when : "") + ": ";
        (commentBodyText(rp) || "(empty)").split(/\r\n|\r|\n/).forEach(function (l, i) {
          lines.push((i === 0 ? prefix : "    ") + l);
        });
      });
      lines.push("");
      lines.push("------------------------------");
      lines.push("");
    });
  }
  return lines.join("\n");
}

export async function parseProjectFileState(file, opts) {
  var kind = fileKindFromName(file.name);
  if (kind !== "splitpage" && kind !== "md" && kind !== "html") return null;

  var text;
  try {
    text = await file.text();
  } catch (e) {
    return { error: "unreadable" };
  }

  if (kind === "splitpage") {
    var native;
    try {
      native = parseSplitpageFile(text);
    } catch (e) {
      return { error: "not-splitpage" };
    }
    var nativeEmbedded = docIdEmbeddedIn(native);
    return { state: migrateDocument(native, { kind: "file" }), kind: "splitpage", docIdEmbedded: nativeEmbedded };
  }

  if (kind === "html") {
    var doc = new DOMParser().parseFromString(text, "text/html");
    var dataEl = doc.getElementById("state-data");
    var legacy;
    try {
      legacy = JSON.parse(dataEl.textContent);
    } catch (e) {
      return { error: "not-splitpage" };
    }
    var legacyEmbedded = docIdEmbeddedIn(legacy);
    return { state: migrateDocument(legacy, { kind: "file" }), kind: "html", docIdEmbedded: legacyEmbedded };
  }

  var project;
  try {
    project = parseMarkdownProject(text);
  } catch (e) {
    project = null;
  }
  if (!project) return null;
  var reconciled = await applyMarkdownProject(project, opts);
  return { state: reconciled, kind: "md", docIdEmbedded: !!project.docIdEmbedded };
}

export async function openProjectFile(file, handle, opts) {
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

export function adoptProjectState(newState, file, handle, kind, opts) {
  opts = opts || {};
  if (typeof closeNewTabPage === "function") closeNewTabPage();
  if (!opts.skipSnapshot && S.state && S.state.rows.length) pushSnapshot("Before opening " + file.name);

  S.state = newState;
  setBaseState(cloneState(S.state), "adoptProjectState: the project file as it was just read");
  setHome("file", { handle: handle || null, format: kind, lastModified: file.lastModified || null,
                    name: file.name, diskBase: cloneState(S.state) });
  resetProductionPanelState();

  S.docIdWrittenOut = true;
  clearDirty();
  render();
  updateIdentityChip();
  updateFileChip();
  var commentNote = S.state.comments.length
    ? ", " + S.state.comments.length + " comment" + (S.state.comments.length === 1 ? "" : "s") : "";
  if (!opts.silent) showToast((opts.resumed ? "Resumed " : "Opened ") + (S.state.title || file.name) + " — " +
    S.state.rows.length + " row" + (S.state.rows.length === 1 ? "" : "s") + commentNote, "ok");

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
    await openProjectFile(file, handle, { skipSnapshot: !S.dirty, resumed: true });
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
        newRows = normalizeImportedRows(parseImportRows(parsed.looseText, looseMode));
      }
    } else if (kind === "csv") {
      newRows = csvToRows(await file.text());
    } else {
      var text = await file.text();
      var mode = detectTwoColumnFormat(text) ? "twocolumn" : "paragraph";
      newRows = normalizeImportedRows(parseImportRows(text, mode));
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

  if (!opts.reload && S.state.rows.length) pushSnapshot("Before opening " + file.name);

  newRows.forEach(stampRow);
  var openedTitle = newTitle || file.name.replace(/\.[^.]+$/, "");
  if (opts.reload) {
    flushEdits();
    S.state.rows = newRows;
    S.state.title = openedTitle;
    absorbRemoteChange();
  } else {
    S.state = migrateRows({ schema: SCHEMA_VERSION, title: openedTitle, rows: newRows });
    setBaseState(cloneState(S.state), "loadFileIntoEditor: the imported document as it was just read");
    resetProductionPanelState();
    S.docIdWrittenOut = false;
  }

  var imported = setHome("import", {
    name: file.name,
    handle: handle || null,
    format: kind,
    inPlace: !!(handle && handle.createWritable),
    dirty: false,
    lastModified: file.lastModified || null,
    size: file.size || null
  });

  markDirty();
  imported.dirty = false;
  if (typeof closeNewTabPage === "function") closeNewTabPage();
  render();
  updateIdentityChip();
  updateFileChip();
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  if (S.DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  showToast(opts.reload
    ? "Reloaded " + file.name + " — " + newRows.length + " row" + (newRows.length === 1 ? "" : "s")
    : "Opened " + file.name + " — " + newRows.length + " row" + (newRows.length === 1 ? "" : "s") +
      " — as a new document", "ok");
}

export async function openLocalFile() {
  if (S.DESKTOP) {
    var entry = await S.DESKTOP.openFileDialog();
    if (!entry) return;
    var r = await S.DESKTOP.routeOpen({ kind: "file", fileId: entry.id });
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

export function mimeForFilename(filename) {
  var ext = (/\.([a-z0-9]+)$/i.exec(filename || "") || ["", ""])[1].toLowerCase();
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "csv") return "text/csv";
  if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "pdf") return "application/pdf";
  if (ext === "html") return "text/html";
  if (ext === "splitpage") return "application/json";
  if (ext === "zip") return "application/zip";
  return "text/plain";
}

export async function deliverFile(filename, data, opts) {
  opts = opts || {};
  if (S.DESKTOP) {
    try {
      var ext = (/\.([a-z0-9]+)$/i.exec(filename) || ["", ""])[1].toLowerCase();
      var picked = await S.DESKTOP.saveFileDialog({
        suggestedName: filename,
        filters: [{ name: ext ? ext.toUpperCase() + " file" : "File", extensions: ext ? [ext] : [] }]
      });
      if (!picked) return false;
      var bytes;
      if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
      else if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else bytes = strBytes(String(data));
      await S.DESKTOP.writeFile(picked.id, bytes);
      showToast(opts.savedMsg || ("Saved " + filename), "ok");
      return true;
    } catch (err) {
      showToast("Could not save the file. Please try again.", "error");
      return false;
    }
  }
  try {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mimeForFilename(filename) });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    showToast(opts.savedMsg || ("Saved " + filename), "ok");
    return true;
  } catch (err) {
    showToast("Could not save the file. Please try again.", "error");
    return false;
  }
}

export async function checkFileConflict(handle, lastModified) {
  if (!lastModified) return { ok: true };
  var current;
  try {
    current = await handle.getFile();
  } catch (e) {
    return { ok: false, current: null };
  }
  if (current.lastModified && current.lastModified !== lastModified) {
    return { ok: false, current: current };
  }
  return { ok: true };
}

export var fileConflictCtx = { kind: "import" };
var fileConflictShowToken = 0;

function fileConflictHome() {
  return fileConflictCtx && fileConflictCtx.kind === "project" ? fileHome() : importHome();
}

export async function saveBackToFile(opts) {
  var imported = importHome();
  if (!imported) return;
  var baseName = imported.name.replace(/\.[^.]+$/, "");
  var built;
  try {
    built = await buildFileData(imported.format, baseName);
  } catch (e) {
    showToast("Could not build the file.", "error");
    return;
  }
  var docIdAtBuild = S.state.docId;
  var seqAtBuild = S.editSeq;
  function bytesStillCurrent() {
    return importHome() === imported && S.state.docId === docIdAtBuild && S.editSeq === seqAtBuild;
  }

  if (imported.handle && imported.handle.createWritable) {
    if (!opts || !opts.force) {
      var check = await checkFileConflict(imported.handle, imported.lastModified);
      if (!check.ok) {
        showFileConflict(imported.name, check.current, { kind: "import" });
        return;
      }
    }
    try {
      var writable = await imported.handle.createWritable();
      await writable.write(built.data);
      await writable.close();
      if (bytesStillCurrent()) imported.dirty = false;
      try {
        var after = await imported.handle.getFile();
        imported.lastModified = after.lastModified;
        imported.size = after.size;
      } catch (e) { }
      updateFileChip();
      showToast("Saved to " + imported.name, "ok");
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      imported.inPlace = false;
      updateFileChip();
    }
  }

  var ok = await deliverFile(imported.name, built.data, {
    savedMsg: "Saved a copy of " + imported.name + " to your downloads"
  });
  if (ok) { if (bytesStillCurrent()) imported.dirty = false; updateFileChip(); }
}

export function showFileConflict(fileName, currentFile, ctx) {
  fileConflictCtx = ctx || { kind: "import" };
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
  var probe = offerFileMerge(currentFile, fileConflictHome());
  var timer = setTimeout(show, 1500);
  probe.then(function () { clearTimeout(timer); show(); },
             function () { clearTimeout(timer); show(); });
}

export function closeFileConflict() {
  fileConflictShowToken++;
  document.getElementById("file-conflict-modal").hidden = true;
  resetMergeOffer();
}

export async function reloadFileFromDisk() {
  closeFileConflict();
  var imported = importHome();
  if (!imported || !imported.handle) return;
  try {
    pushSnapshot("Before reloading " + imported.name + " from disk");
    await loadFileIntoEditor(await imported.handle.getFile(), imported.handle, { reload: true });
  } catch (e) {
    showToast("Could not re-read that file.", "error");
  }
}

export async function reloadProjectFromDisk() {
  closeFileConflict();
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

export async function exportNarration(kind) {
  if (!narrationRows().length) {
    showToast("There is no narration to export yet — the Audio column is empty.", "warn");
    return;
  }
  await exportAs(kind);
}

export async function exportPackingList(catId) {
  var cat = tagCategory(catId);
  var has = productionEntries().some(function (e) { return e.cat.id === catId; });
  if (!has) {
    showToast("Nothing tagged " + (cat ? cat.label : catId) + " yet — nothing to pack.", "warn");
    return;
  }
  await exportAs("packing-" + catId);
}

export async function exportBrollList(action) {
  if (!brollEntries(true).length) {
    showToast("There is no b-roll to export yet — start a Visual line with B-roll:", "warn");
    return;
  }
  if (action === "export-broll-csv") await exportAs("b-roll csv");
  else if (action === "export-broll-xlsx") await exportAs("b-roll xlsx");
  else await exportAs("b-roll pdf", { brollView: { filter: "all", group: "scene" } });
}

export function handleFileMenuAction(action) {
  if (action !== "autosave" && action !== "toggle-hide-shot" && action !== "toggle-rundown-min") toggleFileMenu(false);
  if (isExportAction(action)) rememberExport(action);
  if (appActions.has(action)) {
    var outcome = appActions.invoke(action, "menu");
    if (outcome.kind === "unavailable" && outcome.reason) showToast(outcome.reason, "warn");
    return;
  }
  if (!S.state && action !== "drive-open") {
    showToast("Still loading…", "warn"); return;
  }
  if (action === "new") startNewScript();
  else if (action === "export-again") exportAgain();
  else if (action === "paste") openImportModal();
  else if (action === "gdoc-import") openGdocModal();
  else if (action === "save-back") saveBackToFile();
  else if (action === "autosave") toggleAutoSave();
  else if (action === "export-docx") exportAs("docx");
  else if (action === "export-md") exportAs("md");
  else if (action === "export-md-table") exportAs("md-table");
  else if (action === "export-csv") exportAs("csv");
  else if (action === "export-xlsx") exportAs("xlsx");
  else if (action === "export-breakdown") exportAs("breakdown");
  else if (action === "export-breakdown-xlsx") exportAs("breakdown xlsx");
  else if (action === "export-pdf") exportAs("pdf");
  else if (action === "export-html") exportAs("html");
  else if (action === "export-narration-docx") exportNarration("narration-docx");
  else if (action === "export-narration-txt") exportNarration("narration-txt");
  else if (action === "export-packing-gear") exportPackingList("gear");
  else if (action === "export-packing-prop") exportPackingList("prop");
  else if (action === "export-broll-pdf" || action === "export-broll-csv" || action === "export-broll-xlsx") exportBrollList(action);
  else if (action === "drive-open") openDriveModal();
  else if (action === "server-open") openServerPicker();
  else if (action === "server-publish") publishToServer();
  else if (action === "collaborate") openCollaborate();
  else if (action === "prompter-open-in-browser") openPrompterInBrowser();
  else if (action === "prompter-open-in-chromium") openPrompterInChromium();
}

export function __init() {}
