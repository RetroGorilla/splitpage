import { escapeHtml, safeHref } from "../../core/document/text-policy.ts";
import { base64Encode } from "../../core/document/media.ts";
import { sniffImageMime } from "../../../shared/blob-policy.js";
import type { ExportPicture } from "../../application/export/assets.ts";
import { PRINT_COLORS } from "./export-kit.ts";

export interface PrintSection {
  id: string;
  title: string;
  html: string;
}

export function printLink(label: string, href: unknown): string {
  const safe = safeHref(href);
  return safe ? `<a href="${escapeHtml(safe)}" rel="noreferrer noopener">${escapeHtml(label)}</a>` : escapeHtml(label);
}

export function printPicture(picture: ExportPicture | null, alt: string): string {
  const mime: unknown = picture && sniffImageMime(picture.bytes);
  if (!picture || (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp" && mime !== "image/gif")) {
    return '<span class="image-unavailable">[image unavailable]</span>';
  }
  return `<img src="data:${mime};base64,${base64Encode(picture.bytes)}" alt="${escapeHtml(alt)}">`;
}

function cssText(text: string): string {
  return Array.from(text, (char) => "\\" + char.codePointAt(0)?.toString(16) + " ").join("");
}

export function buildPrintPage(title: string, sections: readonly PrintSection[]): string {
  const c = PRINT_COLORS;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>
@page { size: letter; margin: 0.6in;
  @bottom-left { content: "${cssText(title)}"; font: 8pt sans-serif; color: #${c.faint}; max-width: 65%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt sans-serif; color: #${c.faint}; }
}
* { box-sizing: border-box; }
html { color: #${c.text}; background: white; font: 10pt/1.4 system-ui, sans-serif; }
body { margin: 0; }
main { max-width: 7.3in; margin: auto; }
h1 { font-size: 22pt; margin: 0 0 8pt; }
h2 { font-size: 16pt; margin: 0 0 8pt; }
h1, h2, h3, thead { break-after: avoid; }
p { margin: 0 0 8pt; }
section + section { break-before: page; }
section, article, td, p { overflow-wrap: anywhere; }
table { border-collapse: collapse; table-layout: fixed; width: 100%; }
thead { display: table-header-group; }
th { text-align: start; color: #${c.dim}; font-size: 8pt; }
th, td { vertical-align: top; padding: 8pt 5pt; border-bottom: 0.5pt solid #${c.border}; }
img { display: block; max-width: 100%; max-height: 6in; width: auto; height: auto; object-fit: contain; break-inside: avoid; margin: 0 0 6pt; }
a { color: #${c.visual}; text-decoration: underline; }
.print-meta, .image-unavailable { color: #${c.faint}; }
.print-text { white-space: pre-wrap; }
.scene-number { font-size: 12pt; }
.scene-meta { display: block; font-size: 7pt; color: #${c.dim}; }
.read-set { border: 0.5pt solid #${c.borderStrong}; border-radius: 2pt; padding: 2pt; }
.visual-head { color: #${c.visual}; }
.audio-head, .comment-marker { color: #${c.audio}; }
.rundown { display: flex; gap: 1pt; margin: 8pt 0; }
.rundown span { min-width: 0; background: #${c.surface2}; overflow-wrap: anywhere; font-size: 7pt; padding: 2pt; }
.rundown .shot { background: #${c.dim}; color: white; }
.rundown .ready { background: #${c.audioSoft}; color: #${c.audio}; }
.direction { color: #${c.faint}; }
.cue { color: #AB413E; font-size: 85%; }
.tag { text-decoration: underline; }
.broll { color: #${c.broll}; border: 0.5pt solid; border-radius: 2pt; padding: 0 2pt; font-size: 85%; }
.comment-anchor { text-decoration: underline dotted #${c.audio}; text-underline-offset: 3pt; }
.comment-marker { font-size: 7pt; vertical-align: super; }
.comment { margin: 12pt 0; }
.comment h3 { font-size: 10pt; margin-bottom: 3pt; }
.comment blockquote { margin: 4pt 12pt; color: #${c.dim}; }
.reply { margin: 8pt 0 8pt 14pt; }
.comment img { max-width: 60%; max-height: 3.6in; }
@media screen { body { padding: 24px; } }
@media print { html { print-color-adjust: exact; -webkit-print-color-adjust: exact; } main { max-width: none; } }
</style></head><body><main>${sections.map((section) =>
    `<section id="${escapeHtml(section.id)}" aria-label="${escapeHtml(section.title)}">${section.html}</section>`).join("")}</main></body></html>`;
}
