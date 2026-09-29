import { S } from "./_state.js";
import { fileHome } from "./_home.js";
import { legacyMdToHtml, makeId, migrateRows } from "./02-state.js";
import {
  adoptRestoredState,
  deriveDocId,
  docIdEmbeddedIn,
  docIdEvents,
  initDocIdentityChannel,
  migrateDocument,
  reassignDocId,
  standaloneHtmlFor
} from "./02b-doc-id.js";
import { inlineStateImages, internDataUrl, missingInlineImages, queuePersist, rowImageDataUrl } from "./02c-blobs.js";
import { cloneState, setBaseState, stashLocalWork } from "./03-sync.js";
import { plainText, safeImageSrc, sanitizeHtml } from "./04-richtext.js";
import { tagFieldOccurrences } from "./07-production-tags.js";
import { handleImportFile, parseMarkdownTable } from "./11-import.js";
import { audioDirectionsHtml } from "./15-docx.js";
import {
  autoSaveEnabled,
  autoSaveHalt,
  autoSaveIdleTimer,
  autoSaveMaxTimer,
  autoSaveTarget,
  autoSaveTiming,
  flushAutoSave,
  mdSceneCellSource,
  saveDoc,
  toMarkdownTableDoc,
  toggleAutoSave
} from "./14-export.js";
import { openProjectFile } from "./18-local-files.js";

export function fileStateFor(s) {
  var copy = migrateRows(cloneState(s || S.state));
  inlineStateImages(copy);
  return copy;
}

export function buildSplitpageFile(s) {
  return JSON.stringify(fileStateFor(s), null, 2);
}

export function fileImagesMissing(s) {
  return missingInlineImages(s || S.state);
}

export function parseSplitpageFile(text) {
  var parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.rows)) {
    throw new Error("not-a-splitpage-file");
  }
  return parsed;
}

var MD_DATA_INFO = "splitpage";
var MD_DATA_NOTE = "<!-- splitpage: everything below is Splitpage's own record of this " +
  "script. Edit the text above freely; leave this block alone. -->";

function splitpageDataFence(json) {
  var longest = 3, re = /~{3,}/g, m;
  while ((m = re.exec(json)) !== null) {
    if (m[0].length > longest) longest = m[0].length;
  }
  return new Array(Math.max(4, longest + 1) + 1).join("~");
}

export function buildMarkdownProject(s) {
  s = s || S.state;
  var json = buildSplitpageFile(s);
  var fence = splitpageDataFence(json);
  return toMarkdownTableDoc(s) + "\n" + MD_DATA_NOTE + "\n" +
    fence + MD_DATA_INFO + "\n" + json + "\n" + fence + "\n";
}

function findMarkdownDataBlock(text) {
  var lines = String(text || "").replace(/\r\n|\r/g, "\n").split("\n");
  var openAt = -1, fenceLen = 0, i;
  for (i = 0; i < lines.length; i++) {
    var m = /^(~{3,})\s*splitpage\s*$/.exec(lines[i]);
    if (m) { openAt = i; fenceLen = m[1].length; }
  }
  if (openAt === -1) return null;
  var closeRe = new RegExp("^~{" + fenceLen + ",}\\s*$");
  var closeAt = -1;
  for (i = openAt + 1; i < lines.length; i++) {
    if (closeRe.test(lines[i])) { closeAt = i; break; }
  }
  return {
    json: lines.slice(openAt + 1, closeAt === -1 ? lines.length : closeAt).join("\n"),
    before: lines.slice(0, openAt).join("\n")
  };
}

export function parseMarkdownProject(text) {
  var block = findMarkdownDataBlock(text);
  if (!block) return null;
  var parsed;
  try { parsed = parseSplitpageFile(block.json); } catch (e) { return null; }

  var sceneSection = block.before.split(/^##\s/m)[0];
  var heading = /^#\s+(.+)$/m.exec(block.before);
  var docIdEmbedded = docIdEmbeddedIn(parsed);
  return {
    state: migrateDocument(parsed, { kind: "file" }),
    docIdEmbedded: docIdEmbedded,
    table: parseMarkdownTable(sceneSection, { keepEmpty: true }),
    title: heading ? heading[1].trim() : null
  };
}

export var MD_IMAGE_PREFIX_RE = /^!\[[^\]]*\]\((data:image\/[^)\s]+)\)\s*(?:<br\s*\/?>)?\s*/i;

function markdownCellToHtml(s, md) {
  var html = sanitizeHtml(legacyMdToHtml(String(md == null ? "" : md).replace(/\u00A0/g, " ")));
  var names = (s.productionTags || []).slice().sort(function (a, b) {
    return String(b.name || "").length - String(a.name || "").length;
  });
  names.forEach(function (t) {
    var name = String(t.name || "").trim();
    if (!name) return;
    var res = tagFieldOccurrences(html, name, t.cat, name, false);
    if (res.hits) html = res.html;
  });
  return sanitizeHtml(html);
}

function markdownAudioCellToHtml(s, md) {
  return audioDirectionsHtml(markdownCellToHtml(s, md));
}

function applyMarkdownVisualCell(s, row, md) {
  var text = String(md == null ? "" : md);
  var m = MD_IMAGE_PREFIX_RE.exec(text);
  var rec = m ? internDataUrl(safeImageSrc(m[1]) || "") : null;
  if (rec) queuePersist([rec.sha256]);
  var uncarried = !m && row.imageRef && !rowImageDataUrl(row);
  delete row.visualImage;
  if (!uncarried) {
    var was = row.imageRef && row.imageRef.sha256;
    row.imageRef = rec || null;
    if (!rec || rec.sha256 !== was) delete row.imageAnnotation;
  }
  if (m) text = text.slice(m[0].length);
  row.visualText = markdownCellToHtml(s, text);
}

function markdownCellChanged(cellText, was) {
  return String(cellText == null ? "" : cellText).trim() !== was;
}

function markdownVisualCellChanged(cellText, was) {
  if (!markdownCellChanged(cellText, was.visual)) return false;
  var text = String(cellText == null ? "" : cellText).trim();
  var m = MD_IMAGE_PREFIX_RE.exec(text);
  if (!m) return true;
  var rec = internDataUrl(safeImageSrc(m[1]) || "");
  if (!rec || rec.sha256 !== was.image) return true;
  return text.slice(m[0].length).trim() !== was.visualText;
}

function sceneCellEdits(row, i, cells) {
  var was = mdSceneCellSource(row, i), model = null;
  function modelWas() { return model || (model = mdSceneCellSource(row, i, true)); }
  return {
    visual: markdownVisualCellChanged(cells.visualText, was) && markdownVisualCellChanged(cells.visualText, modelWas()),
    audio: markdownCellChanged(cells.audioText, was.audio) && markdownCellChanged(cells.audioText, modelWas().audio)
  };
}

function reconcileMarkdownRows(s, table) {
  var changed = 0;
  s.rows.forEach(function (row, i) {
    var cells = table[i];
    if (!cells) return;
    var edits = sceneCellEdits(row, i, cells);
    if (edits.visual) {
      applyMarkdownVisualCell(s, row, cells.visualText);
      changed++;
    }
    if (edits.audio) {
      row.audioText = markdownAudioCellToHtml(s, cells.audioText);
      changed++;
    }
  });
  return changed;
}

function rowsFromMarkdownTable(s, table) {
  return table.map(function (cells, i) {
    var old = s.rows[i] || null;
    var row = old || { id: makeId(), status: "todo", imageRef: null, updatedAt: "", updatedBy: null };
    var edits = old ? sceneCellEdits(old, i, cells) : { visual: true, audio: true };
    if (edits.visual) {
      applyMarkdownVisualCell(s, row, cells.visualText);
    }
    if (edits.audio) {
      row.audioText = markdownAudioCellToHtml(s, cells.audioText);
    }
    return row;
  });
}

var pendingMdRowChoice = null;

function askMarkdownRowChoice(blockRows, tableRows) {
  return new Promise(function (resolve) {
    var modal = document.getElementById("md-rows-modal");
    if (!modal) { resolve("keep"); return; }
    document.getElementById("md-rows-detail").textContent =
      "This file's own record has " + blockRows + " scene" + (blockRows === 1 ? "" : "s") +
      ", but the table in it now has " + tableRows + ". Scenes were added or removed " +
      "somewhere other than Splitpage, so the two can no longer be lined up scene by scene.";
    pendingMdRowChoice = resolve;
    modal.hidden = false;
  });
}

export function finishMarkdownRowChoice(choice) {
  var modal = document.getElementById("md-rows-modal");
  if (modal) modal.hidden = true;
  var resolve = pendingMdRowChoice;
  pendingMdRowChoice = null;
  if (resolve) resolve(choice === "table" ? "table" : "keep");
}

export async function applyMarkdownProject(proj, opts) {
  var s = proj.state;
  if (proj.title && proj.title !== s.title) s.title = plainText(proj.title).slice(0, 300);

  if (proj.table.length === s.rows.length) {
    reconcileMarkdownRows(s, proj.table);
  } else if (opts && opts.noAsk) {
    /* headless: keep rows as-is, no prompt */
  } else {
    var choice = await askMarkdownRowChoice(s.rows.length, proj.table.length);
    if (choice === "table") s.rows = rowsFromMarkdownTable(s, proj.table);
  }
  return migrateRows(s);
}

export function __init() {
  window.__splitpageFormats = {
    buildSplitpage: buildSplitpageFile,
    buildMarkdown: buildMarkdownProject,
    parseMarkdown: parseMarkdownProject,
    buildStandaloneHtml: function () { return standaloneHtmlFor(S.state); },
    docId: function () { return S.state ? S.state.docId : null; },
    writtenOut: function () { return S.docIdWrittenOut; },
    deriveDocId: deriveDocId,
    adoptRestoredState: adoptRestoredState,
    reassignDocId: reassignDocId,
    docIdEvents: docIdEvents,
    initDocIdentityChannel: initDocIdentityChannel,
    openFile: function (file, handle) { return openProjectFile(file, handle || null, { skipSnapshot: true }); },
    importFile: function (file) { return handleImportFile(file); },
    save: function (opts) { return saveDoc(opts || {}); },
    autosave: {
      timing: function () { return autoSaveTiming; },
      enabled: function () { return autoSaveEnabled; },
      halt: function () { return autoSaveHalt; },
      target: function () { return autoSaveTarget(); },
      pending: function () { return !!(autoSaveIdleTimer || autoSaveMaxTimer); },
      toggle: toggleAutoSave,
      flush: flushAutoSave
    },
    migrate: migrateRows,
    stash: stashLocalWork,
    clone: cloneState,
    state: function () { return S.state; },
    docFile: function () {
      var f = fileHome();
      return { name: f && f.handle ? f.handle.name : null, kind: f ? f.format : null,
               lastModified: f ? f.lastModified : null };
    },
    hasDiskBase: function () { return !!(fileHome() && fileHome().diskBase); },
    forgetDiskBase: function () { if (fileHome()) fileHome().diskBase = null; setBaseState(null, "__splitpageFormats.forgetDiskBase: test hook, drives the two-way fallback"); return true; }
  };
}
