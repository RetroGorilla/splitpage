import { S } from "./_state.js";
import { escapeHtml } from "./02-state.js";
import { rowImage } from "./02c-blobs.js";
import { cellOf, toPlainText } from "./04c-doc-model.js";
import { pad2 } from "./05-render.js";
import { productionEntries, tagCategory } from "./07-production-tags.js";
import { breakdownRows } from "./08-production-panels.js";
import { showToast } from "./12-dirty-toast.js";
import { narrationIncludesDirections, narrationRows, setNarrationIncludesDirections } from "./15-docx.js";
import { exportBaseName, exportFileName } from "./18-local-files.js";
import { modalIsOpen, onFileMenuRefresh, setMenuItemLabel, setMenuItemReason } from "./18b-file-menu.js";
import { writerOpen } from "./19-writer.js";

/* ================= File ▸ Export… (issue #146) =================

   One dialog in place of thirteen menu items. Formats are radio cards in
   two groups — the whole script, or part of it — each with its name, what
   it is for and its extension; the right-hand side shows what the chosen
   one will make: a sketch of its first page, one line of what is in it, the
   options the exporter already has (and only those), and the file name.

   ONE CODE PATH. The dialog builds nothing. Every format's own action is
   still a <button data-file-action="export-…"> in #file-menu (hidden, in
   .menu-hidden-actions), and Export clicks that button — so what the dialog
   makes is byte for byte what the old menu item made, the desktop native
   menu's Export submenu still reaches the same buttons, and the command
   menu (#147) lists each of them.

   REMEMBERED PER DEVICE. The last format exported (by any route) is kept
   under LAST_EXPORT_KEY in localStorage — never in the document, which
   would make a preference about this machine travel with the script — and
   the dialog opens on it; the File menu offers "Export again as …". */

var LAST_EXPORT_KEY = "splitpage-last-export";

/* The table the cards and options are built from. A format with `choices`
   is one card whose options pick between actions; `action` is the
   data-file-action its Export runs. `pictures` says whether the format
   carries the scenes' pictures, for the summary line. */
export var EXPORT_FORMATS = [
  { id: "pdf", group: "whole", name: "PDF", ext: ".pdf", icon: "i-file",
    purpose: "To print, or to send someone to read", action: "export-pdf", pictures: true, extras: true },
  { id: "docx", group: "whole", name: "Word", ext: ".docx", icon: "i-file",
    purpose: "To keep writing in Word or Google Docs", action: "export-docx", pictures: true, extras: true },
  { id: "md", group: "whole", name: "Markdown", ext: ".md", icon: "i-file",
    purpose: "Plain text that reads anywhere", pictures: true, extras: true,
    option: "Shape", choices: [
      { value: "stacked", label: "Stacked", action: "export-md" },
      { value: "table", label: "Two columns", action: "export-md-table" }
    ] },
  { id: "csv", group: "whole", name: "Spreadsheet", ext: ".csv", icon: "i-file",
    purpose: "A row per scene, for Excel or Sheets", action: "export-csv" },
  { id: "html", group: "whole", name: "Standalone page", ext: ".html", icon: "i-globe",
    purpose: "Opens in any browser, nothing to install", action: "export-html", pictures: true },
  { id: "narration", group: "part", name: "Narration only", ext: ".docx / .txt", icon: "i-mic",
    purpose: "The Audio column, for a voice artist",
    option: "Format", choices: [
      { value: "docx", label: "Word (.docx)", action: "export-narration-docx" },
      { value: "txt", label: "Plain text (.txt)", action: "export-narration-txt" }
    ],
    /* #167: a checkbox under the choices, kept per device — the exporter
       reads the same preference, so the dialog still builds nothing
       itself. Functions, not the key: they are there however the modules
       happen to be evaluated. */
    toggle: { id: "directions", label: "Include stage directions",
              on: narrationIncludesDirections, set: setNarrationIncludesDirections } },
  { id: "breakdown", group: "part", name: "Breakdown", ext: ".csv", icon: "i-tag",
    purpose: "Every tagged item, its status and owner", action: "export-breakdown" },
  { id: "packing", group: "part", name: "Packing list", ext: ".pdf", icon: "i-box",
    purpose: "A checklist to tick off before the shoot",
    option: "List", choices: [
      { value: "gear", label: "Gear", action: "export-packing-gear" },
      { value: "prop", label: "Props", action: "export-packing-prop" }
    ] }
];

/* What each action is called on a button or in a list — "Export <this>",
   "Export again as <this>", and the command menu's rows. */
export var EXPORT_ACTION_NAMES = {
  "export-pdf": "PDF",
  "export-docx": "Word",
  "export-md": "Markdown",
  "export-md-table": "Markdown, two columns",
  "export-csv": "Spreadsheet",
  "export-html": "Standalone page",
  "export-narration-docx": "Narration (.docx)",
  "export-narration-txt": "Narration (.txt)",
  "export-breakdown": "Breakdown",
  "export-packing-gear": "Gear packing list",
  "export-packing-prop": "Props packing list"
};

/* buildFileData's kind for each action (18-local-files.js). */
var ACTION_KINDS = {
  "export-pdf": "pdf", "export-docx": "docx", "export-md": "md", "export-md-table": "md-table",
  "export-csv": "csv", "export-html": "html", "export-narration-docx": "narration-docx",
  "export-narration-txt": "narration-txt", "export-breakdown": "breakdown",
  "export-packing-gear": "packing-gear", "export-packing-prop": "packing-prop"
};

export function isExportAction(action) {
  return Object.prototype.hasOwnProperty.call(EXPORT_ACTION_NAMES, action);
}

export function lastExportAction() {
  var saved;
  try { saved = localStorage.getItem(LAST_EXPORT_KEY); } catch (e) { saved = null; }
  return isExportAction(saved) ? saved : null;
}

export function rememberExport(action) {
  if (!isExportAction(action)) return;
  try { localStorage.setItem(LAST_EXPORT_KEY, action); } catch (e) { /* storage full or blocked — the dialog still works, it just won't remember */ }
}

/* Why an export would not produce anything worth having, or "" when it
   would. The same checks exportNarration()/exportPackingList() make before
   they toast (18-local-files.js), asked before the click instead, so the
   dialog and the command menu can say so on the item. */
export function exportActionReason(action) {
  if (!S.state) return "Still loading…";
  if (action === "export-narration-docx" || action === "export-narration-txt") {
    return narrationRows().length ? "" : "The Audio column is empty — there is no narration yet";
  }
  if (action === "export-packing-gear" || action === "export-packing-prop") {
    var catId = action === "export-packing-gear" ? "gear" : "prop";
    var has = productionEntries().some(function (e) { return e.cat.id === catId; });
    var cat = tagCategory(catId);
    return has ? "" : "Nothing tagged " + (cat ? cat.label : catId) + " yet — nothing to pack";
  }
  return "";
}

function formatForAction(action) {
  for (var i = 0; i < EXPORT_FORMATS.length; i++) {
    var f = EXPORT_FORMATS[i];
    if (f.action === action) return { format: f, choice: null };
    if (f.choices) {
      for (var j = 0; j < f.choices.length; j++) {
        if (f.choices[j].action === action) return { format: f, choice: f.choices[j] };
      }
    }
  }
  return null;
}

/* ---- the dialog's state ---- */

var chosenFormat = null;          /* an EXPORT_FORMATS entry */
var chosenChoice = {};            /* format id -> choice value */
var returnFocusTo = null;

function el(id) { return document.getElementById(id); }

function chosenAction() {
  if (!chosenFormat) return null;
  if (!chosenFormat.choices) return chosenFormat.action;
  var v = chosenChoice[chosenFormat.id];
  var c = chosenFormat.choices.filter(function (x) { return x.value === v; })[0] || chosenFormat.choices[0];
  return c.action;
}

function buildCards() {
  var host = el("export-formats");
  if (!host || host.getAttribute("data-built")) return;
  host.setAttribute("data-built", "1");
  var groups = [["whole", "Whole script"], ["part", "Part of it"]];
  host.innerHTML = groups.map(function (g) {
    return '<div class="export-group-head" id="export-g-' + g[0] + '">' + g[1] + '</div>' +
      '<div class="export-cards" role="group" aria-labelledby="export-g-' + g[0] + '">' +
      EXPORT_FORMATS.filter(function (f) { return f.group === g[0]; }).map(function (f) {
        return '<label class="export-card" data-format="' + f.id + '">' +
          '<input type="radio" name="export-format" value="' + f.id + '">' +
          '<svg class="export-card-icon" aria-hidden="true"><use href="#' + f.icon + '"/></svg>' +
          '<span class="export-card-name">' + escapeHtml(f.name) + '</span>' +
          '<span class="export-card-ext">' + escapeHtml(f.ext) + '</span>' +
          '<span class="export-card-purpose">' + escapeHtml(f.purpose) + '</span>' +
        '</label>';
      }).join("") + '</div>';
  }).join("");
}

function renderOptions() {
  var host = el("export-options");
  if (!host) return;
  var f = chosenFormat;
  if (!f || !f.choices) { host.innerHTML = ""; host.hidden = true; return; }
  host.hidden = false;
  var current = chosenChoice[f.id] || f.choices[0].value;
  host.innerHTML = '<div class="export-option" data-for="' + f.id + '">' +
    '<div class="export-option-label" id="export-opt-' + f.id + '">' + escapeHtml(f.option) + '</div>' +
    '<div class="export-seg" role="radiogroup" aria-labelledby="export-opt-' + f.id + '">' +
    f.choices.map(function (c) {
      return '<label><input type="radio" name="export-choice" value="' + c.value + '" data-action="' + c.action + '"' +
        (c.value === current ? " checked" : "") + '>' + escapeHtml(c.label) + '</label>';
    }).join("") + '</div></div>' +
    (f.toggle
      ? '<label class="export-toggle"><input type="checkbox" name="export-toggle" data-toggle="' + escapeHtml(f.toggle.id) + '"' +
        (f.toggle.on() ? " checked" : "") + '> ' + escapeHtml(f.toggle.label) + '</label>'
      : "");
}

function trunc(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

/* a stage direction as the file prints it, "(beat)" (#167) — or, for the
   narration with them switched off, not at all */
function cellText(html, n, opts) { return escapeHtml(trunc(toPlainText(cellOf(html), opts), n)); }

/* A sketch of the first page: the real title and the first scenes' words,
   laid out the way the format lays them out. Escaped all the way — it is
   the document's text going into markup. */
function previewHtml(action) {
  var title = escapeHtml(S.state.title || "Untitled Script");
  var rows = S.state.rows.slice(0, 7);
  var table = function (withNo, picture) {
    return '<table class="pv-table"><tr>' + (withNo ? '<th class="pv-no">No.</th>' : '') +
      '<th>Visual</th><th>Audio</th></tr>' +
      rows.map(function (r, i) {
        return '<tr>' + (withNo ? '<td class="pv-no">' + pad2(i + 1) + '</td>' : '') +
          '<td>' + (picture && rowImage(r) ? '<span class="pv-img"></span>' : '') + cellText(r.visualText, 70) + '</td>' +
          '<td>' + cellText(r.audioText, 110) + '</td></tr>';
      }).join("") + '</table>';
  };
  if (action === "export-pdf") return '<div class="pv-title">' + title + '</div>' + table(false, true);
  if (action === "export-docx") return '<div class="pv-title">' + title + '</div>' + table(true, true);
  if (action === "export-md") {
    return '<div class="pv-mono">' + "# " + title + "\n\n" + rows.slice(0, 4).map(function (r, i) {
      var v = cellText(r.visualText, 60), a = cellText(r.audioText, 120);
      return "### Scene " + pad2(i + 1) + "\n" + (v ? "*Visual — " + v + "*\n" : "") + a + "\n";
    }).join("\n") + '</div>';
  }
  if (action === "export-md-table") {
    return '<div class="pv-mono">' + "# " + title + "\n\n| # | Visual | Audio |\n|---|---|---|\n" + rows.map(function (r, i) {
      return "| " + pad2(i + 1) + " | " + cellText(r.visualText, 40) + " | " + cellText(r.audioText, 70) + " |";
    }).join("\n") + '</div>';
  }
  if (action === "export-csv") {
    return '<table class="pv-table pv-grid"><tr><td>Scene</td><td>Status</td><td>Visual</td><td>Audio</td></tr>' +
      rows.map(function (r, i) {
        return '<tr><td>' + pad2(i + 1) + '</td><td>' + escapeHtml(r.status || "todo") + '</td><td>' +
          cellText(r.visualText, 30) + '</td><td>' + cellText(r.audioText, 45) + '</td></tr>';
      }).join("") + '</table>';
  }
  if (action === "export-html") {
    return '<div class="pv-app"><div class="pv-app-bar">Splitpage / ' + title + '</div>' + table(false, true) + '</div>';
  }
  if (action === "export-narration-docx" || action === "export-narration-txt") {
    var paras = narrationRows().slice(0, 8);
    var mono = action === "export-narration-txt" ? ' pv-mono' : '';
    var said = narrationIncludesDirections() ? null : { directions: "omit" };
    return '<div class="pv-title">' + title + '</div><div class="' + mono.trim() + '">' +
      (paras.length ? paras.map(function (r) { return '<p class="pv-para">' + cellText(r.audioText, 180, said) + '</p>'; }).join("")
                    : '<p class="pv-para">(no narration yet)</p>') + '</div>';
  }
  if (action === "export-breakdown") {
    var items = breakdownRows().slice(0, 14);
    return '<table class="pv-table pv-grid"><tr><td>Category</td><td>Item</td><td>Status</td></tr>' +
      (items.length ? items.map(function (b) {
        return '<tr><td>' + escapeHtml(b.categoryLabel) + '</td><td>' + escapeHtml(trunc(b.name, 28)) + '</td><td>' + escapeHtml(b.statusLabel) + '</td></tr>';
      }).join("") : '<tr><td colspan="3">(nothing tagged yet)</td></tr>') + '</table>';
  }
  if (action === "export-packing-gear" || action === "export-packing-prop") {
    var catId = action === "export-packing-gear" ? "gear" : "prop";
    var cat = tagCategory(catId);
    var list = productionEntries().filter(function (e) { return e.cat.id === catId; }).slice(0, 16);
    return '<div class="pv-title">' + escapeHtml((cat ? cat.label : catId) + " packing list") + '</div>' +
      '<div class="pv-sub">' + title + '</div>' +
      (list.length ? list.map(function (e) { return '<div class="pv-check">' + escapeHtml(trunc(e.name, 40)) + '</div>'; }).join("")
                   : '<p class="pv-para">(nothing tagged yet)</p>');
  }
  return "";
}

function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

/* One line of what the chosen export will hold. */
export function exportSummary(action) {
  var f = formatForAction(action);
  if (!f || !S.state) return "";
  var rows = S.state.rows;
  var bits = [];
  if (f.format.group === "whole") {
    bits.push(plural(rows.length, "scene"));
    var pics = rows.filter(function (r) { return !!rowImage(r); }).length;
    if (!f.format.pictures) bits.push("pictures not included");
    else if (pics) bits.push(plural(pics, "picture") + (action === "export-md" ? " in a zip beside it" : " included"));
    if (f.format.extras) bits.push("breakdown and comments at the end");
    if (action === "export-html") bits.push("editable, with Splitpage around it");
  } else if (f.format.id === "narration") {
    bits.push(plural(narrationRows().length, "scene") + " of narration");
    bits.push(narrationIncludesDirections() ? "no visuals, breakdown or comments"
      : "no visuals, stage directions, breakdown or comments");
  } else if (f.format.id === "breakdown") {
    bits.push(plural(breakdownRows().length, "tagged item"));
    bits.push("category, status, owner and scenes");
  } else if (f.format.id === "packing") {
    var catId = action === "export-packing-gear" ? "gear" : "prop";
    bits.push(plural(productionEntries().filter(function (e) { return e.cat.id === catId; }).length, "item") + " to pack");
  }
  return bits.join(" · ");
}

/* The name the export will get: exportFileName() is what buildFileData()
   names it with, so this cannot say one thing and save another. A Markdown
   export with pictures ships as a zip. */
export function exportFileNameFor(action) {
  var kind = ACTION_KINDS[action];
  if (!kind || !S.state) return "";
  var bundle = kind === "md" && S.state.rows.some(function (r) { return !!rowImage(r); });
  return exportFileName(kind, exportBaseName(), { imageBundle: bundle });
}

function renderSide() {
  var action = chosenAction();
  if (!action) return;
  el("export-preview").innerHTML = previewHtml(action);
  el("export-summary").textContent = exportSummary(action);
  el("export-filename").textContent = exportFileNameFor(action);
  var why = exportActionReason(action);
  var whyEl = el("export-why");
  whyEl.textContent = why;
  whyEl.hidden = !why;
  var go = el("export-go");
  go.textContent = "Export " + EXPORT_ACTION_NAMES[action];
  go.disabled = !!why;
  go.setAttribute("data-export-action", action);
  /* A card whose every option cannot work says so in place of its purpose. */
  EXPORT_FORMATS.forEach(function (f) {
    var card = document.querySelector('.export-card[data-format="' + f.id + '"]');
    if (!card) return;
    var actions = f.choices ? f.choices.map(function (c) { return c.action; }) : [f.action];
    var reasons = actions.map(exportActionReason);
    var none = reasons.every(Boolean);
    card.classList.toggle("is-unavailable", none);
    card.querySelector(".export-card-purpose").textContent = none ? reasons[0] : f.purpose;
  });
}

function choose(formatId, focus) {
  var f = EXPORT_FORMATS.filter(function (x) { return x.id === formatId; })[0] || EXPORT_FORMATS[0];
  chosenFormat = f;
  var radio = document.querySelector('#export-formats input[value="' + f.id + '"]');
  if (radio) {
    radio.checked = true;
    if (focus) radio.focus();
  }
  renderOptions();
  renderSide();
}

/* ---- opening, closing, exporting ---- */

export function exportDialogOpen() {
  var m = el("export-modal");
  return !!m && !m.hidden;
}

export function openExportDialog(opts) {
  opts = opts || {};
  if (!S.state) { showToast("Still loading…", "warn"); return false; }
  var modal = el("export-modal");
  if (!modal || !modal.hidden) return false;
  buildCards();
  returnFocusTo = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  /* Start on the format exported last on this device, with the option it
     was exported with; a first visit starts on PDF. */
  var pick = formatForAction(opts.action || lastExportAction() || "export-pdf");
  if (pick && pick.choice) chosenChoice[pick.format.id] = pick.choice.value;
  modal.hidden = false;
  choose(pick ? pick.format.id : "pdf", true);
  return true;
}

export function closeExportDialog() {
  var modal = el("export-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  var back = returnFocusTo;
  returnFocusTo = null;
  if (back && document.contains(back) && typeof back.focus === "function") back.focus();
}

/* Runs the action through its own File-menu button — the one code path
   every route shares — after the dialog is out of the way. */
export function runExportAction(action) {
  var btn = document.querySelector('#file-menu [data-file-action="' + action + '"]');
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}

function exportChosen() {
  var action = chosenAction();
  if (!action || exportActionReason(action)) return;
  closeExportDialog();
  runExportAction(action);
}

/* File ▸ Export again as … — the remembered action, straight away. */
export function exportAgain() {
  var action = lastExportAction();
  if (!action) { openExportDialog(); return; }
  var why = exportActionReason(action);
  if (why) { showToast(why + ".", "warn"); return; }
  runExportAction(action);
}

function refreshExportAgainItem() {
  var item = el("menu-export-again");
  if (!item) return;
  var action = lastExportAction();
  item.hidden = !action;
  if (!action) return;
  setMenuItemLabel(item, "Export again as " + EXPORT_ACTION_NAMES[action]);
  var why = exportActionReason(action);
  item.disabled = !!why;
  setMenuItemReason(item, why);
}

/* Tab stays inside the dialog while it is open. */
function trapTab(e) {
  var modal = el("export-modal");
  var focusables = Array.prototype.filter.call(
    modal.querySelectorAll('button, input[type="radio"]:checked, input[type="checkbox"], [tabindex]:not([tabindex="-1"])'),
    function (x) { return !x.disabled && x.getClientRects().length > 0; });
  if (!focusables.length) return;
  var first = focusables[0];
  var last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  var modal = el("export-modal");
  if (!modal) return;
  modal.addEventListener("change", function (e) {
    var t = e.target;
    if (t.name === "export-format") choose(t.value, false);
    else if (t.name === "export-choice" && chosenFormat) {
      chosenChoice[chosenFormat.id] = t.value;
      renderSide();
    } else if (t.name === "export-toggle" && chosenFormat && chosenFormat.toggle) {
      chosenFormat.toggle.set(t.checked);
      renderSide();
    }
  });
  modal.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeExportDialog(); }
    else if (e.key === "Tab") trapTab(e);
    /* Enter on a card or an option is the same as pressing Export */
    else if (e.key === "Enter" && e.target.matches && e.target.matches('input[type="radio"]')) {
      e.preventDefault();
      exportChosen();
    }
  });
  /* a click on the scrim, not the panel, closes it like the other dialogs */
  modal.addEventListener("click", function (e) { if (e.target === modal) closeExportDialog(); });
  el("export-close").addEventListener("click", closeExportDialog);
  el("export-cancel").addEventListener("click", closeExportDialog);
  el("export-go").addEventListener("click", exportChosen);
  el("export-share-link").addEventListener("click", function () {
    closeExportDialog();
    runExportAction("share-link");
  });
  onFileMenuRefresh(refreshExportAgainItem);

  /* Ctrl/Cmd+E, in both builds: the desktop app's File ▸ Export… shows the
     accelerator but does not register it (desktop/main.js), so the
     keystroke reaches this listener there too and nothing fires twice. Not
     over a dialog, the teleprompter or the writer — the same places Find's
     Ctrl+F stays out of. */
  window.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (String(e.key || "").toLowerCase() !== "e") return;
    if (!S.state || modalIsOpen() || S.prompterOpen || writerOpen) return;
    e.preventDefault();
    var menu = el("file-menu");
    if (menu && !menu.hidden) menu.querySelector('[data-file-action="export"]').click();
    else openExportDialog();
  });

  /* ---- test hook ----
     What the suites need that clicking cannot give them: the table the
     cards are built from, and the remembered choice. Nothing in the app
     reads this. */
  window.__exportTest = {
    formats: EXPORT_FORMATS,
    names: EXPORT_ACTION_NAMES,
    last: lastExportAction,
    reason: exportActionReason,
    fileName: exportFileNameFor,
    chosen: chosenAction
  };
}
