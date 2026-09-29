import { S } from "./_state.js";
import { escapeHtml, makeId } from "./02-state.js";
import { breakdownRows } from "./08-production-panels.js";
import { commentBodyText } from "./10-comments.js";
import { cellOf, toPlainText } from "./04c-doc-model.js";
import { exportBrollScenes, exportComments, exportFacts, sceneFacts } from "./14b-export-kit.js";

export function csvEscape(v) {
  var s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

var CSV_HEAD = ["Scene", "Start", "Status", "Read", "Read set by hand", "Visual", "Audio", "Tags", "B-roll", "Open comments"];

function sceneTagLists() {
  var byScene = Object.create(null);
  breakdownRows().forEach(function (r) {
    if (r.inScript === "no") return;
    r.scenes.forEach(function (n) {
      var i = Number(n) - 1;
      var list = byScene[i] = byScene[i] || [];
      var last = list[list.length - 1];
      if (last && last.label === r.categoryLabel) last.names.push(r.name);
      else list.push({ label: r.categoryLabel, names: [r.name] });
    });
  });
  Object.keys(byScene).forEach(function (i) {
    byScene[i] = byScene[i].map(function (g) { return g.label + ": " + g.names.join(", "); });
  });
  return byScene;
}

function sceneBrollLists() {
  var byScene = Object.create(null);
  exportBrollScenes().forEach(function (g) {
    if (!g.scene) return;
    byScene[Number(g.scene) - 1] = g.items.map(function (r) {
      return r.name + " (" + (r.shot ? "shot" : "to shoot") + (r.flagged ? ", flagged" : "") + ")";
    });
  });
  return byScene;
}

export var COMMENT_HEAD = ["No.", "Location", "Status", "Assigned to", "Author", "Date", "Quoted text", "Comment"];

export function scriptTable() {
  var facts = exportFacts();
  var scenes = sceneFacts();
  var tags = sceneTagLists();
  var broll = sceneBrollLists();
  var comments = exportComments({ pieces: true });
  var open = Object.create(null);
  comments.forEach(function (c) {
    if (c.number && c.rowIndex >= 0) (open[c.rowIndex] = open[c.rowIndex] || []).push(c.number);
  });
  var blank = CSV_HEAD.map(function () { return ""; });
  function summary(label, status, read) {
    var cells = blank.slice();
    cells[0] = label;
    cells[2] = status;
    cells[3] = read;
    return cells;
  }

  var out = { head: CSV_HEAD.slice(), scenes: [], summary: [], commentHead: COMMENT_HEAD.slice(), comments: [] };
  S.state.rows.forEach(function (row, i) {
    var f = scenes[i];
    out.scenes.push({ status: f.status.id, cells: [
      f.number,
      f.start,
      f.status.label,
      f.read,
      f.readSet ? "yes" : "",
      toPlainText(cellOf(row.visualText)),
      toPlainText(cellOf(row.audioText)),
      (tags[i] || []).join("; "),
      (broll[i] || []).join("; "),
      (open[i] || []).sort(function (a, b) { return a - b; }).join(", ")
    ] });
  });
  out.summary.push(summary("Total", facts.scenes ? facts.status.shot + " of " + facts.scenes + " shot" : "", facts.runtime));
  if (facts.target) {
    out.summary.push(summary("Target", facts.target.delta === "0:00" ? "on target"
      : facts.target.delta + (facts.target.over ? " over" : " under"), facts.target.text));
  }
  comments.forEach(function (c) {
    out.comments.push({ reply: false, resolved: !!c.resolved, cells: [
      c.number || "",
      c.where,
      c.resolved ? "Resolved" + (c.resolvedBy ? " by " + c.resolvedBy : "") : "Open",
      c.assignee,
      c.author,
      c.when,
      c.quoted,
      commentBodyText(c)
    ] });
    c.replies.forEach(function (rp) {
      out.comments.push({ reply: true, resolved: !!c.resolved, cells: ["", "", "", "", "↳ " + rp.author, rp.when, "", commentBodyText(rp)] });
    });
  });
  return out;
}

export function buildCsv() {
  var t = scriptTable();
  var line = function (cells) { return cells.map(csvEscape).join(","); };
  var lines = [t.head.join(",")];
  t.scenes.forEach(function (s) { lines.push(line(s.cells)); });
  t.summary.forEach(function (cells) { lines.push(line(cells)); });
  if (t.comments.length) {
    lines.push("");
    lines.push(csvEscape("Comments"));
    lines.push(t.commentHead.join(","));
    t.comments.forEach(function (c) { lines.push(line(c.cells)); });
  }
  return "﻿" + lines.join("\r\n");
}

function parseCsv(text) {
  var rows = [], row = [], field = "", inQuotes = false;
  /* eslint-disable-next-line no-control-regex -- C0 controls are what a CSV
     field must not carry into a row. */
  var src = String(text || "").replace(/^\uFEFF/, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  for (var i = 0; i < src.length; i++) {
    var ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (c) { return c.trim(); }); });
}

function looksLikeIndexColumn(table, from) {
  var checked = 0;
  for (var i = from; i < table.length && checked < 8; i++) {
    var cell = (table[i][0] || "").trim();
    if (!cell) continue;
    checked++;
    if (!/^[0-9]{1,4}[a-z]?$/i.test(cell)) return false;
  }
  return checked > 0;
}

export function csvToRows(text) {
  var table = parseCsv(text);
  if (!table.length) return [];
  var vi, ai, start = 0;
  var head = table[0].map(function (c) { return c.trim().toLowerCase(); });
  var hv = head.findIndex(function (c) { return /^(visual|video|picture|image|shot|action)s?$/.test(c); });
  var ha = head.findIndex(function (c) { return /^(audio|voice|vo|narration|dialogue|script|line)s?\b/.test(c); });
  var looksLikeHeader = hv !== -1 || ha !== -1 ||
    head.some(function (c) { return /^(scene|shot|no\.?|#|number|index)$/.test(c); });

  if (hv !== -1 && ha !== -1) {
    vi = hv; ai = ha; start = 1;
  } else if (table[0].length >= 3 && looksLikeIndexColumn(table, looksLikeHeader ? 1 : 0)) {
    vi = 1; ai = 2;
  } else if (table[0].length === 2 && looksLikeIndexColumn(table, looksLikeHeader ? 1 : 0)) {
    vi = 1; ai = -1;
  } else {
    vi = 0; ai = 1;
  }
  if (looksLikeHeader && start === 0) start = 1;

  var ours = head[0] === "scene" && head.indexOf("status") !== -1 && hv !== -1 && ha !== -1;

  var out = [];
  for (var i = start; i < table.length; i++) {
    var r = table[i];
    if (ours && (r[0] || "").trim() === "Comments" && r.slice(1).every(function (c) { return !c.trim(); })) break;
    var v = (r[vi] || "").trim(), a = (r[ai] || "").trim();
    if (!v && !a) continue;
    out.push({
      id: makeId(),
      visualText: escapeHtml(v).replace(/\n/g, "<br>"),
      imageRef: null,
      audioText: escapeHtml(a).replace(/\n/g, "<br>")
    });
  }
  return out;
}

export function __init() {}
