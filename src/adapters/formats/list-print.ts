import type { ExportServices } from "../../application/export/services.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { TAG_STATUSES, tagCategory } from "../../core/production/looks.ts";
import { breakdownGroups, exportDateText, exportDay } from "./export-kit.ts";
import { brollShotListForPrint } from "./export-projections.ts";
import type { BreakdownRow } from "./export-projections.ts";
import type { PrintSection } from "./print-page.ts";
import { buildPrintPage } from "./print-page.ts";
import { tagPrintColor } from "./print-colors.ts";
import type { ScriptPrintInput } from "./script-print.ts";
import { scriptPrintSections } from "./script-print.ts";

export interface ListPrintInput {
  doc: ExportDocument;
  services: ExportServices;
}

function itemSummary(items: readonly BreakdownRow[], order: readonly string[]): string {
  return [items.length + (items.length === 1 ? " item" : " items"), ...order.flatMap((id) => {
    const matches = items.filter((item) => item.status === id);
    return matches.length ? [matches.length + " " + matches[0]?.statusLabel.toLowerCase()] : [];
  })].join(" · ");
}

function categoryHeading(label: string, color: string | null): string {
  return `${color ? `<span class="category-dot" style="background:#${color}"></span>` : ""}${escapeHtml(label)}`;
}

function checkBox(label: string, checked = false): string {
  return `<span class="list-checkbox${checked ? " checked" : ""}" role="img" aria-label="${escapeHtml(label)}">${checked ? "✓" : ""}</span>`;
}

function packingStatus(item: BreakdownRow): string {
  const level = Math.max(0, TAG_STATUSES.findIndex((status) => status.id === item.status));
  return `<span class="packing-status ${item.status}" role="img" aria-label="${escapeHtml(item.statusLabel)}">${TAG_STATUSES.map((status, index) =>
    `<span class="${index <= level ? "filled" : ""}"></span>`).join("")}</span><span class="scene-meta">${escapeHtml(item.statusLabel)}</span>`;
}

function itemDetails(item: BreakdownRow): string {
  return `${item.notes ? `<div class="print-text list-detail">${escapeHtml(item.notes)}</div>` : ""}${item.broll.length
    ? `<div class="list-detail"><strong class="broll-label">B-roll:</strong> ${escapeHtml(item.broll.join(", "))}</div>` : ""}`;
}

export function packingPrintSection(input: ListPrintInput, catId: string): PrintSection {
  const cat = tagCategory(catId);
  const heading = cat?.plural || catId;
  const items = (breakdownGroups(input.doc).find((group) => group.catId === catId)?.items || []).slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const header = `<p class="print-meta">Packing list</p><h1>${categoryHeading(heading, cat ? tagPrintColor(cat.id) : null)}</h1>
<p>${escapeHtml(input.doc.title || "Untitled Script")} · ${escapeHtml(exportDateText(exportDay(input.doc)))}</p>`;
  const html = items.length ? `${header}<p class="print-meta">${escapeHtml(itemSummary(items, ["have", "sourcing", "needed", "returned"]))}</p>
<div class="packing-key"><span>Status</span>${TAG_STATUSES.map((status) => `<span>${escapeHtml(status.label)}</span>`).join("")}<em>Fill in each step as it happens</em></div>
<table class="packing-table"><colgroup><col style="width:5%"><col style="width:5%"><col style="width:38%"><col style="width:16%"><col style="width:21%"><col style="width:15%"></colgroup>
<thead><tr><th>Out</th><th>Back</th><th>Item</th><th>Status</th><th>Owner</th><th>Beats</th></tr></thead><tbody>${items.map((item) =>
    `<tr><td>${checkBox("Out")}</td><td>${checkBox("Back")}</td><td><strong>${escapeHtml(item.name)}</strong>${itemDetails(item)}</td>
<td>${packingStatus(item)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.inScript === "no" ? "Not in script" : item.beats.join(", "))}</td></tr>`).join("")}</tbody></table>
<div class="packing-signatures">${["Packed by", "Returned by"].map((label) => `<p>${label}<span class="signature-line"></span>Date<span class="signature-line"></span></p>`).join("")}</div>`
    : `${header}<p>Nothing tagged ${escapeHtml(cat?.label || catId)} yet.</p>`;
  return { id: "packing-" + catId, title: heading + " packing list", html };
}

export function buildPackingListPrintPage(input: ListPrintInput, catId: string): string {
  const section = packingPrintSection(input, catId);
  return buildPrintPage((input.doc.title || "Untitled Script") + " — " + section.title, [section]);
}

export function productionBreakdownPrintSection(input: ListPrintInput): PrintSection | null {
  const groups = breakdownGroups(input.doc);
  if (!groups.length) return null;
  const html = `<h2>Production breakdown</h2><p class="print-meta">${escapeHtml(itemSummary(groups.flatMap((group) => group.items), TAG_STATUSES.map((status) => status.id)))}</p>
<table class="breakdown-table"><colgroup><col style="width:38%"><col style="width:18%"><col style="width:22%"><col style="width:22%"></colgroup>
<thead><tr><th>Item</th><th>Status</th><th>Beats</th><th>Assigned to</th></tr></thead>${groups.map((group) =>
    `<tbody><tr class="list-group"><th colspan="4">${categoryHeading(group.label, group.color)} <span class="print-meta">${group.items.length}</span></th></tr>${group.items.map((item) =>
      `<tr><td>${escapeHtml(item.name)}${itemDetails(item)}</td><td><span class="status-mark ${item.status}" aria-hidden="true"></span>${escapeHtml(item.statusLabel)}</td>
<td>${escapeHtml(item.beats.join(", "))}</td><td>${escapeHtml(item.owner || "—")}</td></tr>`).join("")}</tbody>`).join("")}</table>`;
  return { id: "production-breakdown", title: "Production breakdown", html };
}

export function shotListPrintSection(input: ListPrintInput, options?: unknown, appendix = false): PrintSection {
  const data = brollShotListForPrint(input.doc, options, input.services);
  const heading = appendix ? "<h2>B-roll shot list</h2>" : `<p class="print-meta">B-roll shot list</p><h1>${escapeHtml(data.title)}</h1>`;
  const html = `${heading}<p class="print-meta">${escapeHtml(data.summary + " · " + data.scope)}${appendix ? "" : " · " + escapeHtml(exportDateText(exportDay(input.doc)))}</p>` +
    (data.groups.length ? `<table class="shot-table"><colgroup>${[4, 6, 27, 11, 14, 10, 12, 16].map((width) => `<col style="width:${width}%">`).join("")}</colgroup>
<thead><tr>${["Done", "Beat", "B-roll shot", "Location", "Props", "Assigned", "Flagged", "Notes"].map((label) => `<th>${label}</th>`).join("")}</tr></thead>${data.groups.map((group) =>
      `<tbody><tr class="list-group"><th colspan="8">${escapeHtml(group.label)} <span class="print-meta">${group.done}/${group.total} filmed</span></th></tr>${group.items.map((item) =>
        `<tr${item.shot ? ' class="shot-done"' : ""}><td>${checkBox(item.status, item.shot)}</td><td>${escapeHtml(item.beat)}<span class="scene-meta">${escapeHtml(item.start)}</span></td>
<td><strong>${escapeHtml(item.name)}</strong>${item.desc ? `<div class="print-text list-detail">${escapeHtml(item.desc)}</div>` : ""}${item.cuts ? `<div class="list-detail"><em>“${escapeHtml(item.cuts)}”</em></div>` : ""}</td>
<td>${escapeHtml(group.kind === "location" ? "" : item.location)}</td><td>${item.propsWithStatus.map((prop) => `<div>${escapeHtml(prop)}</div>`).join("")}</td>
<td>${escapeHtml(group.kind === "person" ? "" : item.owner)}</td><td>${item.flagged ? `<strong class="shot-flag">Flagged</strong>${item.note ? `<div class="print-text">${escapeHtml(item.note)}</div>` : ""}` : ""}</td>
<td>${!item.flagged ? `<div class="print-text">${escapeHtml(item.note)}</div>` : ""}<div class="writing-lines" aria-label="Notes space"><span></span><span></span></div></td></tr>`).join("")}</tbody>`).join("")}</table>` : "<p>No shots to list.</p>");
  return { id: "broll-shot-list", title: "B-roll shot list", html: `<div class="shot-list">${html}</div>` };
}

export function buildShotListPrintPage(input: ListPrintInput, options?: unknown): string {
  return buildPrintPage((input.doc.title || "Untitled Script") + " — B-roll shot list", [shotListPrintSection(input, options)]);
}

export function listPrintSections(input: ListPrintInput): PrintSection[] {
  const breakdown = productionBreakdownPrintSection(input);
  return [...(breakdown ? [breakdown] : []), ...(input.doc.broll.length ? [shotListPrintSection(input, { filter: "all", group: "scene" }, true)] : [])];
}

export function buildScriptWithListsPrintPage(input: ScriptPrintInput): string {
  const sections = scriptPrintSections(input);
  return buildPrintPage(input.doc.title || "Untitled Script", [...sections.slice(0, 1), ...listPrintSections(input), ...sections.slice(1)]);
}
