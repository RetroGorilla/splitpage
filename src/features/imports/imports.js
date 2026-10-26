import { importModeTouched, resetImportMode } from "../../application/import-mode.ts";
import { importRowsCommand } from "../../application/commands/import-rows.ts";
import { escapeHtml, truncateForPreview } from "../../core/document/text-policy.ts";
import { cssAttr } from "../common/dom.ts";
import { fileKindFromName } from "../../../shared/file-names.js";

var ports = null;
var window = null, document = null;
function parseImportRows(text, mode) { return ports.formats.parse(text, mode); }
function detectTwoColumnFormat(text) { return ports.formats.detect(text); }
function normalizeImportedRows(rows, sanitize) { return ports.formats.normalize(rows, sanitize); }
function csvToRows(text) { return ports.formats.csv(text); }
function docxToRows(file) { return ports.formats.docx(file); }
function sanitizeHtml(html) { return ports.text.sanitizeHtml(html); }
function captureOperation() { return ports.ownership.capture(); }
function stillOwns(operation) { return ports.ownership.stillOwns(operation); }
function keepSnapshot(label) { return ports.history.keep(label); }
function stampRow(row) { return ports.stampRow(row); }
function noteSessionEdit() { return ports.noteEdit(); }
function editAllowed() { return ports.edits.allowed(); }
function readSession(reader) { return ports.document.read(reader); }
function runCommand(command) { return ports.edits.run(command); }
function showToast(message, kind, sticky) { return ports.notices.show(message, kind, sticky); }
function runningOnDesktop() { return ports.desktop.running(); }
function desktopPort() { return ports.desktop; }

var IMPORT_SCANS = [
  {
    id: "broll",
    label: "Look for B-roll lines and track them",
    hint: "A line starting “B-roll:” becomes a shot on the b-roll list, and keeps its status when the line is reworded.",
    apply: function (rows, doc) { return ports.formats.anchorBroll(doc, rows); },
    decline: function (rows) { ports.formats.declineBroll(rows); },
    found: function (n) {
      return n + " B-roll line" + (n === 1 ? "" : "s") + " found and tracked.";
    }
  }
];

var IMPORT_SCAN_KEY = "splitpage-import-scans";

function importScanPrefs() {
  var saved;
  try { saved = JSON.parse(window.localStorage.getItem(IMPORT_SCAN_KEY) || "{}"); } catch (e) { saved = null; }
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
  try { window.localStorage.setItem(IMPORT_SCAN_KEY, JSON.stringify(saved)); } catch (e) {}
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

function maybeAutoDetectTwoColumn(text) {
  if (importModeTouched()) return;
  if (detectTwoColumnFormat(text)) {
    var radio = document.querySelector('input[name="import-split"][value="twocolumn"]');
    if (radio) radio.checked = true;
  }
}

function updateImportPreview() {
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

function clearPendingFileRows() {
  if (!pendingFileRows) return;
  pendingFileRows = null;
  pendingFileName = "";
  updateImportPreview();
}

var importIntoNewDocument = null;
var importModalEpoch = 0;

function captureImportPreview() {
  var epoch = importModalEpoch;
  return function () { return epoch === importModalEpoch; };
}

var importDecodes = 0;
var importOperation = null;

function openImportModal(opts) {
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

function closeImportModal() {
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

function importDocumentSource() {
  return {
    id: "import",
    takes: function (opening) { return opening.kind === "import"; },
    open: function (opening) { return handleImportFile(opening.file); }
  };
}

async function handleImportFile(file) {
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

function confirmImport() {
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
    noteSessionEdit();
    finishImport(newRows.length, found);
    return;
  }
  if (!importOperation || !stillOwns(importOperation)) {
    closeImportModal();
    showToast(IMPORT_MOVED, "warn");
    return;
  }
  var replace = document.getElementById("import-replace").checked;
  if (replace && editAllowed() && readSession(hasRows)) keepSnapshot("Before replacing rows on import");
  var imported = importRowsCommand({ rows: newRows, replace: replace, scan: scan }, ports.edits.stamps);
  var outcome = runCommand(imported.command);
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind !== "applied" && outcome.kind !== "committed") {
    if (outcome.kind === "rejected" && outcome.reason === ports.reviewOnly) showToast(IMPORT_REVIEW_REFUSAL, "warn");
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

function openGdocModal() {
  document.getElementById("gdoc-url-input").value = "";
  document.getElementById("gdoc-modal").hidden = false;
  document.getElementById("gdoc-url-input").focus();
}

function closeGdocModal() {
  document.getElementById("gdoc-modal").hidden = true;
}

function confirmGdocImport() {
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


export function mountImportDialog(next, realm = globalThis.window) {
  ports = next;
  window = realm;
  document = realm.document;
  return {
    maybeAutoDetectTwoColumn,
    updateImportPreview,
    clearPendingFileRows,
    captureImportPreview,
    openImportModal,
    closeImportModal,
    importDocumentSource,
    confirmImport,
    openGdocModal,
    closeGdocModal,
    confirmGdocImport,
    dispose: function () {
      if (ports !== next) return;
      importModalEpoch++;
      importDecodes++;
      importIntoNewDocument = null;
      importOperation = null;
      pendingFileRows = null;
      pendingFileName = "";
      ports = null;
    }
  };
}
