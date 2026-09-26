import { S } from "./_state.js";
import { escapeHtml, legacyMdToHtml, makeId } from "./02-state.js";
import { internDataUrl, queuePersist } from "./02c-blobs.js";
import { pushSnapshot, stampRow } from "./03-sync.js";
import { cssAttr, safeImageSrc, sanitizeHtml } from "./04-richtext.js";
import { render } from "./05-render.js";
import { anchorBrollInRows, declineBrollAnchoring } from "./08c-broll.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { audioDirectionsHtml, docxToRows } from "./15-docx.js";
import { csvToRows } from "./16-csv.js";
import { fileKindFromName } from "./18-local-files.js";
import { MD_IMAGE_PREFIX_RE } from "./20d-formats.js";

/* ================= import ================= */

S.importModeTouched = false;

export function truncateForPreview(s, n) {
  s = s || "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

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

/* --- two-column detection & parsing --- */

var VISUAL_LABEL_RE = /^\s*(visual|video|scene|shot|b-?roll|image|screen)\s*:\s*(.*)$/i;
var AUDIO_LABEL_RE = /^\s*(audio|vo|voiceover|voice-over|narration|dialogue|script)\s*:\s*(.*)$/i;
/* Anchored to the WHOLE cell (only a trailing plural allowed), unlike the
   LABEL_REs above which only need to match a line's prefix before ":".
   These are for judging whether rows[0] of a table/tab paste is really a
   header — a bare .test() for "shot" or "scene" anywhere in the string
   also matches ordinary shot-list content like "Wide shot of the ocean",
   misclassifying the first real data row as a header and discarding it. */
var VISUAL_HEADER_RE = /^(visual|video|scene|shot|b-?roll|image|screen)s?$/i;
var AUDIO_HEADER_RE = /^(audio|vo|voiceover|voice-over|narration|dialogue|script)s?$/i;

export function detectTwoColumnFormat(text) {
  if (parseStackedMarkdownExport(text)) return "stacked";
  var norm = markdownExportScript(String(text || "")).replace(/\r\n/g, "\n");
  var lines = norm.split("\n");
  var nonBlank = lines.filter(function (l) { return l.trim() !== ""; });
  if (nonBlank.length < 2) return null;

  /* Requires a majority of lines to carry a pipe, not just two — two
     incidental pipe characters in an otherwise plain paste (a leading
     "|" bullet, a quoted log snippet) used to be enough to classify the
     WHOLE document as a table, and parseMarkdownTable then discards every
     line that isn't itself pipe-delimited. Matching on "contains a pipe"
     rather than "starts with a pipe" too, since that's what
     parseMarkdownTable itself actually reads (line.indexOf("|") === -1). */
  var pipeLines = nonBlank.filter(function (l) { return l.indexOf("|") !== -1; });
  if (pipeLines.length >= 2 && pipeLines.length / nonBlank.length > 0.6) return "table";

  var tabLines = nonBlank.filter(function (l) { return l.indexOf("\t") !== -1; });
  if (tabLines.length / nonBlank.length > 0.6) return "tab";

  var hasVisualLabel = nonBlank.some(function (l) { return VISUAL_LABEL_RE.test(l); });
  var hasAudioLabel = nonBlank.some(function (l) { return AUDIO_LABEL_RE.test(l); });
  /* parseLabeledLines silently drops every line before the first label
     match (current stays null until then), so detecting "labels" from
     one coincidental visual-word line and one unrelated audio-word line
     anywhere in an otherwise plain document used to make Import quietly
     eat everything before whichever came first. Requiring the very first
     line to already look like a label means there is nothing ahead of it
     for the parser to throw away. */
  var firstIsLabel = VISUAL_LABEL_RE.test(nonBlank[0]) || AUDIO_LABEL_RE.test(nonBlank[0]);
  if (hasVisualLabel && hasAudioLabel && firstIsLabel) return "labels";

  return null;
}

function columnIndicesFromHeader(header) {
  var visualIdx = header.findIndex(function (c) { return VISUAL_HEADER_RE.test(c.trim()); });
  var audioIdx = header.findIndex(function (c) { return AUDIO_HEADER_RE.test(c.trim()); });
  /* A row can only tell us where ONE of the two columns is (say, a
     header that only names "Audio"); the other index used to fall back
     to its bare default (0), which can collide with the one that WAS
     found and silently point both fields at the same column. Nudge the
     unresolved side to whichever of the first two columns the found one
     isn't sitting on. */
  if (visualIdx !== -1 && audioIdx === -1) audioIdx = visualIdx === 0 ? 1 : 0;
  else if (audioIdx !== -1 && visualIdx === -1) visualIdx = audioIdx === 0 ? 1 : 0;
  return { visualIdx: visualIdx, audioIdx: audioIdx };
}

/* A plain split("|") has no idea that markdown lets a cell contain a
   literal pipe as "\|" — it would cut that cell in two and shift every
   following column's content into the next index, silently truncating
   whatever landed past visualIdx/audioIdx. Splits only on an
   unescaped "|", then un-escapes "\|" back to "|" in each cell. */
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

/* A "Two columns" export (toMarkdownTableDoc, 14-export.js) ends at its
   script: the breakdown and comments that follow sit under headings of
   their own, are pipe tables and prose, and are not scenes (the comments'
   lines even outvote the table's and stop the text reading as a table at
   all). Cut there, but only after our own scene header, the way the .docx
   reimport waits for its table style (exportTailStart, 15-docx.js), so a
   table someone wrote with a "## Comments" heading of their own keeps what
   follows it. */
var MD_EXPORT_TAIL_RE = /^\s*##\s+(Production breakdown|Comments)\s*$/;

function markdownExportScript(text) {
  var lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  var sawHeader = false;
  for (var i = 0; i < lines.length; i++) {
    if (!sawHeader) {
      sawHeader = lines[i].indexOf("|") !== -1 &&
        splitTableRowCells(lines[i].trim()).join("|").toLowerCase() === "#|visual|audio|status";
    } else if (MD_EXPORT_TAIL_RE.test(lines[i])) {
      return lines.slice(0, i).join("\n");
    }
  }
  return text;
}

/* The plain "Markdown" export (toMarkdownDoc, 14-export.js) reopened. It
   is a script laid out to be read: a "# title", a "_30 scenes · est. …_"
   line, then per scene a "### Scene 01" heading, its pictures and video
   links, "*Visual —* " and the Visual cell up to a blank line, the Audio
   cell, and "---"; the breakdown and comments come after. Read as plain
   paragraphs, every paragraph was a scene, the headings and the Visual
   lines among them. Recognised only by that exact opening (the title, at
   most the one meta line, then a scene heading), so anybody else's
   Markdown reads as it always did. Null when it is not one; otherwise
   the scenes, a blank one kept. The pictures are files beside the export,
   not in it, and do not come back. */
var MD_SCENE_HEADING_RE = /^###\s+Scene\s+\d+\s*$/;
var MD_SCENE_META_RE = /^_\d+ scenes? · est\. .* running time_$/;
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

  var scenes = [];
  for (; i < lines.length; i++) {
    if (MD_EXPORT_TAIL_RE.test(lines[i])) break;
    if (MD_SCENE_HEADING_RE.test(lines[i].trim())) scenes.push([]);
    else scenes[scenes.length - 1].push(lines[i]);
  }
  return scenes.map(function (sc) {
    var end = sc.length;
    while (end > 0 && !sc[end - 1].trim()) end--;
    if (end > 0 && sc[end - 1].trim() === "---") end--;
    sc = sc.slice(0, end);
    var k = 0;
    while (k < sc.length && (!sc[k].trim() || MD_SCENE_MEDIA_RE.test(sc[k].trim()))) k++;
    var visual = [];
    if (k < sc.length && MD_VISUAL_LEAD_RE.test(sc[k])) {
      visual.push(sc[k].replace(MD_VISUAL_LEAD_RE, ""));
      for (k++; k < sc.length && sc[k].trim(); k++) visual.push(sc[k]);
    }
    var audio = sc.slice(k).join("\n").trim();
    return { visualText: visual.join("\n").trim(), audioText: audio === "_(blank scene)_" ? "" : audio };
  });
}

/* opts.keepEmpty keeps a data row whose Visual and Audio cells are both
   empty. Off by default, because a foreign table's blank line carries no
   information; on when reading one of our OWN Markdown projects
   (20d-formats.js), where a scene with nothing typed in it yet is still a
   scene and dropping it would shift every row after it out of line with
   the file's own record. */
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
  /* the export's own scenes, a blank one included, as the file lists them */
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

/* turn raw {visualText, audioText} pairs into real rows */
export function normalizeImportedRows(rows) {
  /* Every other write path into state.rows runs its content through
     sanitizeHtml() before it lands in the document (see migrateRows(),
     06-rows.js, 07-production-tags.js, 09-find-replace.js, 10-comments.js,
     19-writer.js, 21-events.js). This one didn't — legacyMdToHtml() escapes
     plain text but is not a sanitizer, so a pasted line containing a raw
     '<' (a page whose markup was preserved as text, or a deliberately
     crafted paste) went straight into the document as live HTML. */
  /* into the image registry (02c-blobs.js, #82): the row names it */
  function importedImageRef(dataUrl) {
    var rec = dataUrl ? internDataUrl(dataUrl) : null;
    if (rec) queuePersist([rec.sha256]);
    return rec;
  }
  return rows.map(function (r) {
    /* An inline image at the head of the Visual cell is how this app's own
       Markdown writes a storyboard frame (toMarkdownTableDoc). This used
       to be hardcoded to null, so a two-column export re-imported lost
       every picture in it — and left the data: URI sitting in the text as
       several thousand characters of visible gibberish, because
       legacyMdToHtml's link rule rejects a data: href. Only a data: image
       this app would itself accept is taken; an ordinary ![](http…) in a
       foreign document still imports exactly as it did before. */
    var visual = String(r.visualText || "");
    var image = null;
    var m = MD_IMAGE_PREFIX_RE.exec(visual);
    if (m) {
      image = safeImageSrc(m[1]);
      if (image) visual = visual.slice(m[0].length);
    }
    return {
      id: makeId(),
      visualText: sanitizeHtml(legacyMdToHtml(visual)),
      imageRef: importedImageRef(image),
      /* an inline "((beat))" is a stage direction (#167) */
      audioText: audioDirectionsHtml(sanitizeHtml(legacyMdToHtml(r.audioText || "")))
    };
  });
}

/* ---- what Import can be asked to look for ----

   Detection is not the missing piece — brollInField already reads every
   "B-roll:" line out of a field, and the untagged-mentions machinery
   already finds plain-text mentions of registry items. What was missing is
   permission: applying what was found means rewriting the text somebody has
   just handed over, and doing that silently is the wrong default. So the
   dialog asks, once, and remembers the answer.

   One entry per kind, and the dialog builds its own checkbox from each of
   them (renderImportScanOptions), so a second kind — untagged mentions of
   things already in the breakdown, locations, gear — is an entry here plus a
   scan function, not a redesign of the question.

   `apply` is handed the rows that have just landed in state.rows — they have
   to be there already, because a scan reconciles what it finds against the
   whole document rather than against those rows in isolation — and returns
   how many it changed. `decline` gets the same rows when the answer is no,
   and is where a scan makes sure nothing else quietly does the work for it
   afterwards. */
var IMPORT_SCANS = [
  {
    id: "broll",
    label: "Look for B-roll lines and track them",
    hint: "A line starting “B-roll:” becomes a shot on the b-roll list, and keeps its status when the line is reworded.",
    apply: function (rows) { return anchorBrollInRows(rows); },
    decline: function (rows) { declineBrollAnchoring(rows); },
    found: function (n) {
      return n + " B-roll line" + (n === 1 ? "" : "s") + " found and tracked.";
    }
  }
];

var IMPORT_SCAN_KEY = "splitpage-import-scans";

/* Per device, like the comments sort order and the writer's text size: this
   is about how somebody imports, not about the document, so it has no
   business in state. Anything not written down yet reads as on — an
   unanswered question should leave the b-roll list working rather than
   second-class (#21) — and a no, once given, keeps. */
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

/* Runs the scans that are on over the rows that just arrived, and returns
   what to add to the import's own toast — the result reported where the
   import is reported, rather than as a second notification. */
function runImportScans(rows) {
  var notes = [];
  IMPORT_SCANS.forEach(function (scan) {
    var box = importScanBox(scan.id);
    if (box ? !box.checked : !importScanEnabled(scan.id)) {
      if (scan.decline) scan.decline(rows);
      return;
    }
    var n = scan.apply(rows);
    if (n) notes.push(scan.found(n));
  });
  saveImportScanPrefs();
  return notes.join(" ");
}

/* --- modal wiring --- */

function getImportMode() {
  var checked = document.querySelector('input[name="import-split"]:checked');
  return checked ? checked.value : "paragraph";
}

export function maybeAutoDetectTwoColumn(text) {
  if (S.importModeTouched) return;
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

/* ---- a picked file as the source, instead of the textarea ----

   This modal is the "draft 2 of the same script" path (issue #7): it
   replaces or appends rows and keeps everything the document knows about
   them — the breakdown's statuses, owners and notes, the cast list, the
   b-roll list and the comments — where File ▸ Open now starts a new
   document. That workflow used to be reachable only by pasting, which
   ruled out a .docx (a zip) and cost a .csv its columns; the picker below
   makes it reachable for all four foreign formats.

   A .docx and a .csv are tables, not text. Rendering one back into the
   textarea so the split modes could re-read it would throw away the
   column split and the formatting the importers already recovered, so
   those two bypass the textarea: the rows they produce are held here and
   the Import button uses them as-is. Typing in the textarea drops them —
   the textarea and a picked table are two sources for one button, never
   both at once. */
var pendingFileRows = null;
var pendingFileName = "";

export function clearPendingFileRows() {
  if (!pendingFileRows) return;
  pendingFileRows = null;
  pendingFileName = "";
  updateImportPreview();
}

/* Where a confirmed import goes when the modal was opened as the start of
   a new document rather than into the one on screen — the New Tab page's
   "paste one" (20j-newtab.js, issue #144). That page sits over a demo the
   user never chose, so appending to it (or replacing its rows while
   keeping its comments and breakdown) would be wrong either way: the
   caller's function installs a new document holding exactly these rows,
   and everything after that — the scans, the render, the toast — is the
   ordinary import. Cleared whenever the modal closes, so File ▸ Paste a
   script… is never affected by a New Tab import that was cancelled. */
var importIntoNewDocument = null;

export function openImportModal(opts) {
  importIntoNewDocument = (opts && typeof opts.intoNewDocument === "function") ? opts.intoNewDocument : null;
  document.getElementById("import-modal").classList.toggle("is-new-document", !!importIntoNewDocument);
  document.getElementById("import-textarea").value = "";
  document.getElementById("import-replace").checked = false;
  S.importModeTouched = false;
  pendingFileRows = null;
  pendingFileName = "";
  var paragraphRadio = document.querySelector('input[name="import-split"][value="paragraph"]');
  if (paragraphRadio) paragraphRadio.checked = true;
  /* Rebuilt every time it opens, so the boxes show the remembered answer
     rather than whatever the last import happened to leave ticked. */
  renderImportScanOptions();
  updateImportPreview();
  document.getElementById("import-modal").hidden = false;
  document.getElementById("import-textarea").focus();
}

export function closeImportModal() {
  document.getElementById("import-modal").hidden = true;
  importIntoNewDocument = null;
}

export async function handleImportFile(file) {
  if (!file) return;
  var kind = fileKindFromName(file.name); /* 18-local-files.js */
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
        /* a Word file with no table, exactly as File ▸ Open reads one */
        if ((!rows || !rows.length) && parsed.looseText) {
          rows = normalizeImportedRows(parseImportRows(parsed.looseText,
            detectTwoColumnFormat(parsed.looseText) ? "twocolumn" : "paragraph"));
        }
      }
    } catch (err) {
      showToast(importFileErrorMessage(err), "error");
      return;
    }
    if (!rows || !rows.length) { showToast("No script rows found in that file.", "warn"); return; }
    pendingFileRows = rows;
    pendingFileName = file.name;
    document.getElementById("import-textarea").value = "";
    updateImportPreview();
    return;
  }
  /* .md, .txt and anything else readable: the textarea path, unchanged. */
  var text;
  try {
    text = await file.text();
  } catch (err) {
    showToast("Could not read that file.", "error");
    return;
  }
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
    newRows = normalizeImportedRows(rows);
  }
  newRows.forEach(stampRow);
  if (importIntoNewDocument) {
    importIntoNewDocument(newRows);
  } else {
    var replace = document.getElementById("import-replace").checked;
    if (replace && S.state.rows.length) pushSnapshot("Before replacing rows on import");
    S.state.rows = replace ? newRows : S.state.rows.concat(newRows);
  }
  /* After the rows are in state.rows and before the render: a scan
     reconciles what it finds against the whole document (see IMPORT_SCANS),
     and whatever it rewrites is what this render is about to draw. */
  var found = runImportScans(newRows);
  markDirty();
  render();
  closeImportModal();
  showToast("Imported " + newRows.length + " row" + (newRows.length === 1 ? "" : "s") + "." +
    (found ? " " + found : ""), "ok");
}

/* ================= Google Doc import =================

   Splitpage has no server and no Google sign-in of its own, so it can't
   fetch a Doc's contents directly — a plain in-page fetch() to
   docs.google.com is blocked by CORS regardless of sharing settings. The
   one thing that does work with no account plumbing at all is a real
   browser navigation: Google's own /export endpoint sends the doc back as
   a .docx with Content-Disposition: attachment, so opening it (carrying
   whatever Google session cookies the browser already has) downloads it
   like any other link — no fetch, no CORS. From there it's just a Word
   file, and the existing .docx importer takes it from there. */

function extractGoogleDocId(input) {
  var s = (input || "").trim();
  var m = /\/document\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{15,}$/.test(s)) return s; /* the bare ID, pasted directly */
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
  /* No OAuth involved either way (see the comment above this function) —
     just a real navigation to Google's own /export endpoint. Electron's
     renderer has no tab strip for window.open(url, "_blank") to open a
     new one in, and no cookie jar shared with a real browser for a
     private doc's sign-in to land in either, so this hands the URL to
     DESKTOP.openExternal() instead: the system's default browser does the
     download, carrying whatever Google session it already has, exactly
     the same trick this always was. */
  if (S.DESKTOP) {
    S.DESKTOP.openExternal(url);
    closeGdocModal();
    showToast("Opening the Doc as a .docx download in your browser — once it's in your Downloads " +
      "folder, use File ▸ Open… to bring it in.", "ok", true);
    return;
  }
  /* target=_blank rather than a same-tab anchor: a private/unshared doc
     sends back a Google sign-in page instead of a file, which would
     otherwise navigate this tab away from the script mid-edit. Sever
     .opener by hand rather than passing "noopener" to window.open — that
     feature makes window.open always return null, even on success, which
     is also the only way to detect a blocked popup. */
  var win = window.open(url, "_blank");
  if (!win) { showToast("Your browser blocked the download — allow popups for this page and try again.", "warn"); return; }
  win.opener = null;
  closeGdocModal();
  showToast("Downloading the Doc as .docx in a new tab — once it's in your Downloads folder, use File ▸ Open… to bring it in.", "ok", true);
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
