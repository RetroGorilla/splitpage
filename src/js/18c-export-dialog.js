import { S } from "./_state.js";
import { escapeHtml } from "./02-state.js";
import { rowImage } from "./02c-blobs.js";
import { cellOf, toPlainText } from "./04c-doc-model.js";
import { productionEntries, tagCategory } from "./07-production-tags.js";
import { breakdownRows } from "./08-production-panels.js";
import { showToast } from "./12-dirty-toast.js";
import { exportMetaLine, tagPrintColor, toMarkdownDoc, toMarkdownTableDoc } from "./14-export.js";
import {
  brollSummaryText, commentNumbers, exportBrollScenes, exportComments, exportFacts, exportRuns, sceneFacts
} from "./14b-export-kit.js";
import { narrationIncludesDirections, narrationRows, setNarrationIncludesDirections } from "./15-docx.js";
import { exportBaseName, exportFileName } from "./18-local-files.js";
import { onFileMenuRefresh, overlayRefusing, setMenuItemLabel, setMenuItemReason } from "./18b-file-menu.js";

var LAST_EXPORT_KEY = "splitpage-last-export";

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
  { id: "csv", group: "whole", name: "Spreadsheet", ext: ".xlsx / .csv", icon: "i-file",
    purpose: "A row per scene, for Excel, Sheets or Numbers",
    option: "Format", choices: [
      { value: "xlsx", label: "Excel (.xlsx)", action: "export-xlsx" },
      { value: "csv", label: "CSV (.csv)", action: "export-csv" }
    ] },
  { id: "html", group: "whole", name: "SplitShare", ext: ".html", icon: "i-globe",
    purpose: "The script and the whole app in one file. Any device, nothing to install", action: "export-html", pictures: true },
  { id: "narration", group: "part", name: "Narration only", ext: ".docx / .txt", icon: "i-mic",
    purpose: "The Audio column, for a voice artist",
    option: "Format", choices: [
      { value: "docx", label: "Word (.docx)", action: "export-narration-docx" },
      { value: "txt", label: "Plain text (.txt)", action: "export-narration-txt" }
    ],
    toggle: { id: "directions", label: "Include stage directions",
              on: narrationIncludesDirections, set: setNarrationIncludesDirections } },
  { id: "breakdown", group: "part", name: "Breakdown", ext: ".xlsx / .csv", icon: "i-tag",
    purpose: "Every tagged item, its status and owner",
    option: "Format", choices: [
      { value: "xlsx", label: "Excel (.xlsx)", action: "export-breakdown-xlsx" },
      { value: "csv", label: "CSV (.csv)", action: "export-breakdown" }
    ] },
  { id: "packing", group: "part", name: "Packing list", ext: ".pdf", icon: "i-box",
    purpose: "A checklist for the shoot: out, back, and signed off",
    option: "List", choices: [
      { value: "gear", label: "Gear", action: "export-packing-gear" },
      { value: "prop", label: "Props", action: "export-packing-prop" }
    ] },
  { id: "broll", group: "part", name: "B-roll shot list", ext: ".pdf / .xlsx / .csv", icon: "i-camera",
    purpose: "Every shot, with props, flags and room for notes",
    option: "Format", choices: [
      { value: "pdf", label: "PDF, landscape", action: "export-broll-pdf" },
      { value: "xlsx", label: "Excel (.xlsx)", action: "export-broll-xlsx" },
      { value: "csv", label: "CSV (.csv)", action: "export-broll-csv" }
    ] }
];

export var EXPORT_ACTION_NAMES = {
  "export-pdf": "PDF",
  "export-docx": "Word",
  "export-md": "Markdown",
  "export-md-table": "Markdown, two columns",
  "export-xlsx": "Excel",
  "export-csv": "CSV",
  "export-html": "SplitShare",
  "export-narration-docx": "Narration (.docx)",
  "export-narration-txt": "Narration (.txt)",
  "export-breakdown-xlsx": "Breakdown (Excel)",
  "export-breakdown": "Breakdown (.csv)",
  "export-packing-gear": "Gear packing list",
  "export-packing-prop": "Props packing list",
  "export-broll-pdf": "B-roll shot list",
  "export-broll-xlsx": "B-roll shot list (Excel)",
  "export-broll-csv": "B-roll shot list (.csv)"
};

var ACTION_KINDS = {
  "export-pdf": "pdf", "export-docx": "docx", "export-md": "md", "export-md-table": "md-table",
  "export-xlsx": "xlsx", "export-csv": "csv", "export-html": "html", "export-narration-docx": "narration-docx",
  "export-narration-txt": "narration-txt", "export-breakdown-xlsx": "breakdown xlsx", "export-breakdown": "breakdown",
  "export-packing-gear": "packing-gear", "export-packing-prop": "packing-prop",
  "export-broll-pdf": "b-roll pdf", "export-broll-xlsx": "b-roll xlsx", "export-broll-csv": "b-roll csv"
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
  try { localStorage.setItem(LAST_EXPORT_KEY, action); } catch (e) { }
}

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
  if (action === "export-broll-pdf" || action === "export-broll-xlsx" || action === "export-broll-csv") {
    return exportBrollScenes().length ? "" : "No b-roll yet — start a Visual line with \"B-roll:\"";
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

var chosenFormat = null;
var chosenChoice = {};
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

function cellText(html, n, opts) { return escapeHtml(trunc(toPlainText(cellOf(html), opts), n)); }

function pvRuns(html, n, nums) {
  var out = "", left = n;
  var runs = exportRuns(html, nums);
  for (var i = 0; i < runs.length && left > 0; i++) {
    var r = runs[i];
    if (r.broll) { out += '<span class="pv-broll">B-roll</span>'; continue; }
    if (r.text === "\n") { out += "<br>"; continue; }
    var t = r.text.replace(/\s+/g, " ");
    if (t.length > left) t = t.slice(0, left).trimEnd() + "…";
    left -= t.length;
    var h = escapeHtml(t);
    if (r.tag && r.tag.color) h = '<span class="pv-tag" style="--pv-c:#' + r.tag.color + '">' + h + '</span>';
    else if (r.dir) h = '<span class="pv-dir">' + h + '</span>';
    else if (r.cue) h = '<span class="pv-cue">' + h + '</span>';
    if (r.markers && left > 0) h += r.markers.map(function (m) { return '<span class="pv-mk">' + m + '</span>'; }).join("");
    out += h;
  }
  return out;
}

function pvTitleBlock(title) {
  return '<div class="pv-title">' + title + '</div>' +
    (S.state.rows.length ? '<div class="pv-meta">' + escapeHtml(exportMetaLine()) + '</div>' : '');
}

function pvLamp(id) { return '<i class="pv-lamp pv-lamp-' + escapeHtml(id) + '" aria-hidden="true"></i>'; }

function pvPill(id) {
  var ids = ["needed", "sourcing", "have", "returned"];
  var level = id === null ? -1 : Math.max(0, ids.indexOf(id));
  return '<span class="pv-pill' + (level === -1 ? ' pv-pill-key' : ' pv-pill-' + ids[level]) + '" aria-hidden="true">' +
    ids.map(function (x, i) { return '<i' + (i <= level ? ' class="is-on"' : '') + '></i>'; }).join("") + '</span>';
}

function pvRundown(scenes, legend) {
  if (!scenes.length) return "";
  var facts = exportFacts();
  var mark = facts.target && facts.seconds
    ? '<b class="pv-rd-target" style="left:' + Math.min(100, facts.target.seconds / Math.max(facts.seconds, facts.target.seconds) * 100).toFixed(2) + '%"></b>'
    : "";
  return '<div class="pv-rundown">' + scenes.map(function (f) {
    return '<i class="pv-rd pv-rd-' + escapeHtml(f.status.id) + '" style="flex-grow:' + Math.max(1, f.seconds) + '"></i>';
  }).join("") + mark + '</div>' +
    (legend ? '<div class="pv-legend">' + [["shot", "Shot"], ["ready", "Ready"], ["todo", "To do"]].map(function (s) {
      return '<span>' + pvLamp(s[0]) + s[1] + ' ' + facts.status[s[0]] + '</span>';
    }).join("") + '</div>' : '<div class="pv-legend"></div>');
}

function pvScript(title, opts) {
  var scenes = sceneFacts();
  var nums = commentNumbers();
  var html = (opts.app ? "" : pvTitleBlock(title)) + (opts.rundown ? pvRundown(scenes, !opts.app) : "");
  if (!S.state.rows.length) return html + '<p class="pv-para pv-faint">(no scenes yet)</p>';
  html += '<div class="pv-script' + (opts.word ? ' pv-script-word' : '') + '">' +
    '<div class="pv-sh"><span>Scene</span><span><i class="pv-dot pv-dot-v"></i>Visual</span>' +
    '<span><i class="pv-dot pv-dot-a"></i>Audio</span><span class="pv-read">Read</span></div>' +
    S.state.rows.slice(0, 6).map(function (r, i) {
      var f = scenes[i];
      return '<div class="pv-sc">' +
        '<div class="pv-gut"><b>' + f.number + '</b> <span class="pv-tc">' + f.start + '</span>' +
          '<span class="pv-st">' + pvLamp(f.status.id) + escapeHtml(f.status.label) + '</span></div>' +
        '<div>' + (rowImage(r) ? '<span class="pv-img"></span>' : '') + pvRuns(r.visualText, 90, nums) + '</div>' +
        '<div class="pv-aud">' + pvRuns(r.audioText, 150, nums) + '</div>' +
        '<div class="pv-read"><span' + (f.readSet ? ' class="pv-set"' : '') + '>' + f.read + '</span></div>' +
      '</div>';
    }).join("") + '</div>';
  return html;
}

function pvFooter(title, what) {
  return '<div class="pv-foot"><span>' + title + (what ? " — " + escapeHtml(what) : "") + '</span><span>Page 1</span></div>';
}

function pvTextLines(text, n) {
  return '<div class="pv-mono">' + String(text).split("\n").slice(0, n).map(function (l) {
    var h = escapeHtml(trunc(l, 150)) || " ";
    if (/^#{1,3} /.test(l)) return '<span class="pv-md-h">' + h + '</span>';
    if (/^_.*_$/.test(l) || /^\*\*[^*]+\*\* · Read /.test(l)) return '<span class="pv-md-q">' + h + '</span>';
    return h;
  }).join("\n") + '</div>';
}

function pvGrid(head, rows, widths) {
  return '<table class="pv-table pv-grid"><colgroup>' + widths.map(function (w) { return '<col style="width:' + w + '%">'; }).join("") +
    '</colgroup><tr class="pv-gh">' + head.map(function (c) { return '<td>' + escapeHtml(c) + '</td>'; }).join("") + '</tr>' +
    rows.map(function (r) {
      return '<tr' + (r.cls ? ' class="' + r.cls + '"' : '') + '>' + r.cells.map(function (c) { return '<td>' + c + '</td>'; }).join("") + '</tr>';
    }).join("") + '</table>';
}

function pvShotList(title) {
  var groups = exportBrollScenes();
  var rows = [];
  groups.forEach(function (g) {
    g.items.forEach(function (r, i) {
      rows.push({ cells: [
        '<i class="pv-box' + (r.shot ? ' is-ticked' : '') + '"></i>',
        i ? "" : '<b>' + escapeHtml(g.scene) + '</b>',
        '<b' + (r.shot ? ' class="pv-faint"' : '') + '>' + escapeHtml(trunc(r.name, 34)) + '</b>',
        escapeHtml(trunc(r.location, 14)),
        escapeHtml(trunc((r.props || []).join(", "), 18)),
        r.flagged ? '<b class="pv-flag">Flagged</b>' : "",
        '<i class="pv-write"></i>'
      ] });
    });
  });
  return '<div class="pv-eyebrow">B-roll shot list</div><div class="pv-title">' + title + '</div>' +
    '<div class="pv-meta">' + escapeHtml(brollSummaryText(groups)) + ' · by scene · ' + escapeHtml(exportFacts().date) + '</div>' +
    pvGrid(["Done", "Scene", "B-roll shot", "Location", "Props", "Flagged", "Notes"], rows.slice(0, 12), [6, 7, 30, 13, 16, 10, 18]) +
    pvFooter(title, "B-roll shot list");
}

function xlsxSheetNames() {
  var names = ["Script"];
  if (exportComments().length) names.push("Comments");
  if (breakdownRows().length) names.push("Breakdown");
  if (exportBrollScenes().length) names.push("B-roll");
  return names;
}

function pvWorkbook(grid, sheets) {
  return '<div class="pv-xl">' + grid + '</div>' +
    '<div class="pv-sheets">' + sheets.map(function (s, i) {
      return '<span class="pv-sheet' + (i ? '' : ' is-on') + '">' + escapeHtml(s) + '</span>';
    }).join("") + '</div>';
}

function previewHtml(action) {
  var title = escapeHtml(S.state.title || "Untitled Script");
  var rows = S.state.rows.slice(0, 7);
  if (action === "export-broll-pdf") return pvShotList(title);
  if (action === "export-broll-csv" || action === "export-broll-xlsx") {
    var shots = [];
    exportBrollScenes().forEach(function (g) {
      g.items.forEach(function (r) {
        shots.push({ cells: [escapeHtml(g.scene), escapeHtml(trunc(r.name, 24)), r.shot ? "Shot" : "To shoot",
                             r.flagged ? "yes" : "", escapeHtml(trunc(r.location, 12)), escapeHtml(g.start)] });
      });
    });
    var shotGrid = pvGrid(["Scene", "Shot", "Status", "Flagged", "Location", "Scene start"], shots.slice(0, 14), [11, 33, 15, 13, 16, 12]);
    return action === "export-broll-xlsx" ? pvWorkbook(shotGrid, ["B-roll"]) : shotGrid;
  }
  if (action === "export-pdf") return pvScript(title, { rundown: true }) + pvFooter(title);
  if (action === "export-docx") return pvScript(title, { word: true }) + pvFooter(title);
  if (action === "export-md") return pvTextLines(toMarkdownDoc({ scenes: 3 }), 40);
  if (action === "export-md-table") return pvTextLines(toMarkdownTableDoc(null, { export: true, scenes: 7 }), 20);
  if (action === "export-csv" || action === "export-xlsx") {
    var scenes = sceneFacts();
    var sheetHead = ["Scene", "Start", "Status", "Read", "Visual", "Audio"];
    var sheetRows = rows.slice(0, 5).map(function (r, i) {
      var f = scenes[i];
      return { cells: [f.number, f.start, escapeHtml(f.status.label), f.read,
                       cellText(r.visualText, 34), cellText(r.audioText, 44)] };
    }).concat(rows.length ? [
      { cls: "pv-gap", cells: ["…", "", "", "", "", ""] },
      { cls: "pv-total", cells: ["Total", "", escapeHtml(exportFacts().status.shot + " of " + S.state.rows.length + " shot"),
                                 escapeHtml(exportFacts().runtime), "", ""] }
    ] : []);
    if (action === "export-csv") return pvGrid(sheetHead, sheetRows, [12, 12, 14, 10, 25, 27]);
    return pvWorkbook(pvGrid(sheetHead.concat(["Notes"]), sheetRows.map(function (r) {
      return { cls: r.cls, cells: r.cells.concat([""]) };
    }), [12, 12, 14, 10, 18, 20, 14]), xlsxSheetNames());
  }
  if (action === "export-html") {
    return '<div class="pv-app"><div class="pv-tabbar"><span class="pv-tab">' + title + ' — SplitShare</span></div>' +
      '<div class="pv-app-bar">Splitpage <span>' + title + '</span></div>' +
      '<div class="pv-app-page">' + pvScript(title, { app: true, rundown: true }) + '</div></div>';
  }
  if (action === "export-narration-docx" || action === "export-narration-txt") {
    var paras = narrationRows().slice(0, 8);
    var txt = action === "export-narration-txt";
    var said = narrationIncludesDirections() ? { cues: "omit" } : { directions: "omit", cues: "omit" };
    var numbers = sceneFacts();
    var words = String(exportFacts().words).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (txt ? '<div class="pv-mono pv-md-h">' + title + '</div><br>'
      : '<div class="pv-title">' + title + '</div><div class="pv-meta">Narration · ' +
        escapeHtml(plural(narrationRows().length, "scene") + " · " + words + " words") + '</div>') +
      '<div class="' + (txt ? 'pv-mono' : 'pv-narr') + '">' +
      (paras.length ? paras.map(function (r) {
        var n = txt ? "" : '<span class="pv-margin">' + numbers[S.state.rows.indexOf(r)].number + '</span>';
        return '<p class="pv-para">' + n + cellText(r.audioText, 180, said) + '</p>';
      }).join("") : '<p class="pv-para">(no narration yet)</p>') + '</div>';
  }
  if (action === "export-breakdown" || action === "export-breakdown-xlsx") {
    var starts = sceneFacts().map(function (f) { return f.start; });
    var items = breakdownRows().slice(0, 14);
    var itemGrid = pvGrid(["Category", "Item", "Status", "Scenes", "First at"], items.map(function (b) {
      var first = b.inScript === "no" ? "" : (starts[Number(b.scenes[0]) - 1] || "");
      return { cells: [escapeHtml(b.categoryLabel), escapeHtml(trunc(b.name, 24)), escapeHtml(b.statusLabel),
                       escapeHtml(trunc(b.scenes.join(" "), 14)), first] };
    }), [17, 29, 17, 21, 16]) + (items.length ? "" : '<p class="pv-para pv-faint">(nothing tagged yet)</p>');
    return action === "export-breakdown-xlsx" ? pvWorkbook(itemGrid, ["Breakdown"]) : itemGrid;
  }
  if (action === "export-packing-gear" || action === "export-packing-prop") {
    var catId = action === "export-packing-gear" ? "gear" : "prop";
    var cat = tagCategory(catId);
    var color = tagPrintColor(catId);
    var heading = cat ? cat.plural : catId;
    var all = breakdownRows().filter(function (b) { return b.catId === catId; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    var list = all.slice(0, 12);
    return '<div class="pv-eyebrow">Packing list</div>' +
      '<div class="pv-pack-head"><i class="pv-dot" style="--pv-c:#' + (color || "171613") + '"></i>' +
        escapeHtml(heading) + '</div>' +
      '<div class="pv-meta">' + title + ' · ' + escapeHtml(exportFacts().date) +
        (all.length ? '<br>' + escapeHtml(packingSummary(all)) : '') + '</div>' +
      (list.length
        ? '<div class="pv-pill-legend">Status ' + pvPill(null) + '<span class="pv-faint">Needed · Sourcing · Have it · Returned</span></div>' +
          '<div class="pv-pack"><div class="pv-pack-row pv-pack-h"><span>Out</span><span>Back</span><span>Item</span><span>Status</span>' +
            '<span>Owner</span><span>Scenes</span></div>' +
          list.map(function (b) {
            return '<div class="pv-pack-row"><i class="pv-box"></i><i class="pv-box"></i>' +
              '<span class="pv-pack-item"><b>' + escapeHtml(trunc(b.name, 30)) + '</b>' +
                (b.notes ? '<span class="pv-faint">' + escapeHtml(trunc(b.notes, 44)) + '</span>' : '') + '</span>' +
              '<span>' + pvPill(b.status) + '</span>' +
              '<span>' + escapeHtml(trunc(b.owner, 12)) + '</span>' +
              '<span>' + escapeHtml(b.scenes.join(", ")) + '</span></div>';
          }).join("") + '</div>' +
          '<div class="pv-sign"><span>Packed by</span><i></i><span>Date</span><i></i>' +
            '<span>Returned by</span><i></i><span>Date</span><i></i></div>'
        : '<p class="pv-para">(nothing tagged yet)</p>') +
      pvFooter(title, heading + " packing list");
  }
  return "";
}

function packingSummary(items) {
  var n = {}, label = {};
  items.forEach(function (e) {
    n[e.status] = (n[e.status] || 0) + 1;
    label[e.status] = e.statusLabel.toLowerCase();
  });
  var out = [plural(items.length, "item")];
  ["have", "sourcing", "needed", "returned"].forEach(function (id) {
    if (n[id]) out.push(n[id] + " " + label[id]);
  });
  return out.join(" · ");
}

function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

function listed(parts) {
  return parts.length < 2 ? parts.join("") : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

function tailSummary() {
  var parts = [];
  if (breakdownRows().length) parts.push("breakdown");
  if (exportBrollScenes().length) parts.push("b-roll shot list");
  var comments = S.state.comments || [];
  if (comments.length) parts.push(comments.some(function (c) { return !c.resolved; }) ? "numbered comments" : "comments");
  return parts.length ? listed(parts) + " at the end" : "";
}

export function exportSummary(action) {
  var f = formatForAction(action);
  if (!f || !S.state) return "";
  var rows = S.state.rows;
  var bits = [];
  if (f.format.group === "whole") {
    var pics = rows.filter(function (r) { return !!rowImage(r); }).length;
    if (action === "export-csv") {
      bits.push(plural(rows.length, "scene") + (rows.length ? ", with start and read times, tags and b-roll" : ""));
      if ((S.state.comments || []).length) bits.push("comments below");
    } else if (action === "export-xlsx") {
      bits.push(plural(rows.length, "scene") + (rows.length ? ", with start and read times, tags and b-roll" : ""));
      var more = xlsxSheetNames().slice(1).map(function (s) { return s.toLowerCase(); });
      if (more.length) bits.push((more.length === 1 ? "a sheet for " : "sheets for ") + listed(more));
      bits.push("a Notes column to write in");
      bits.push("columns sized, header frozen, filters on");
    } else if (action === "export-html") {
      bits.push(plural(rows.length, "scene"));
    } else {
      bits.push(plural(rows.length, "scene") + (rows.length ? " with timecodes, status and read times" : ""));
    }
    if (!f.format.pictures) bits.push("pictures not included");
    else if (pics) bits.push(plural(pics, "picture") + (action === "export-md" ? " in a zip beside it" : " included"));
    if (f.format.extras) {
      var tail = tailSummary();
      if (tail) bits.push(tail);
    }
    if (action === "export-html") bits.push("the whole app built in — read, edit and present it in any browser, on any device");
  } else if (f.format.id === "narration") {
    bits.push(plural(narrationRows().length, "scene") + " of narration");
    if (action === "export-narration-docx") bits.push("scene numbers in the margin");
    bits.push(narrationIncludesDirections() ? "no visuals, breakdown or comments"
      : "no visuals, stage directions, breakdown or comments");
  } else if (f.format.id === "breakdown") {
    bits.push(plural(breakdownRows().length, "tagged item"));
    bits.push("category, status, owner, scenes and where each first appears");
    if (action === "export-breakdown-xlsx") bits.push("columns sized, header frozen, filters on");
  } else if (f.format.id === "packing") {
    var catId = action === "export-packing-gear" ? "gear" : "prop";
    var items = breakdownRows().filter(function (b) { return b.catId === catId; });
    bits.push(plural(items.length, "item") + " to pack");
    var missing = items.filter(function (b) { return b.status === "needed" || b.status === "sourcing"; }).length;
    if (missing) bits.push(missing + " not in hand yet");
  } else if (f.format.id === "broll") {
    var shotGroups = exportBrollScenes();
    var shotCount = shotGroups.reduce(function (n, g) { return n + g.items.length; }, 0);
    bits.push(plural(shotCount, "shot") + ", by scene");
    if (shotCount) bits.push(brollSummaryText(shotGroups));
    bits.push(action === "export-broll-pdf" ? "props, flags and their reasons, and room for notes"
      : "a row a shot: status, flag, location, props, who, notes");
    if (action === "export-broll-xlsx") bits.push("columns sized, header frozen, filters on");
  }
  return bits.join(" · ");
}

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
  el("export-preview").classList.toggle("is-landscape", action === "export-broll-pdf");
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
    else if (e.key === "Enter" && e.target.matches && e.target.matches('input[type="radio"]')) {
      e.preventDefault();
      exportChosen();
    }
  });
  modal.addEventListener("click", function (e) { if (e.target === modal) closeExportDialog(); });
  el("export-close").addEventListener("click", closeExportDialog);
  el("export-cancel").addEventListener("click", closeExportDialog);
  el("export-go").addEventListener("click", exportChosen);
  el("export-share-link").addEventListener("click", function () {
    closeExportDialog();
    runExportAction("collaborate");
  });
  onFileMenuRefresh(refreshExportAgainItem);

  window.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (String(e.key || "").toLowerCase() !== "e") return;
    if (!S.state || overlayRefusing("export")) return;
    e.preventDefault();
    var menu = el("file-menu");
    if (menu && !menu.hidden) menu.querySelector('[data-file-action="export"]').click();
    else openExportDialog();
  });

  window.__exportTest = {
    formats: EXPORT_FORMATS,
    names: EXPORT_ACTION_NAMES,
    last: lastExportAction,
    reason: exportActionReason,
    fileName: exportFileNameFor,
    chosen: chosenAction
  };
}
