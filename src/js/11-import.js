import { normalizeImportedRows } from "../adapters/formats/import-rows.ts";
import { pushSnapshot, stampRow } from "./03-sync.js";
import { cssAttr, sanitizeHtml } from "./04-richtext.js";
import { declineBrollAnchoring } from "./08c-broll.js";
import { anchorBrollInRows } from "../adapters/production/broll-anchors.ts";
import { productionReaders } from "../legacy/document-ports.ts";
import { cellOf, inertBody } from "../legacy/richtext.ts";
import { randomIds } from "../adapters/identity/ids.ts";
import { markDirty } from "./12-dirty-toast.js";
import { docxToRows } from "../adapters/formats/docx.ts";
import { csvToRows } from "../adapters/formats/csv.ts";
import { importModeTouched, resetImportMode } from "../application/import-mode.ts";
import { importRowsCommand } from "../application/commands/import-rows.ts";
import { escapeHtml, truncateForPreview } from "../core/document/text-policy.ts";
import { REVIEW_ONLY, editAllowed, readSession, runCommand, sessionStamps } from "../legacy/session-bridge.ts";
import { captureOperation, stillOwns } from "../legacy/transition-bridge.ts";
import { showToast } from "../legacy/effects-bridge.ts";
import { fileKindFromName } from "../../shared/file-names.js";
import { desktopPort } from "../adapters/desktop/desktop-port.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";

function splitImportText(text, mode) {
  var norm = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!norm) return [];
  var chunks;
  if (mode === "line") {
    chunks = norm.split(/\n/);
  } else if (mode === "sentence") {
    var flattened = norm.replace(/\n+/g, " ");
    chunks = flattened.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [flattened];
  } else {
    chunks = norm.split(/\n\s*\n+/);
  }
  return chunks.map(function (c) { return c.trim(); }).filter(Boolean);
}

var VISUAL_LABEL_RE = /^\s*(visual|video|scene|shot|b-?roll|image|screen)\s*:\s*(.*)$/i;
var AUDIO_LABEL_RE = /^\s*(audio|vo|voiceover|voice-over|narration|dialogue|script)\s*:\s*(.*)$/i;
var VISUAL_HEADER_RE = /^(visual|video|scene|shot|b-?roll|image|screen)s?$/i;
var AUDIO_HEADER_RE = /^(audio|vo|voiceover|voice-over|narration|dialogue|script)s?$/i;

export function detectTwoColumnFormat(text) {
  if (parseStackedMarkdownExport(text)) return "stacked";
  var norm = markdownExportScript(String(text || "")).replace(/\r\n/g, "\n");
  var lines = norm.split("\n");
  var nonBlank = lines.filter(function (l) { return l.trim() !== ""; });
  if (nonBlank.length < 2) return null;

  var pipeLines = nonBlank.filter(function (l) { return l.indexOf("|") !== -1; });
  if (pipeLines.length >= 2 && pipeLines.length / nonBlank.length > 0.6) return "table";

  var tabLines = nonBlank.filter(function (l) { return l.indexOf("\t") !== -1; });
  if (tabLines.length / nonBlank.length > 0.6) return "tab";

  var hasVisualLabel = nonBlank.some(function (l) { return VISUAL_LABEL_RE.test(l); });
  var hasAudioLabel = nonBlank.some(function (l) { return AUDIO_LABEL_RE.test(l); });
  var firstIsLabel = VISUAL_LABEL_RE.test(nonBlank[0]) || AUDIO_LABEL_RE.test(nonBlank[0]);
  if (hasVisualLabel && hasAudioLabel && firstIsLabel) return "labels";

  return null;
}

function columnIndicesFromHeader(header) {
  var visualIdx = header.findIndex(function (c) { return VISUAL_HEADER_RE.test(c.trim()); });
  var audioIdx = header.findIndex(function (c) { return AUDIO_HEADER_RE.test(c.trim()); });
  if (visualIdx !== -1 && audioIdx === -1) audioIdx = visualIdx === 0 ? 1 : 0;
  else if (audioIdx !== -1 && visualIdx === -1) visualIdx = audioIdx === 0 ? 1 : 0;
  return { visualIdx: visualIdx, audioIdx: audioIdx };
}

function splitTableRowCells(line) {
  var trimmed = line.replace(/^\|/, "").replace(/\|$/, "");
  var cells = [], current = "";
  for (var i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") { current += "|"; i++; continue; }
    if (trimmed[i] === "|") { cells.push(current.trim()); current = ""; continue; }
    current += trimmed[i];
  }
  cells.push(current.trim());
  return cells;
}

var MD_EXPORT_TAIL_RE = /^\s*##\s+(Production breakdown|B-roll shot list|Comments)\s*$/;
var MD_OWN_TABLE_HEADERS = ["#|visual|audio|status", "#|start|status|visual|audio|read"];

function markdownExportScript(text) {
  var lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  var sawHeader = false;
  for (var i = 0; i < lines.length; i++) {
    if (!sawHeader) {
      sawHeader = lines[i].indexOf("|") !== -1 &&
        MD_OWN_TABLE_HEADERS.indexOf(splitTableRowCells(lines[i].trim()).join("|").toLowerCase()) !== -1;
    } else if (MD_EXPORT_TAIL_RE.test(lines[i])) {
      return lines.slice(0, i).join("\n");
    }
  }
  return text;
}

var MD_SCENE_HEADING_RE = /^###\s+Scene\s+\d+(\s+·\s+\d+(:\d\d)+)?\s*$/;
var MD_SCENE_META_RE = /^_\d+ scenes? · (est\. )?\S+ running time( · .*)?_$/;
var MD_SCENE_FACTS_RE = /^\*\*[^*]+\*\* · Read \d+(:\d\d)+(, set by hand)?$/;
var MD_MARKER_RE = /<sup>\d+<\/sup>/g;
var MD_VISUAL_LEAD_RE = /^\*Visual —\*\s?/;
var MD_SCENE_MEDIA_RE = /^(!\[visual [^\]]*\]\(images\/[^)]*\)|▶ .*)$/;

function parseStackedMarkdownExport(text) {
  var lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  var i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i === lines.length || !/^#\s+\S/.test(lines[i])) return null;
  for (i++; i < lines.length && !MD_SCENE_HEADING_RE.test(lines[i].trim()); i++) {
    if (lines[i].trim() && !MD_SCENE_META_RE.test(lines[i].trim())) return null;
  }
  if (i === lines.length) return null;

  var scenes = [], timed = [];
  for (; i < lines.length; i++) {
    if (MD_EXPORT_TAIL_RE.test(lines[i])) break;
    if (MD_SCENE_HEADING_RE.test(lines[i].trim())) {
      scenes.push([]);
      timed.push(lines[i].indexOf("·") !== -1);
    } else scenes[scenes.length - 1].push(lines[i]);
  }
  return scenes.map(function (sc, n) {
    function cellText(s) {
      s = s.replace(MD_MARKER_RE, "");
      return timed[n] ? s.replace(/ {2}\n/g, "\n") : s;
    }
    var end = sc.length;
    while (end > 0 && !sc[end - 1].trim()) end--;
    if (end > 0 && sc[end - 1].trim() === "---") end--;
    sc = sc.slice(0, end);
    var k = 0;
    while (k < sc.length && !sc[k].trim()) k++;
    if (k < sc.length && MD_SCENE_FACTS_RE.test(sc[k].trim())) k++;
    while (k < sc.length && (!sc[k].trim() || MD_SCENE_MEDIA_RE.test(sc[k].trim()))) k++;
    var visual = [];
    if (k < sc.length && MD_VISUAL_LEAD_RE.test(sc[k])) {
      visual.push(sc[k].replace(MD_VISUAL_LEAD_RE, ""));
      for (k++; k < sc.length && sc[k].trim(); k++) visual.push(sc[k]);
    }
    var audio = sc.slice(k).join("\n").trim();
    return {
      visualText: cellText(visual.join("\n")).trim(),
      audioText: audio === "_(blank scene)_" ? "" : cellText(audio)
    };
  });
}

export function parseMarkdownTable(text, opts) {
  opts = opts || {};
  var lines = markdownExportScript(text).replace(/\r\n/g, "\n").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  var rows = [];
  lines.forEach(function (line) {
    if (line.indexOf("|") === -1) return;
    var cells = splitTableRowCells(line);
    if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c) || c === ""; })) return;
    rows.push(cells);
  });
  if (!rows.length) return [];
  var visualIdx = 0, audioIdx = 1, startIdx = 0, statusIdx = -1;
  var header = rows[0].map(function (c) { return c.toLowerCase(); });
  var idxs = columnIndicesFromHeader(header);
  if (idxs.visualIdx !== -1 || idxs.audioIdx !== -1) {
    startIdx = 1;
    if (idxs.visualIdx !== -1) visualIdx = idxs.visualIdx;
    if (idxs.audioIdx !== -1) audioIdx = idxs.audioIdx;
    statusIdx = header.findIndex(function (c) { return c.trim() === "status"; });
  }
  var out = [];
  for (var i = startIdx; i < rows.length; i++) {
    var v = rows[i][visualIdx] || "", a = rows[i][audioIdx] || "";
    if (!v && !a && !opts.keepEmpty) continue;
    out.push({
      visualText: v,
      audioText: a,
      statusText: statusIdx === -1 ? "" : (rows[i][statusIdx] || "")
    });
  }
  return out;
}

function parseTabDelimited(text) {
  var lines = text.replace(/\r\n/g, "\n").split("\n");
  var rows = [];
  lines.forEach(function (line) {
    if (line.trim() === "") return;
    var idx = line.indexOf("\t");
    if (idx === -1) { rows.push([line.trim(), ""]); return; }
    rows.push([line.slice(0, idx).trim(), line.slice(idx + 1).replace(/\t/g, " ").trim()]);
  });
  if (!rows.length) return [];
  var visualIdx = 0, audioIdx = 1, startIdx = 0;
  var header = rows[0].map(function (c) { return c.toLowerCase(); });
  var idxs = columnIndicesFromHeader(header);
  if (idxs.visualIdx !== -1 || idxs.audioIdx !== -1) {
    startIdx = 1;
    if (idxs.visualIdx !== -1) visualIdx = idxs.visualIdx;
    if (idxs.audioIdx !== -1) audioIdx = idxs.audioIdx;
  }
  var out = [];
  for (var i = startIdx; i < rows.length; i++) {
    var v = rows[i][visualIdx] || "", a = rows[i][audioIdx] || "";
    if (v || a) out.push({ visualText: v, audioText: a });
  }
  return out;
}

function parseLabeledLines(text) {
  var lines = text.replace(/\r\n/g, "\n").split("\n");
  var rows = [];
  var current = null, currentField = null;
  lines.forEach(function (line) {
    var vMatch = line.match(VISUAL_LABEL_RE);
    var aMatch = !vMatch && line.match(AUDIO_LABEL_RE);
    if (vMatch) {
      if (current && (current.visualText || current.audioText)) rows.push(current);
      current = { visualText: vMatch[2] || "", audioText: "" };
      currentField = "visualText";
      return;
    }
    if (aMatch) {
      if (!current) current = { visualText: "", audioText: "" };
      current.audioText = (current.audioText ? current.audioText + " " : "") + (aMatch[2] || "");
      currentField = "audioText";
      return;
    }
    if (line.trim() === "" || !current || !currentField) return;
    current[currentField] = (current[currentField] ? current[currentField] + " " : "") + line.trim();
  });
  if (current && (current.visualText || current.audioText)) rows.push(current);
  return rows;
}

function parseAlternatingLines(text) {
  var lines = text.replace(/\r\n/g, "\n").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  var out = [];
  for (var i = 0; i < lines.length; i += 2) {
    out.push({ visualText: lines[i] || "", audioText: lines[i + 1] || "" });
  }
  return out;
}

function parseTwoColumnText(text) {
  text = markdownExportScript(text);
  var detected = detectTwoColumnFormat(text);
  var rows;
  if (detected === "stacked") return parseStackedMarkdownExport(text);
  if (detected === "table") rows = parseMarkdownTable(text);
  else if (detected === "tab") rows = parseTabDelimited(text);
  else if (detected === "labels") rows = parseLabeledLines(text);
  else rows = parseAlternatingLines(text);
  return rows.filter(function (r) { return r.visualText || r.audioText; });
}

export function parseImportRows(text, mode) {
  if (mode === "twocolumn") return parseTwoColumnText(text);
  return splitImportText(text, mode).map(function (c) { return { visualText: "", audioText: c }; });
}

const brollAnchorPorts = { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml };

var IMPORT_SCANS = [
  {
    id: "broll",
    label: "Look for B-roll lines and track them",
    hint: "A line starting “B-roll:” becomes a shot on the b-roll list, and keeps its status when the line is reworded.",
    apply: function (rows, doc) { return anchorBrollInRows(doc, rows, brollAnchorPorts); },
    decline: function (rows) { declineBrollAnchoring(rows); },
    found: function (n) {
      return n + " B-roll line" + (n === 1 ? "" : "s") + " found and tracked.";
    }
  }
];

var IMPORT_SCAN_KEY = "splitpage-import-scans";

function importScanPrefs() {
  var saved;
  try { saved = JSON.parse(localStorage.getItem(IMPORT_SCAN_KEY) || "{}"); } catch (e) { saved = null; }
  return saved && typeof saved === "object" ? saved : {};
}

function importScanEnabled(id) {
  return importScanPrefs()[id] !== false;
}

function importScanBox(id) {
  return document.querySelector('[data-import-scan="' + cssAttr(id) + '"]');
}

function renderImportScanOptions() {
  var host = document.getElementById("import-scan-options");
  if (!host) return;
  host.innerHTML = IMPORT_SCANS.map(function (scan) {
    return '<label class="import-scan-toggle">' +
      '<input type="checkbox" data-import-scan="' + escapeHtml(scan.id) + '"' +
        (importScanEnabled(scan.id) ? ' checked' : '') + '>' +
      '<span>' + escapeHtml(scan.label) + '</span>' +
      '<span class="import-scan-hint">' + escapeHtml(scan.hint) + '</span>' +
    '</label>';
  }).join("");
}

function saveImportScanPrefs() {
  var saved = {};
  IMPORT_SCANS.forEach(function (scan) {
    var box = importScanBox(scan.id);
    saved[scan.id] = box ? !!box.checked : importScanEnabled(scan.id);
  });
  try { localStorage.setItem(IMPORT_SCAN_KEY, JSON.stringify(saved)); } catch (e) {}
}

function chosenImportScan() {
  var chosen = IMPORT_SCANS.filter(function (scan) {
    var box = importScanBox(scan.id);
    return box ? box.checked : importScanEnabled(scan.id);
  });
  saveImportScanPrefs();
  return function (doc, rows) {
    var notes = [];
    IMPORT_SCANS.forEach(function (scan) {
      if (chosen.indexOf(scan) === -1) {
        if (scan.decline) scan.decline(rows);
        return;
      }
      var n = scan.apply(rows, doc);
      if (n) notes.push(scan.found(n));
    });
    return notes.join(" ");
  };
}

function getImportMode() {
  var checked = document.querySelector('input[name="import-split"]:checked');
  return checked ? checked.value : "paragraph";
}

export function maybeAutoDetectTwoColumn(text) {
  if (importModeTouched()) return;
  if (detectTwoColumnFormat(text)) {
    var radio = document.querySelector('input[name="import-split"][value="twocolumn"]');
    if (radio) radio.checked = true;
  }
}

export function updateImportPreview() {
  var el0 = document.getElementById("import-preview");
  if (pendingFileRows) {
    var n0 = pendingFileRows.length;
    el0.textContent = pendingFileName + " — this will create " + n0 + " row" + (n0 === 1 ? "" : "s") +
      ", columns and formatting kept. Type below to use pasted text instead.";
    return;
  }
  var text = document.getElementById("import-textarea").value;
  var mode = getImportMode();
  var rows = parseImportRows(text, mode);
  var el = document.getElementById("import-preview");
  if (!rows.length) {
    el.textContent = "Paste some text to see a preview.";
    return;
  }
  var n = rows.length;
  var label = n + " row" + (n === 1 ? "" : "s");
  if (mode === "twocolumn") {
    var v = truncateForPreview(rows[0].visualText, 34) || "(empty)";
    var a = truncateForPreview(rows[0].audioText, 34) || "(empty)";
    el.textContent = "This will create " + label + " — first row: Visual “" + v + "” / Audio “" + a + "”";
  } else {
    el.textContent = "This will create " + label + " — first: “" + truncateForPreview(rows[0].audioText, 70) + "”";
  }
}

var pendingFileRows = null;
var pendingFileName = "";

export function clearPendingFileRows() {
  if (!pendingFileRows) return;
  pendingFileRows = null;
  pendingFileName = "";
  updateImportPreview();
}

var importIntoNewDocument = null;
var importModalEpoch = 0;

export function captureImportPreview() {
  var epoch = importModalEpoch;
  return function () { return epoch === importModalEpoch; };
}

var importDecodes = 0;
var importOperation = null;

export function openImportModal(opts) {
  importModalEpoch++;
  importIntoNewDocument = (opts && typeof opts.intoNewDocument === "function") ? opts.intoNewDocument : null;
  importOperation = importIntoNewDocument ? null : captureOperation();
  document.getElementById("import-modal").classList.toggle("is-new-document", !!importIntoNewDocument);
  document.getElementById("import-textarea").value = "";
  document.getElementById("import-replace").checked = false;
  resetImportMode();
  pendingFileRows = null;
  pendingFileName = "";
  var paragraphRadio = document.querySelector('input[name="import-split"][value="paragraph"]');
  if (paragraphRadio) paragraphRadio.checked = true;
  renderImportScanOptions();
  updateImportPreview();
  document.getElementById("import-modal").hidden = false;
  document.getElementById("import-textarea").focus();
}

export function closeImportModal() {
  importModalEpoch++;
  document.getElementById("import-modal").hidden = true;
  importIntoNewDocument = null;
  importOperation = null;
}

function importAsked() {
  return { modal: importModalEpoch, decode: ++importDecodes, operation: importOperation };
}

function stillAsked(asked) {
  return asked.modal === importModalEpoch && asked.decode === importDecodes &&
    (!asked.operation || stillOwns(asked.operation));
}

export async function handleImportFile(file) {
  if (!file) return;
  var asked = importAsked();
  var kind = fileKindFromName(file.name);
  if (kind === "splitpage" || kind === "html") {
    showToast("That is a Splitpage project — open it with File ▸ Open…", "warn");
    return;
  }
  if (kind === "docx" || kind === "csv") {
    var rows;
    try {
      if (kind === "csv") {
        rows = csvToRows(await file.text());
      } else {
        var parsed = await docxToRows(file);
        rows = parsed.rows;
        if ((!rows || !rows.length) && parsed.looseText) {
          rows = normalizeImportedRows(parseImportRows(parsed.looseText,
            detectTwoColumnFormat(parsed.looseText) ? "twocolumn" : "paragraph"), sanitizeHtml);
        }
      }
    } catch (err) {
      if (stillAsked(asked)) showToast(importFileErrorMessage(err), "error");
      return;
    }
    if (!stillAsked(asked)) return;
    if (!rows || !rows.length) { showToast("No scenes found in that file.", "warn"); return; }
    pendingFileRows = rows;
    pendingFileName = file.name;
    document.getElementById("import-textarea").value = "";
    updateImportPreview();
    return;
  }
  var text;
  try {
    text = await file.text();
  } catch (err) {
    if (stillAsked(asked)) showToast("Could not read that file.", "error");
    return;
  }
  if (!stillAsked(asked)) return;
  pendingFileRows = null;
  pendingFileName = "";
  document.getElementById("import-textarea").value = text;
  maybeAutoDetectTwoColumn(text);
  updateImportPreview();
}

function importFileErrorMessage(err) {
  if (err && err.message === "no-decompression-stream") return "This browser can't unzip .docx files — try Chrome or Edge.";
  if (err && (err.message === "not-a-zip" || err.message === "no-document-xml")) return "That doesn't look like a Word document.";
  return "Could not read that file.";
}

export function confirmImport() {
  var newRows;
  if (pendingFileRows) {
    newRows = pendingFileRows;
  } else {
    var text = document.getElementById("import-textarea").value;
    var rows = parseImportRows(text, getImportMode());
    if (!rows.length) {
      showToast("Paste or choose some text first.", "warn");
      return;
    }
    newRows = normalizeImportedRows(rows, sanitizeHtml);
  }
  var scan = chosenImportScan();
  if (importIntoNewDocument) {
    var found = "";
    newRows.forEach(stampRow);
    importIntoNewDocument(newRows, function (doc) { found = scan(doc, doc.rows); });
    markDirty();
    finishImport(newRows.length, found);
    return;
  }
  if (!importOperation || !stillOwns(importOperation)) {
    closeImportModal();
    showToast(IMPORT_MOVED, "warn");
    return;
  }
  var replace = document.getElementById("import-replace").checked;
  if (replace && editAllowed() && readSession(hasRows)) pushSnapshot("Before replacing rows on import");
  var imported = importRowsCommand({ rows: newRows, replace: replace, scan: scan }, sessionStamps);
  var outcome = runCommand(imported.command);
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind !== "applied" && outcome.kind !== "committed") {
    if (outcome.kind === "rejected" && outcome.reason === REVIEW_ONLY) showToast(IMPORT_REVIEW_REFUSAL, "warn");
    closeImportModal();
    return;
  }
  var report = imported.report();
  finishImport(report.count, report.found);
}

var IMPORT_MOVED = "The script changed while the import was open, so nothing was imported. Open the import again to bring the text in.";
var IMPORT_REVIEW_REFUSAL = "Viewing only — you can comment, but not change the script.";

function hasRows(doc) {
  return !!doc && doc.rows.length > 0;
}

function finishImport(count, found) {
  closeImportModal();
  showToast("Imported " + count + " row" + (count === 1 ? "" : "s") + "." +
    (found ? " " + found : ""), "ok");
}

function extractGoogleDocId(input) {
  var s = (input || "").trim();
  var m = /\/document\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{15,}$/.test(s)) return s;
  return null;
}

export function openGdocModal() {
  document.getElementById("gdoc-url-input").value = "";
  document.getElementById("gdoc-modal").hidden = false;
  document.getElementById("gdoc-url-input").focus();
}

export function closeGdocModal() {
  document.getElementById("gdoc-modal").hidden = true;
}

export function confirmGdocImport() {
  var id = extractGoogleDocId(document.getElementById("gdoc-url-input").value);
  if (!id) { showToast("That doesn't look like a Google Doc link.", "warn"); return; }
  var url = "https://docs.google.com/document/d/" + id + "/export?format=docx";
  if (runningOnDesktop()) {
    desktopPort().openExternal(url);
    closeGdocModal();
    showToast("Opening the Doc as a .docx download in your browser — once it's in your Downloads " +
      "folder, use File ▸ Open… to bring it in.", "ok", true);
    return;
  }
  var win = window.open(url, "_blank");
  if (!win) { showToast("Your browser blocked the download — allow popups for this page and try again.", "warn"); return; }
  win.opener = null;
  closeGdocModal();
  showToast("Downloading the Doc as .docx in a new tab — once it's in your Downloads folder, use File ▸ Open… to bring it in.", "ok", true);
}

export function __init() {}
