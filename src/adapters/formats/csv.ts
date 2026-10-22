import type { ExportServices } from "../../application/export/services.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import type { DocumentRow } from "../../core/document/validated.ts";
import type { TableCell } from "./export-projections.ts";
import { sceneFacts, breakdownRows, breakdownTable, brollTable, commentBodyText } from "./export-projections.ts";
import { exportBrollScenes, exportComments, exportFacts } from "./export-kit.ts";
import { makeId } from "../identity/ids.ts";
import { exportServices } from "../../application/export/services.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { toPlainText } from "../../core/text/projections.ts";

export interface ScriptTable {
  head: string[];
  scenes: { status: string; cells: TableCell[] }[];
  summary: TableCell[][];
  commentHead: string[];
  comments: { reply: boolean; resolved: boolean; cells: TableCell[] }[];
}

export function csvEscape(v: unknown): string {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function buildBreakdownCsv(doc: ExportDocument, services: ExportServices = exportServices()): string {
  const t = breakdownTable(doc, services);
  const lines = [t.head.join(",")];
  t.rows.forEach(function (r) { lines.push(r.cells.map(csvEscape).join(",")); });
  if (lines.length === 1) lines.push(csvEscape("(nothing labelled yet)"));
  return "﻿" + lines.join("\r\n");
}

export function buildBrollCsv(doc: ExportDocument, services: ExportServices = exportServices()): string {
  const t = brollTable(doc, services);
  const lines = [t.head.join(",")];
  t.rows.forEach(function (r) { lines.push(r.cells.map(csvEscape).join(",")); });
  if (lines.length === 1) lines.push(csvEscape("(no b-roll yet)"));
  return "﻿" + lines.join("\r\n");
}

const CSV_HEAD = ["Scene", "Start", "Status", "Read", "Read set by hand", "Visual", "Audio", "Tags", "B-roll", "Open comments"];

function sceneTagLists(doc: ExportDocument): Record<string, string[]> {
  const byScene: Record<string, { label: string; names: string[] }[]> = {};
  breakdownRows(doc).forEach(function (r) {
    if (r.inScript === "no") return;
    r.scenes.forEach(function (n) {
      const i = Number(n) - 1;
      const list = byScene[i] = byScene[i] || [];
      const last = list[list.length - 1];
      if (last && last.label === r.categoryLabel) last.names.push(r.name);
      else list.push({ label: r.categoryLabel, names: [r.name] });
    });
  });
  const out: Record<string, string[]> = {};
  Object.entries(byScene).forEach(function ([i, groups]) {
    out[i] = groups.map(function (g) { return g.label + ": " + g.names.join(", "); });
  });
  return out;
}

function sceneBrollLists(doc: ExportDocument, services: ExportServices): Record<number, string[]> {
  const byScene: Record<number, string[]> = {};
  exportBrollScenes(doc, services).forEach(function (g) {
    if (!g.scene) return;
    byScene[Number(g.scene) - 1] = g.items.map(function (r) {
      return r.name + " (" + (r.shot ? "shot" : "to shoot") + (r.flagged ? ", flagged" : "") + ")";
    });
  });
  return byScene;
}

export const COMMENT_HEAD = ["No.", "Location", "Status", "Assigned to", "Author", "Date", "Quoted text", "Comment"];

export function scriptTable(doc: ExportDocument, services: ExportServices = exportServices()): ScriptTable {
  const facts = exportFacts(doc, services);
  const scenes = sceneFacts(doc, services);
  const tags = sceneTagLists(doc);
  const broll = sceneBrollLists(doc, services);
  const comments = exportComments(doc, { pieces: true }, services);
  const open: Record<number, number[]> = {};
  comments.forEach(function (c) {
    if (c.number && c.rowIndex >= 0) (open[c.rowIndex] = open[c.rowIndex] || []).push(c.number);
  });
  const blank = CSV_HEAD.map(function () { return ""; });
  function summary(label: string, status: string, read: string): TableCell[] {
    const cells = blank.slice();
    cells[0] = label;
    cells[2] = status;
    cells[3] = read;
    return cells;
  }

  const out: ScriptTable = { head: CSV_HEAD.slice(), scenes: [], summary: [], commentHead: COMMENT_HEAD.slice(), comments: [] };
  doc.scenes.forEach(function (row, i) {
    const f = scenes[i];
    if (!f) throw new Error("Missing scene facts");
    out.scenes.push({ status: f.status.id, cells: [
      f.number,
      f.start,
      f.status.label,
      f.read,
      f.readSet ? "yes" : "",
      toPlainText(services.cellOf(row.visualText)),
      toPlainText(services.cellOf(row.audioText)),
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

export function buildCsv(doc: ExportDocument, services: ExportServices = exportServices()): string {
  const t = scriptTable(doc, services);
  const line = function (cells: readonly TableCell[]) { return cells.map(csvEscape).join(","); };
  const lines = [t.head.join(",")];
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

function parseCsv(text: unknown): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "", inQuotes = false;
  const src = String(text || "").replace(/^\uFEFF/, "").split("").filter(function (ch) {
    const code = ch.charCodeAt(0);
    return code > 31 || code === 9 || code === 10 || code === 13;
  }).join("");
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
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

function looksLikeIndexColumn(table: readonly (readonly string[])[], from: number): boolean {
  let checked = 0;
  for (let i = from; i < table.length && checked < 8; i++) {
    const cell = (table[i]?.[0] || "").trim();
    if (!cell) continue;
    checked++;
    if (!/^[0-9]{1,4}[a-z]?$/i.test(cell)) return false;
  }
  return checked > 0;
}

export function csvToRows(text: unknown): DocumentRow[] {
  const table = parseCsv(text);
  const first = table[0];
  if (!first) return [];
  let vi: number, ai: number, start = 0;
  const head = first.map(function (c) { return c.trim().toLowerCase(); });
  const hv = head.findIndex(function (c) { return /^(visual|video|picture|image|shot|action)s?$/.test(c); });
  const ha = head.findIndex(function (c) { return /^(audio|voice|vo|narration|dialogue|script|line)s?\b/.test(c); });
  const looksLikeHeader = hv !== -1 || ha !== -1 ||
    head.some(function (c) { return /^(scene|shot|no\.?|#|number|index)$/.test(c); });

  if (hv !== -1 && ha !== -1) {
    vi = hv; ai = ha; start = 1;
  } else if (first.length >= 3 && looksLikeIndexColumn(table, looksLikeHeader ? 1 : 0)) {
    vi = 1; ai = 2;
  } else if (first.length === 2 && looksLikeIndexColumn(table, looksLikeHeader ? 1 : 0)) {
    vi = 1; ai = -1;
  } else {
    vi = 0; ai = 1;
  }
  if (looksLikeHeader && start === 0) start = 1;

  const ours = head[0] === "scene" && head.indexOf("status") !== -1 && hv !== -1 && ha !== -1;

  const out: DocumentRow[] = [];
  for (let i = start; i < table.length; i++) {
    const r = table[i];
    if (!r) throw new Error("Missing CSV row");
    if (ours && (r[0] || "").trim() === "Comments" && r.slice(1).every(function (c) { return !c.trim(); })) break;
    const v = (r[vi] || "").trim(), a = (r[ai] || "").trim();
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
