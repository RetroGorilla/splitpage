import type { ImportIntoNewDocument } from "../../application/formats/import-formats.ts";
import type { LocalFileOpening } from "../../application/transitions/local-files-ports.ts";
import type { ImportDialogControls, ImportDialogOptions, ImportDialogPorts, ImportDialogSource } from "./ports.ts";
import type { DocumentRow, ValidatedDocument } from "../../core/document/validated.ts";
import { importRowsCommand } from "../../application/commands/import-rows.ts";
import { escapeHtml, truncateForPreview } from "../../core/document/text-policy.ts";
import { cssAttr } from "../common/dom.ts";
import { fileKindFromName } from "../../../shared/file-names.ts";

let ports: ImportDialogPorts | null = null;
let window: Window | null = null, document: Document | null = null;
function parseImportRows(text: string, mode: string) { return (ports as ImportDialogPorts).formats.parse(text, mode); }
function detectTwoColumnFormat(text: string) { return (ports as ImportDialogPorts).formats.detect(text); }
function normalizeImportedRows(rows: Parameters<ImportDialogPorts["formats"]["normalize"]>[0], sanitize: Parameters<ImportDialogPorts["formats"]["normalize"]>[1]) { return (ports as ImportDialogPorts).formats.normalize(rows, sanitize); }
function csvToRows(text: string) { return (ports as ImportDialogPorts).formats.csv(text); }
function docxToRows(file: Parameters<ImportDialogPorts["formats"]["docx"]>[0]) { return (ports as ImportDialogPorts).formats.docx(file); }
function sanitizeHtml(html: string) { return (ports as ImportDialogPorts).text.sanitizeHtml(html); }
function captureOperation() { return (ports as ImportDialogPorts).ownership.capture(); }
function stillOwns(operation: Parameters<ImportDialogPorts["ownership"]["stillOwns"]>[0]) { return (ports as ImportDialogPorts).ownership.stillOwns(operation); }
function keepSnapshot(label: string) { return (ports as ImportDialogPorts).history.keep(label); }
function stampRow(row: DocumentRow) { return (ports as ImportDialogPorts).stampRow(row); }
function noteSessionEdit() { return (ports as ImportDialogPorts).noteEdit(); }
function editAllowed() { return (ports as ImportDialogPorts).edits.allowed(); }
function readSession<T>(reader: (doc: Parameters<Parameters<ImportDialogPorts["document"]["read"]>[0]>[0]) => T) { return (ports as ImportDialogPorts).document.read(reader); }
function runCommand(command: Parameters<ImportDialogPorts["edits"]["run"]>[0]) { return (ports as ImportDialogPorts).edits.run(command); }
function showToast(message: string, kind?: Parameters<ImportDialogPorts["notices"]["show"]>[1], sticky?: boolean) { return (ports as ImportDialogPorts).notices.show(message, kind, sticky); }
function runningOnDesktop() { return (ports as ImportDialogPorts).desktop.running(); }
function desktopPort() { return (ports as ImportDialogPorts).desktop; }

const IMPORT_SCANS = [
  {
    id: "broll",
    label: "Look for B-roll lines and track them",
    hint: "A line starting “B-roll:” becomes a shot on the b-roll list, and keeps its status when the line is reworded.",
    apply: function (rows: readonly DocumentRow[], doc: ValidatedDocument) { return (ports as ImportDialogPorts).formats.anchorBroll(doc, rows); },
    decline: function (rows: readonly DocumentRow[]) { (ports as ImportDialogPorts).formats.declineBroll(rows); },
    found: function (n: number) {
      return n + " B-roll line" + (n === 1 ? "" : "s") + " found and tracked.";
    }
  }
];

const IMPORT_SCAN_KEY = "splitpage-import-scans";

function importScanPrefs() {
  let saved;
  try { saved = JSON.parse((window as Window).localStorage.getItem(IMPORT_SCAN_KEY) || "{}"); } catch (e) { saved = null; }
  return saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
}

function importScanEnabled(id: string) {
  return importScanPrefs()[id] !== false;
}

function importScanBox(id: string) {
  return (document as Document).querySelector<HTMLInputElement>('[data-import-scan="' + cssAttr(id) + '"]');
}

function renderImportScanOptions() {
  const host = (document as Document).getElementById("import-scan-options");
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
  const saved: Record<string, boolean> = {};
  IMPORT_SCANS.forEach(function (scan) {
    const box = importScanBox(scan.id);
    saved[scan.id] = box ? !!box.checked : importScanEnabled(scan.id);
  });
  try { (window as Window).localStorage.setItem(IMPORT_SCAN_KEY, JSON.stringify(saved)); } catch (e) {}
}

function chosenImportScan() {
  const chosen = IMPORT_SCANS.filter(function (scan) {
    const box = importScanBox(scan.id);
    return box ? box.checked : importScanEnabled(scan.id);
  });
  saveImportScanPrefs();
  return function (doc: ValidatedDocument, rows: readonly DocumentRow[]) {
    const notes: string[] = [];
    IMPORT_SCANS.forEach(function (scan) {
      if (chosen.indexOf(scan) === -1) {
        if (scan.decline) scan.decline(rows);
        return;
      }
      const n = scan.apply(rows, doc);
      if (n) notes.push(scan.found(n));
    });
    return notes.join(" ");
  };
}

function getImportMode() {
  const checked = (document as Document).querySelector<HTMLInputElement>('input[name="import-split"]:checked');
  return checked ? checked.value : "paragraph";
}

function maybeAutoDetectTwoColumn(text: string) {
  if ((ports as ImportDialogPorts).mode.touched()) return;
  if (detectTwoColumnFormat(text)) {
    const radio = (document as Document).querySelector<HTMLInputElement>('input[name="import-split"][value="twocolumn"]');
    if (radio) radio.checked = true;
  }
}

function updateImportPreview() {
  const el0 = (document as Document).getElementById("import-preview");
  if (pendingFileRows) {
    const n0 = pendingFileRows.length;
    (el0 as HTMLElement).textContent = pendingFileName + " — this will create " + n0 + " row" + (n0 === 1 ? "" : "s") +
      ", columns and formatting kept. Type below to use pasted text instead.";
    return;
  }
  const text = ((document as Document).getElementById("import-textarea") as HTMLTextAreaElement).value;
  const mode = getImportMode();
  const rows = parseImportRows(text, mode);
  const el = (document as Document).getElementById("import-preview");
  if (!(rows as NonNullable<typeof rows>).length) {
    (el as HTMLElement).textContent = "Paste some text to see a preview.";
    return;
  }
  const n = (rows as NonNullable<typeof rows>).length;
  const label = n + " row" + (n === 1 ? "" : "s");
  if (mode === "twocolumn") {
    const v = truncateForPreview(((rows as NonNullable<typeof rows>)[0] as NonNullable<typeof rows>[number]).visualText, 34) || "(empty)";
    const a = truncateForPreview(((rows as NonNullable<typeof rows>)[0] as NonNullable<typeof rows>[number]).audioText, 34) || "(empty)";
    (el as HTMLElement).textContent = "This will create " + label + " — first row: Visual “" + v + "” / Audio “" + a + "”";
  } else {
    (el as HTMLElement).textContent = "This will create " + label + " — first: “" + truncateForPreview(((rows as NonNullable<typeof rows>)[0] as NonNullable<typeof rows>[number]).audioText, 70) + "”";
  }
}

let pendingFileRows: DocumentRow[] | null = null;
let pendingFileName = "";

function clearPendingFileRows() {
  if (!pendingFileRows) return;
  pendingFileRows = null;
  pendingFileName = "";
  updateImportPreview();
}

let importIntoNewDocument: ImportIntoNewDocument | null = null;
let importModalEpoch = 0;

function captureImportPreview() {
  const epoch = importModalEpoch;
  return function () { return epoch === importModalEpoch; };
}

let importDecodes = 0;
let importOperation: ReturnType<ImportDialogPorts["ownership"]["capture"]> | null = null;

function openImportModal(opts?: ImportDialogOptions) {
  importModalEpoch++;
  importIntoNewDocument = (opts && typeof opts.intoNewDocument === "function") ? opts.intoNewDocument : null;
  importOperation = importIntoNewDocument ? null : captureOperation();
  ((document as Document).getElementById("import-modal") as HTMLElement).classList.toggle("is-new-document", !!importIntoNewDocument);
  ((document as Document).getElementById("import-textarea") as HTMLTextAreaElement).value = "";
  ((document as Document).getElementById("import-replace") as HTMLInputElement).checked = false;
  (ports as ImportDialogPorts).mode.reset();
  pendingFileRows = null;
  pendingFileName = "";
  const paragraphRadio = (document as Document).querySelector<HTMLInputElement>('input[name="import-split"][value="paragraph"]');
  if (paragraphRadio) paragraphRadio.checked = true;
  renderImportScanOptions();
  updateImportPreview();
  ((document as Document).getElementById("import-modal") as HTMLElement).hidden = false;
  ((document as Document).getElementById("import-textarea") as HTMLTextAreaElement).focus();
}

function closeImportModal() {
  importModalEpoch++;
  ((document as Document).getElementById("import-modal") as HTMLElement).hidden = true;
  importIntoNewDocument = null;
  importOperation = null;
}

function importAsked() {
  return { modal: importModalEpoch, decode: ++importDecodes, operation: importOperation };
}

function stillAsked(asked: ReturnType<typeof importAsked>) {
  return asked.modal === importModalEpoch && asked.decode === importDecodes &&
    (!asked.operation || stillOwns(asked.operation));
}

function importDocumentSource(): ImportDialogSource {
  return {
    id: "import",
    takes: function (opening) { return opening.kind === "import"; },
    open: function (opening) { return handleImportFile(opening.file); }
  };
}

async function handleImportFile(file: LocalFileOpening["file"]) {
  if (!file) return;
  const asked = importAsked();
  const kind = fileKindFromName(file.name);
  if (kind === "splitpage" || kind === "html") {
    showToast("That is a Splitpage project — open it with File ▸ Open…", "warn");
    return;
  }
  if (kind === "docx" || kind === "csv") {
    let rows;
    try {
      if (kind === "csv") {
        rows = csvToRows(await file.text());
      } else {
        const parsed = await docxToRows(file);
        rows = parsed.rows;
        if ((!rows || !(rows as NonNullable<typeof rows>).length) && parsed.looseText) {
          rows = normalizeImportedRows(parseImportRows(parsed.looseText,
            detectTwoColumnFormat(parsed.looseText) ? "twocolumn" : "paragraph"), sanitizeHtml);
        }
      }
    } catch (err) {
      if (stillAsked(asked)) showToast(importFileErrorMessage(err), "error");
      return;
    }
    if (!stillAsked(asked)) return;
    if (!rows || !(rows as NonNullable<typeof rows>).length) { showToast("No scenes found in that file.", "warn"); return; }
    pendingFileRows = rows;
    pendingFileName = file.name;
    ((document as Document).getElementById("import-textarea") as HTMLTextAreaElement).value = "";
    updateImportPreview();
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch (err) {
    if (stillAsked(asked)) showToast("Could not read that file.", "error");
    return;
  }
  if (!stillAsked(asked)) return;
  pendingFileRows = null;
  pendingFileName = "";
  ((document as Document).getElementById("import-textarea") as HTMLTextAreaElement).value = text;
  maybeAutoDetectTwoColumn(text);
  updateImportPreview();
}

function importFileErrorMessage(err: unknown) {
  if (err && (err as Error).message === "no-decompression-stream") return "This browser can't unzip .docx files — try Chrome or Edge.";
  if (err && ((err as Error).message === "not-a-zip" || (err as Error).message === "no-document-xml")) return "That doesn't look like a Word document.";
  return "Could not read that file.";
}

function confirmImport() {
  let newRows;
  if (pendingFileRows) {
    newRows = pendingFileRows;
  } else {
    const text = ((document as Document).getElementById("import-textarea") as HTMLTextAreaElement).value;
    const rows = parseImportRows(text, getImportMode());
    if (!(rows as NonNullable<typeof rows>).length) {
      showToast("Paste or choose some text first.", "warn");
      return;
    }
    newRows = normalizeImportedRows(rows, sanitizeHtml);
  }
  const scan = chosenImportScan();
  if (importIntoNewDocument) {
    let found = "";
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
  const replace = ((document as Document).getElementById("import-replace") as HTMLInputElement).checked;
  if (replace && editAllowed() && readSession(hasRows)) keepSnapshot("Before replacing rows on import");
  const imported = importRowsCommand({ rows: newRows, replace: replace, scan: scan }, (ports as ImportDialogPorts).edits.stamps);
  const outcome = runCommand(imported.command);
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind !== "applied" && outcome.kind !== "committed") {
    closeImportModal();
    return;
  }
  const report = imported.report();
  finishImport(report.count, report.found);
}

const IMPORT_MOVED = "The script changed while the import was open, so nothing was imported. Open the import again to bring the text in.";

function hasRows(doc: Parameters<Parameters<ImportDialogPorts["document"]["read"]>[0]>[0]) {
  return !!doc && doc.rows.length > 0;
}

function finishImport(count: number, found: string) {
  closeImportModal();
  showToast("Imported " + count + " row" + (count === 1 ? "" : "s") + "." +
    (found ? " " + found : ""), "ok");
}

function extractGoogleDocId(input: string) {
  const s = (input || "").trim();
  const m = /\/document\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  if (m) return m[1] as string;
  if (/^[a-zA-Z0-9_-]{15,}$/.test(s)) return s;
  return null;
}

function openGdocModal() {
  ((document as Document).getElementById("gdoc-url-input") as HTMLInputElement).value = "";
  ((document as Document).getElementById("gdoc-modal") as HTMLElement).hidden = false;
  ((document as Document).getElementById("gdoc-url-input") as HTMLInputElement).focus();
}

function closeGdocModal() {
  ((document as Document).getElementById("gdoc-modal") as HTMLElement).hidden = true;
}

function confirmGdocImport() {
  const id = extractGoogleDocId(((document as Document).getElementById("gdoc-url-input") as HTMLInputElement).value);
  if (!id) { showToast("That doesn't look like a Google Doc link.", "warn"); return; }
  const url = "https://docs.google.com/document/d/" + id + "/export?format=docx";
  if (runningOnDesktop()) {
    desktopPort().openExternal(url);
    closeGdocModal();
    showToast("Opening the Doc as a .docx download in your browser — once it's in your Downloads " +
      "folder, use File ▸ Open… to bring it in.", "ok", true);
    return;
  }
  const win = (window as Window).open(url, "_blank");
  if (!win) { showToast("Your browser blocked the download — allow popups for this page and try again.", "warn"); return; }
  win.opener = null;
  closeGdocModal();
  showToast("Downloading the Doc as .docx in a new tab — once it's in your Downloads folder, use File ▸ Open… to bring it in.", "ok", true);
}


export function mountImportDialog(next: ImportDialogPorts, realm = globalThis.window): ImportDialogControls {
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
