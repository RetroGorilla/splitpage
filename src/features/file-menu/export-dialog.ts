import type { FileMenuExportPorts, FileMenuExportMount } from "./ports.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";

type DialogFormat = ReturnType<FileMenuExportMount["exportFormatList"]>[number];
type PreviewGridRow = { cells: string[]; cls?: string | undefined };

import { exportToggleOptions } from "../../application/export/registry.ts";
import { rowImage } from "../../core/document/media.ts";
import { tagCategory } from "../../core/production/looks.ts";
import { escapeHtml, unitSafePrefix } from "../../core/document/text-policy.ts";
import { toPlainText } from "../../core/text/projections.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";
import { exposeTestHook } from "../common/test-hooks.ts";

let ports: FileMenuExportPorts | null = null;

function currentDocument() { return (ports as FileMenuExportPorts).document.current(); }
function captureExportDocument(options?: Parameters<FileMenuExportPorts["capture"]>[0]) { return (ports as FileMenuExportPorts).capture(options); }
function showToast(message: Parameters<FileMenuExportPorts["notices"]["show"]>[0], kind: Parameters<FileMenuExportPorts["notices"]["show"]>[1]) { return (ports as FileMenuExportPorts).notices.show(message, kind); }
function cellOf(html: Parameters<FileMenuExportPorts["text"]["cellOf"]>[0]) { return (ports as FileMenuExportPorts).text.cellOf(html); }
function exportFacts(doc: ExportDocument) { return (ports as FileMenuExportPorts).preview.facts(doc); }
function exportBrollBeats(doc: ExportDocument) { return (ports as FileMenuExportPorts).preview.shots(doc); }
function breakdownRows(doc: ExportDocument) { return (ports as FileMenuExportPorts).preview.breakdown(doc); }
function beatFacts(doc: ExportDocument) { return (ports as FileMenuExportPorts).preview.beats(doc); }
function narrationRows(doc: ExportDocument, opts: Parameters<FileMenuExportPorts["preview"]["narration"]>[1]) { return (ports as FileMenuExportPorts).preview.narration(doc, opts); }
function runExportAction(action: string) { return (ports as FileMenuExportPorts).exportAction(action); }

const exportFormats = {
  cards: function () { return (ports as FileMenuExportPorts).exports.cards(); },
  card: function (id: string) { return (ports as FileMenuExportPorts).exports.card(id); },
  byAction: function (action: string | null | undefined) { return (ports as FileMenuExportPorts).exports.byAction(action); },
  isAction: function (action: unknown): boolean { return (ports as FileMenuExportPorts).exports.isAction(action); },
  exporters: function () { return (ports as FileMenuExportPorts).exports.exporters(); }
};

const LAST_EXPORT_KEY = "splitpage-last-export";

function dialogFormat(card: ReturnType<FileMenuExportPorts["exports"]["cards"]>[number]) {
  const variants = card.variants;
  const out: { -readonly [K in keyof DialogFormat]: DialogFormat[K] } = {
    id: card.id, group: card.group, name: card.name, ext: card.ext, icon: card.icon, purpose: card.purpose,
    pictures: !!card.pictures, extras: !!card.extras
  };
  if (card.toggle) out.toggle = card.toggle;
  if (variants.length === 1 && !(variants[0] as typeof variants[number]).choice) {
    out.action = (variants[0] as typeof variants[number]).action;
    return out;
  }
  out.option = card.option;
  out.choices = variants.map(function (v) {
    return { value: (v.choice as NonNullable<typeof v.choice>).value, label: (v.choice as NonNullable<typeof v.choice>).label, action: v.action };
  });
  return out;
}

function exportFormatList() {
  return exportFormats.cards().map(dialogFormat);
}

function exportActionName(action: string | null | undefined) {
  const exporter = exportFormats.byAction(action);
  return exporter ? exporter.name : "";
}

function isExportAction(action: unknown): boolean {
  return exportFormats.isAction(action);
}

export function lastExportAction() {
  let saved;
  try { saved = localStorage.getItem(LAST_EXPORT_KEY); } catch (e) { saved = null; }
  return isExportAction(saved) ? saved : null;
}

export function rememberExport(action: string | null | undefined) {
  if (!isExportAction(action)) return;
  try { localStorage.setItem(LAST_EXPORT_KEY, action as string); } catch (e) { }
}

function exportOptionsFor(action: string | null | undefined) {
  return exportToggleOptions(exportFormats, exportFormats.byAction(action));
}

function exportActionReason(action: string | null | undefined) {
  if (!currentDocument()) return "Still loading…";
  const exporter = exportFormats.byAction(action);
  return exporter && exporter.reason ? exporter.reason(captureExportDocument()) : "";
}

function formatForAction(action: string | null | undefined) {
  const formats = exportFormatList();
  for (let i = 0; i < formats.length; i++) {
    const f = formats[i] as DialogFormat;
    if (f.action === action) return { format: f, choice: null };
    if (f.choices) {
      for (let j = 0; j < f.choices.length; j++) {
        if ((f.choices[j] as NonNullable<DialogFormat["choices"]>[number]).action === action) return { format: f, choice: f.choices[j] };
      }
    }
  }
  return null;
}

let chosenFormat: DialogFormat | null = null;
let chosenChoice: Record<string, string | undefined> = {};
let returnFocusTo: Element | null = null;

function el(id: string) { return document.getElementById(id); }

function chosenAction() {
  if (!chosenFormat) return null;
  if (!chosenFormat.choices) return chosenFormat.action;
  const v = chosenChoice[chosenFormat.id];
  const c = chosenFormat.choices.filter(function (x) { return x.value === v; })[0] || chosenFormat.choices[0];
  return (c as NonNullable<DialogFormat["choices"]>[number]).action;
}

function buildCards() {
  const host = el("export-formats");
  if (!host || host.getAttribute("data-built")) return;
  host.setAttribute("data-built", "1");
  const groups = [["whole", "Whole script"], ["part", "Part of it"]];
  const formats = exportFormatList();
  host.innerHTML = groups.map(function (g) {
    return '<div class="export-group-head" id="export-g-' + g[0] + '">' + g[1] + '</div>' +
      '<div class="export-cards" role="group" aria-labelledby="export-g-' + g[0] + '">' +
      formats.filter(function (f) { return f.group === g[0]; }).map(function (f) {
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
  const host = el("export-options");
  if (!host) return;
  const f = chosenFormat;
  if (!f || !f.choices) { host.innerHTML = ""; host.hidden = true; return; }
  host.hidden = false;
  const current = chosenChoice[f.id] || (f.choices[0] as NonNullable<DialogFormat["choices"]>[number]).value;
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

function trunc(s: string, n: number) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? unitSafePrefix(s, n - 1).trimEnd() + "…" : s;
}

function cellText(html: Parameters<typeof cellOf>[0], n: number, opts?: Parameters<typeof toPlainText>[1]) { return escapeHtml(trunc(toPlainText(cellOf(html), opts), n)); }

function pvRuns(html: Parameters<FileMenuExportPorts["preview"]["runs"]>[0], n: number, nums: Parameters<FileMenuExportPorts["preview"]["runs"]>[1]) {
  let out = "", left = n;
  const runs = (ports as FileMenuExportPorts).preview.runs(html, nums);
  for (let i = 0; i < runs.length && left > 0; i++) {
    const r = runs[i] as typeof runs[number];
    if (r.broll) { out += '<span class="pv-broll">B-roll</span>'; continue; }
    if (r.text === "\n") { out += "<br>"; continue; }
    let t = r.text.replace(/\s+/g, " ");
    if (t.length > left) t = unitSafePrefix(t, left).trimEnd() + "…";
    left -= t.length;
    let h = escapeHtml(t);
    if (r.tag && r.tag.color) h = '<span class="pv-tag" style="--pv-c:#' + r.tag.color + '">' + h + '</span>';
    else if (r.dir) h = '<span class="pv-dir">' + h + '</span>';
    else if (r.cue) h = '<span class="pv-cue">' + h + '</span>';
    if (r.markers && left > 0) h += r.markers.map(function (m) { return '<span class="pv-mk">' + m + '</span>'; }).join("");
    out += h;
  }
  return out;
}

function pvTitleBlock(title: string, doc: ExportDocument) {
  return '<div class="pv-title">' + title + '</div>' +
    ((currentDocument() as DocumentView).rows.length ? '<div class="pv-meta">' + escapeHtml((ports as FileMenuExportPorts).preview.meta(doc)) + '</div>' : '');
}

function pvLamp(id: string | undefined) { return '<i class="pv-lamp pv-lamp-' + escapeHtml(id) + '" aria-hidden="true"></i>'; }

function pvPill(id: string | null) {
  const ids = ["needed", "sourcing", "have", "returned"];
  const level = id === null ? -1 : Math.max(0, ids.indexOf(id));
  return '<span class="pv-pill' + (level === -1 ? ' pv-pill-key' : ' pv-pill-' + ids[level]) + '" aria-hidden="true">' +
    ids.map(function (x, i) { return '<i' + (i <= level ? ' class="is-on"' : '') + '></i>'; }).join("") + '</span>';
}

function pvRundown(beats: ReturnType<FileMenuExportPorts["preview"]["beats"]>, legend: boolean, doc: ExportDocument) {
  if (!beats.length) return "";
  const facts = exportFacts(doc);
  const mark = facts.target && facts.seconds
    ? '<b class="pv-rd-target" style="left:' + Math.min(100, facts.target.seconds / Math.max(facts.seconds, facts.target.seconds) * 100).toFixed(2) + '%"></b>'
    : "";
  return '<div class="pv-rundown">' + beats.map(function (f) {
    return '<i class="pv-rd pv-rd-' + escapeHtml(f.status.id) + '" style="flex-grow:' + Math.max(1, f.seconds) + '"></i>';
  }).join("") + mark + '</div>' +
    (legend ? '<div class="pv-legend">' + [["shot", "Filmed"], ["ready", "Ready"], ["todo", "To do"]].map(function (s) {
      return '<span>' + pvLamp(s[0]) + s[1] + ' ' + facts.status[s[0] as keyof typeof facts.status] + '</span>';
    }).join("") + '</div>' : '<div class="pv-legend"></div>');
}

function pvScript(title: string, opts: { app?: boolean; rundown?: boolean; word?: boolean }, doc: ExportDocument) {
  const beats = beatFacts(doc);
  const nums = doc.commentNumbers;
  let html = (opts.app ? "" : pvTitleBlock(title, doc)) + (opts.rundown ? pvRundown(beats, !opts.app, doc) : "");
  if (!(currentDocument() as DocumentView).rows.length) return html + '<p class="pv-para pv-faint">(no beats yet)</p>';
  html += '<div class="pv-script' + (opts.word ? ' pv-script-word' : '') + '">' +
    '<div class="pv-sh"><span>Scene</span><span><i class="pv-dot pv-dot-v"></i>Visual</span>' +
    '<span><i class="pv-dot pv-dot-a"></i>Audio</span><span class="pv-read">Read</span></div>' +
    (currentDocument() as DocumentView).rows.slice(0, 6).map(function (r, i) {
      const f = beats[i] as typeof beats[number];
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

function pvFooter(title: string, what?: string) {
  return '<div class="pv-foot"><span>' + title + (what ? " — " + escapeHtml(what) : "") + '</span><span>Page 1</span></div>';
}

function pvTextLines(text: string, n: number) {
  return '<div class="pv-mono">' + String(text).split("\n").slice(0, n).map(function (l) {
    const h = escapeHtml(trunc(l, 150)) || " ";
    if (/^#{1,3} /.test(l)) return '<span class="pv-md-h">' + h + '</span>';
    if (/^_.*_$/.test(l) || /^\*\*[^*]+\*\* · Read /.test(l)) return '<span class="pv-md-q">' + h + '</span>';
    return h;
  }).join("\n") + '</div>';
}

function pvGrid(head: string[], rows: PreviewGridRow[], widths: number[]) {
  return '<table class="pv-table pv-grid"><colgroup>' + widths.map(function (w) { return '<col style="width:' + w + '%">'; }).join("") +
    '</colgroup><tr class="pv-gh">' + head.map(function (c) { return '<td>' + escapeHtml(c) + '</td>'; }).join("") + '</tr>' +
    rows.map(function (r) {
      return '<tr' + (r.cls ? ' class="' + r.cls + '"' : '') + '>' + r.cells.map(function (c) { return '<td>' + c + '</td>'; }).join("") + '</tr>';
    }).join("") + '</table>';
}

function pvShotList(title: string, doc: ExportDocument) {
  const groups = exportBrollBeats(doc);
  const rows: PreviewGridRow[] = [];
  groups.forEach(function (g) {
    g.items.forEach(function (r, i) {
      rows.push({ cells: [
        '<i class="pv-box' + (r.shot ? ' is-ticked' : '') + '"></i>',
        i ? "" : '<b>' + escapeHtml(g.beat) + '</b>',
        '<b' + (r.shot ? ' class="pv-faint"' : '') + '>' + escapeHtml(trunc(r.name, 34)) + '</b>',
        escapeHtml(trunc(r.location, 14)),
        escapeHtml(trunc((r.props || []).join(", "), 18)),
        r.flagged ? '<b class="pv-flag">Flagged</b>' : "",
        '<i class="pv-write"></i>'
      ] });
    });
  });
  return '<div class="pv-eyebrow">B-roll shot list</div><div class="pv-title">' + title + '</div>' +
    '<div class="pv-meta">' + escapeHtml((ports as FileMenuExportPorts).preview.shotSummary(doc)) + ' · by beat · ' + escapeHtml(exportFacts(doc).date) + '</div>' +
    pvGrid(["Done", "Beat", "B-roll shot", "Location", "Props", "Flagged", "Notes"], rows.slice(0, 12), [6, 7, 30, 13, 16, 10, 18]) +
    pvFooter(title, "B-roll shot list");
}

function xlsxSheetNames(doc: ExportDocument) {
  const names = ["Script"];
  if ((ports as FileMenuExportPorts).preview.commentCount(doc)) names.push("Comments");
  if (breakdownRows(doc).length) names.push("Breakdown");
  if (exportBrollBeats(doc).length) names.push("B-roll");
  return names;
}

function pvWorkbook(grid: string, sheets: string[]) {
  return '<div class="pv-xl">' + grid + '</div>' +
    '<div class="pv-sheets">' + sheets.map(function (s, i) {
      return '<span class="pv-sheet' + (i ? '' : ' is-on') + '">' + escapeHtml(s) + '</span>';
    }).join("") + '</div>';
}

function previewHtml(action: string | null | undefined) {
  const title = escapeHtml((currentDocument() as DocumentView).title || "Untitled Script");
  const rows = (currentDocument() as DocumentView).rows.slice(0, 7);
  const doc = captureExportDocument();
  if (action === "export-broll-pdf") return pvShotList(title, doc);
  if (action === "export-broll-csv" || action === "export-broll-xlsx") {
    const shots: PreviewGridRow[] = [];
    exportBrollBeats(doc).forEach(function (g) {
      g.items.forEach(function (r) {
        shots.push({ cells: [escapeHtml(g.beat), escapeHtml(trunc(r.name, 24)), r.shot ? "Filmed" : "To film",
                             r.flagged ? "yes" : "", escapeHtml(trunc(r.location, 12)), escapeHtml(g.start)] });
      });
    });
    const shotGrid = pvGrid(["Beat", "Shot", "Status", "Flagged", "Location", "Beat start"], shots.slice(0, 14), [11, 33, 15, 13, 16, 12]);
    return action === "export-broll-xlsx" ? pvWorkbook(shotGrid, ["B-roll"]) : shotGrid;
  }
  if (action === "export-pdf") return pvScript(title, { rundown: true }, doc) + pvFooter(title);
  if (action === "export-docx") return pvScript(title, { word: true }, doc) + pvFooter(title);
  if (action === "export-md") return pvTextLines((ports as FileMenuExportPorts).preview.markdown(doc), 40);
  if (action === "export-md-table") return pvTextLines((ports as FileMenuExportPorts).preview.markdownTable(doc), 20);
  if (action === "export-csv" || action === "export-xlsx") {
    const beats = beatFacts(doc);
    const sheetHead = ["Beat", "Start", "Status", "Read", "Visual", "Audio"];
    const sheetRows = rows.slice(0, 5).map<PreviewGridRow>(function (r, i) {
      const f = beats[i] as typeof beats[number];
      return { cells: [f.number, f.start, escapeHtml(f.status.label), f.read,
                       cellText(r.visualText, 34), cellText(r.audioText, 44)] };
    }).concat(rows.length ? [
      { cls: "pv-gap", cells: ["…", "", "", "", "", ""] },
      { cls: "pv-total", cells: ["Total", "", escapeHtml(exportFacts(doc).status.shot + " of " + (currentDocument() as DocumentView).rows.length + " filmed"),
                                 escapeHtml(exportFacts(doc).runtime), "", ""] }
    ] : []);
    if (action === "export-csv") return pvGrid(sheetHead, sheetRows, [12, 12, 14, 10, 25, 27]);
    return pvWorkbook(pvGrid(sheetHead.concat(["Notes"]), sheetRows.map(function (r) {
      return { cls: r.cls, cells: r.cells.concat([""]) };
    }), [12, 12, 14, 10, 18, 20, 14]), xlsxSheetNames(doc));
  }
  if (action === "export-html") {
    return '<div class="pv-app"><div class="pv-tabbar"><span class="pv-tab">' + title + ' — SplitShare</span></div>' +
      '<div class="pv-app-bar">Splitpage <span>' + title + '</span></div>' +
      '<div class="pv-app-page">' + pvScript(title, { app: true, rundown: true }, doc) + '</div></div>';
  }
  if (action === "export-narration-docx" || action === "export-narration-txt") {
    const spoken = narrationRows(doc, exportOptionsFor(action));
    const paras = spoken.slice(0, 8);
    const txt = action === "export-narration-txt";
    const said = exportOptionsFor(action).directions ? { cues: "omit" } : { directions: "omit", cues: "omit" };
    const numbers = beatFacts(doc);
    const words = String(exportFacts(doc).words).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (txt ? '<div class="pv-mono pv-md-h">' + title + '</div><br>'
      : '<div class="pv-title">' + title + '</div><div class="pv-meta">Narration · ' +
        escapeHtml(plural(spoken.length, "beat") + " · " + words + " words") + '</div>') +
      '<div class="' + (txt ? 'pv-mono' : 'pv-narr') + '">' +
      (paras.length ? paras.map(function (r) {
        const n = txt ? "" : '<span class="pv-margin">' + (numbers[doc.beats.indexOf(r)] as typeof numbers[number]).number + '</span>';
        return '<p class="pv-para">' + n + cellText(r.audioText, 180, said) + '</p>';
      }).join("") : '<p class="pv-para">(no narration yet)</p>') + '</div>';
  }
  if (action === "export-breakdown" || action === "export-breakdown-xlsx") {
    const starts = new Map(beatFacts(doc).map(f => [f.number, f.start]));
    const items = breakdownRows(doc).slice(0, 14);
    const itemGrid = pvGrid(["Category", "Item", "Status", "Beats", "First at"], items.map(function (b) {
      const first = b.inScript === "no" ? "" : (starts.get(b.beats[0] ?? "") ?? "");
      return { cells: [escapeHtml(b.categoryLabel), escapeHtml(trunc(b.name, 24)), escapeHtml(b.statusLabel),
                       escapeHtml(trunc(b.beats.join(" "), 14)), first] };
    }), [17, 29, 17, 21, 16]) + (items.length ? "" : '<p class="pv-para pv-faint">(nothing tagged yet)</p>');
    return action === "export-breakdown-xlsx" ? pvWorkbook(itemGrid, ["Breakdown"]) : itemGrid;
  }
  if (action === "export-packing-gear" || action === "export-packing-prop") {
    const catId = action === "export-packing-gear" ? "gear" : "prop";
    const cat = tagCategory(catId);
    const color = (ports as FileMenuExportPorts).preview.tagColor(catId);
    const heading = cat ? cat.plural : catId;
    const all = breakdownRows(doc).filter(function (b) { return b.catId === catId; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    const list = all.slice(0, 12);
    return '<div class="pv-eyebrow">Packing list</div>' +
      '<div class="pv-pack-head"><i class="pv-dot" style="--pv-c:#' + (color || "171613") + '"></i>' +
        escapeHtml(heading) + '</div>' +
      '<div class="pv-meta">' + title + ' · ' + escapeHtml(exportFacts(doc).date) +
        (all.length ? '<br>' + escapeHtml(packingSummary(all)) : '') + '</div>' +
      (list.length
        ? '<div class="pv-pill-legend">Status ' + pvPill(null) + '<span class="pv-faint">Needed · Sourcing · Have it · Returned</span></div>' +
          '<div class="pv-pack"><div class="pv-pack-row pv-pack-h"><span>Out</span><span>Back</span><span>Item</span><span>Status</span>' +
            '<span>Owner</span><span>Beats</span></div>' +
          list.map(function (b) {
            return '<div class="pv-pack-row"><i class="pv-box"></i><i class="pv-box"></i>' +
              '<span class="pv-pack-item"><b>' + escapeHtml(trunc(b.name, 30)) + '</b>' +
                (b.notes ? '<span class="pv-faint">' + escapeHtml(trunc(b.notes, 44)) + '</span>' : '') + '</span>' +
              '<span>' + pvPill(b.status) + '</span>' +
              '<span>' + escapeHtml(trunc(b.owner, 12)) + '</span>' +
              '<span>' + escapeHtml(b.beats.join(", ")) + '</span></div>';
          }).join("") + '</div>' +
          '<div class="pv-sign"><span>Packed by</span><i></i><span>Date</span><i></i>' +
            '<span>Returned by</span><i></i><span>Date</span><i></i></div>'
        : '<p class="pv-para">(nothing tagged yet)</p>') +
      pvFooter(title, heading + " packing list");
  }
  return "";
}

function packingSummary(items: ReturnType<FileMenuExportPorts["preview"]["breakdown"]>) {
  const n: Record<string, number | undefined> = {};
  const label: Record<string, string | undefined> = {};
  items.forEach(function (e) {
    n[e.status] = (n[e.status] || 0) + 1;
    label[e.status] = e.statusLabel.toLowerCase();
  });
  const out = [plural(items.length, "item")];
  ["have", "sourcing", "needed", "returned"].forEach(function (id) {
    if (n[id]) out.push(n[id] + " " + label[id]);
  });
  return out.join(" · ");
}

function plural(n: number, one: string, many?: string) { return n + " " + (n === 1 ? one : (many || one + "s")); }

function listed(parts: string[]) {
  return parts.length < 2 ? parts.join("") : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

function tailSummary(doc: ExportDocument) {
  const parts = [];
  if (breakdownRows(doc).length) parts.push("breakdown");
  if (exportBrollBeats(doc).length) parts.push("b-roll shot list");
  const comments = (currentDocument() as DocumentView).comments || [];
  if (comments.length) parts.push(comments.some(function (c) { return !c.resolved; }) ? "numbered comments" : "comments");
  return parts.length ? listed(parts) + " at the end" : "";
}

function exportSummary(action: string | null | undefined) {
  const f = formatForAction(action);
  if (!f || !currentDocument()) return "";
  const rows = (currentDocument() as DocumentView).rows;
  const doc = captureExportDocument();
  const bits = [];
  if (f.format.group === "whole") {
    const pics = rows.filter(function (r) { return !!rowImage(r); }).length;
    if (action === "export-csv") {
      bits.push(plural(rows.length, "beat") + (rows.length ? ", with start and read times, tags and b-roll" : ""));
      if (((currentDocument() as DocumentView).comments || []).length) bits.push("comments below");
    } else if (action === "export-xlsx") {
      bits.push(plural(rows.length, "beat") + (rows.length ? ", with start and read times, tags and b-roll" : ""));
      const more = xlsxSheetNames(doc).slice(1).map(function (s) { return s.toLowerCase(); });
      if (more.length) bits.push((more.length === 1 ? "a sheet for " : "sheets for ") + listed(more));
      bits.push("a Notes column to write in");
      bits.push("columns sized, header frozen, filters on");
    } else if (action === "export-html") {
      bits.push(plural(rows.length, "beat"));
    } else {
      bits.push(plural(rows.length, "beat") + (rows.length ? " with timecodes, status and read times" : ""));
    }
    if (!f.format.pictures) bits.push("pictures not included");
    else if (pics) bits.push(plural(pics, "picture") + (action === "export-md" ? " in a zip beside it" : " included"));
    if (f.format.extras) {
      const tail = tailSummary(doc);
      if (tail) bits.push(tail);
    }
    if (action === "export-html") bits.push("the whole app built in — read, edit and present it in any browser, on any device");
  } else if (f.format.id === "narration") {
    bits.push(plural(narrationRows(doc, exportOptionsFor(action)).length, "beat") + " of narration");
    if (action === "export-narration-docx") bits.push("beat numbers in the margin");
    bits.push(exportOptionsFor(action).directions ? "no visuals, breakdown or comments"
      : "no visuals, stage directions, breakdown or comments");
  } else if (f.format.id === "breakdown") {
    bits.push(plural(breakdownRows(doc).length, "tagged item"));
    bits.push("category, status, owner, beats and where each first appears");
    if (action === "export-breakdown-xlsx") bits.push("columns sized, header frozen, filters on");
  } else if (f.format.id === "packing") {
    const catId = action === "export-packing-gear" ? "gear" : "prop";
    const items = breakdownRows(doc).filter(function (b) { return b.catId === catId; });
    bits.push(plural(items.length, "item") + " to pack");
    const missing = items.filter(function (b) { return b.status === "needed" || b.status === "sourcing"; }).length;
    if (missing) bits.push(missing + " not in hand yet");
  } else if (f.format.id === "broll") {
    const shotGroups = exportBrollBeats(doc);
    const shotCount = shotGroups.reduce(function (n, g) { return n + g.items.length; }, 0);
    bits.push(plural(shotCount, "shot") + ", by beat");
    if (shotCount) bits.push((ports as FileMenuExportPorts).preview.shotSummary(doc));
    bits.push(action === "export-broll-pdf" ? "props, flags and their reasons, and room for notes"
      : "a row a shot: status, flag, location, props, who, notes");
    if (action === "export-broll-xlsx") bits.push("columns sized, header frozen, filters on");
  }
  return bits.join(" · ");
}

function exportFileNameFor(action: string | null | undefined) {
  const exporter = exportFormats.byAction(action);
  if (!exporter || !currentDocument()) return "";
  const bundle = !!exporter.bundlesPictures && (currentDocument() as DocumentView).rows.some(function (r) { return !!rowImage(r); });
  return (ports as FileMenuExportPorts).fileName(exporter.id, { imageBundle: bundle });
}

function renderSide() {
  const action = chosenAction();
  if (!action) return;
  (el("export-preview") as HTMLElement).innerHTML = previewHtml(action);
  (el("export-preview") as HTMLElement).classList.toggle("is-landscape", action === "export-broll-pdf");
  (el("export-summary") as HTMLElement).textContent = exportSummary(action);
  const fileLabel = ((el("export-filename") as HTMLElement).parentElement as HTMLElement).querySelector(".export-field-label");
  if (fileLabel) fileLabel.textContent = (ports as FileMenuExportPorts).printWorkflow(action) ? "Next step" : "File name";
  (el("export-filename") as HTMLElement).textContent = (ports as FileMenuExportPorts).printWorkflow(action) ? "Print dialog · choose Save as PDF" : exportFileNameFor(action);
  const why = exportActionReason(action);
  const whyEl = el("export-why") as HTMLElement;
  whyEl.textContent = why;
  whyEl.hidden = !why;
  const go = el("export-go") as HTMLButtonElement;
  go.textContent = ((ports as FileMenuExportPorts).printWorkflow(action) ? "Print " : "Export ") + exportActionName(action);
  go.disabled = !!why;
  go.setAttribute("data-export-action", action);
  exportFormatList().forEach(function (f) {
    const card = document.querySelector('.export-card[data-format="' + f.id + '"]');
    if (!card) return;
    const actions = f.choices ? f.choices.map(function (c) { return c.action; }) : [f.action];
    const reasons = actions.map(exportActionReason);
    const none = reasons.every(Boolean);
    card.classList.toggle("is-unavailable", none);
    (card.querySelector(".export-card-purpose") as HTMLElement).textContent = (none ? reasons[0] : f.purpose) as string;
  });
}

function choose(formatId: string | null, focus: boolean) {
  const formats = exportFormatList();
  const f = formats.filter(function (x) { return x.id === formatId; })[0] || formats[0];
  if (!f) return;
  chosenFormat = f;
  const radio = document.querySelector<HTMLInputElement>('#export-formats input[value="' + f.id + '"]');
  if (radio) {
    radio.checked = true;
    if (focus) radio.focus();
  }
  renderOptions();
  renderSide();
}

export function exportDialogOpen() {
  const m = el("export-modal");
  return !!m && !m.hidden;
}

export function openExportDialog(opts?: Parameters<FileMenuExportMount["openExportDialog"]>[0]) {
  opts = opts || {};
  if (!currentDocument()) { showToast("Still loading…", "warn"); return false; }
  const modal = el("export-modal");
  if (!modal || !modal.hidden) return false;
  buildCards();
  returnFocusTo = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const pick = formatForAction(opts.action || lastExportAction() || "export-pdf");
  if (pick && pick.choice) chosenChoice[pick.format.id] = pick.choice.value;
  modal.hidden = false;
  choose(pick ? pick.format.id : "pdf", true);
  return true;
}

function closeExportDialog() {
  const modal = el("export-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  const back = returnFocusTo;
  returnFocusTo = null;
  if (back && document.contains(back) && typeof (back as HTMLElement).focus === "function") (back as HTMLElement).focus();
}

function exportChosen() {
  const action = chosenAction();
  if (!action || exportActionReason(action)) return;
  closeExportDialog();
  runExportAction(action);
}

function exportAgain() {
  const action = lastExportAction();
  if (!action) { openExportDialog(); return; }
  const why = exportActionReason(action);
  if (why) { showToast(why + ".", "warn"); return; }
  runExportAction(action);
}

export function exportAgainItemState() {
  const action = lastExportAction();
  if (!action) return { hidden: true, disabled: false, reason: "", label: "" };
  const why = exportActionReason(action);
  return { hidden: false, disabled: !!why, reason: why, label: "Export again as " + exportActionName(action) };
}

function refreshExportAgainItem() {
  const item = el("menu-export-again");
  if (!item) return;
  const state = exportAgainItemState();
  item.hidden = state.hidden;
  if (state.hidden) return;
  (ports as FileMenuExportPorts).menuItems.setLabel(item, state.label);
  (item as HTMLButtonElement).disabled = state.disabled;
  (ports as FileMenuExportPorts).menuItems.setReason(item, state.reason);
}

function trapTab(e: KeyboardEvent) {
  const modal = el("export-modal");
  const focusables = Array.prototype.filter.call(
    (modal as HTMLElement).querySelectorAll('button, input[type="radio"]:checked, input[type="checkbox"], [tabindex]:not([tabindex="-1"])'),
    function (x: HTMLElement & Partial<Pick<HTMLButtonElement, "disabled">>) { return !x.disabled && x.getClientRects().length > 0; }) as HTMLElement[];
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); (last as HTMLElement).focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); (first as HTMLElement).focus(); }
}

function syncExportMenu() {
  const host = document.querySelector("#file-menu .menu-hidden-actions");
  if (!host) return;
  host.innerHTML = exportFormats.exporters().map(function (e) {
    return '<button type="button" data-file-action="' + escapeHtml(e.action) + '">' + escapeHtml(e.menuLabel) + '</button>';
  }).join("");
}

function refreshExportDialog() {
  const host = el("export-formats");
  if (host) host.removeAttribute("data-built");
  if (!exportDialogOpen()) return;
  const keep = chosenFormat ? chosenFormat.id : null;
  buildCards();
  choose(keep, false);
}

export function startExportDialog(given: FileMenuExportPorts): FileMenuExportMount {
  ports = given;
  chosenFormat = null;
  chosenChoice = {};
  returnFocusTo = null;
  const life = createViewLifetime(window);
  const controls: FileMenuExportMount = {
    captureExportDocument, exportFormatList, exportActionName, isExportAction, lastExportAction, rememberExport,
    exportActionReason, exportSummary, exportFileNameFor, exportDialogOpen, openExportDialog,
    closeExportDialog, exportAgain, exportAgainItemState,
    dispose: function () {
      if (!life.active()) return;
      life.dispose();
      closeExportDialog();
      const host = el("export-formats");
      if (host) host.removeAttribute("data-built");
      if (withdrawHook) withdrawHook();
      chosenFormat = null;
      chosenChoice = {};
      returnFocusTo = null;
      ports = null;
    }
  };
  let withdrawHook: (() => void) | null = null;
  const modal = el("export-modal");
  if (!modal) return controls;
  life.listen(modal, "change", function (e) {
    const t = e.target as HTMLInputElement;
    if (t.name === "export-format") choose(t.value, false);
    else if (t.name === "export-choice" && chosenFormat) {
      chosenChoice[chosenFormat.id] = t.value;
      renderSide();
    } else if (t.name === "export-toggle" && chosenFormat && chosenFormat.toggle) {
      chosenFormat.toggle.set(t.checked);
      renderSide();
    }
  });
  life.listen(modal, "keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeExportDialog(); }
    else if (e.key === "Tab") trapTab(e);
    else if (e.key === "Enter" && (e.target as Element).matches && (e.target as Element).matches('input[type="radio"]')) {
      e.preventDefault();
      exportChosen();
    }
  });
  life.listen(modal, "click", function (e) { if (e.target === modal) closeExportDialog(); });
  life.listen(el("export-close"), "click", closeExportDialog);
  life.listen(el("export-cancel"), "click", closeExportDialog);
  life.listen(el("export-go"), "click", exportChosen);
  life.release((ports as FileMenuExportPorts).onMenuRefresh(refreshExportAgainItem));
  syncExportMenu();
  life.release((ports as FileMenuExportPorts).exports.onChange(function () {
    syncExportMenu();
    refreshExportDialog();
  }));

  exposeTestHook("__exportTest", function () {
    return {
      formats: exportFormatList,
      name: exportActionName,
      last: lastExportAction,
      reason: exportActionReason,
      fileName: exportFileNameFor,
      chosen: chosenAction
    };
  }, function (withdraw) { withdrawHook = withdraw; });
  return controls;
}
