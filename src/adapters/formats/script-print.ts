import type { ExportAssets } from "../../application/export/assets.ts";
import type { ExportServices } from "../../application/export/services.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import { morePictureRefs, rowVideoLinks } from "../../core/document/gallery.ts";
import { decodeImageDataUrl, rowImage } from "../../core/document/media.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { videoLinkText } from "../storage/02d-gallery.js";
import type { CommentBody } from "./export-projections.ts";
import { sceneFacts } from "./export-projections.ts";
import { exportComments, exportFacts, exportRuns, exportSummaryParts } from "./export-kit.ts";
import type { PrintSection } from "./print-page.ts";
import { buildPrintPage, printLink, printPicture } from "./print-page.ts";
import { videoHostLabel } from "./video-host.ts";

export interface ScriptPrintInput {
  doc: ExportDocument;
  assets: ExportAssets;
  services: ExportServices;
}

function cellHtml(html: unknown, input: ScriptPrintInput): string {
  return exportRuns(html, input.doc.commentNumbers, input.services).map((run) => {
    let text = run.broll ? "B-roll" : run.text;
    text = run.href ? printLink(text, run.href) : escapeHtml(text);
    if (run.b) text = `<strong>${text}</strong>`;
    if (run.i) text = `<em>${text}</em>`;
    if (run.u) text = `<u>${text}</u>`;
    if (run.s) text = `<s>${text}</s>`;
    if (run.mark) text = `<mark>${text}</mark>`;
    if (run.tag) {
      const color = run.tag.color;
      const style = color && /^[0-9a-f]{6}$/i.test(color) ? ` style="color:#${color}"` : "";
      text = `<span class="tag"${style}>${text}</span>`;
    }
    const classes = [run.dir ? "direction" : "", run.cue ? "cue" : "", run.broll ? "broll" : "",
      run.cmt?.length ? "comment-anchor" : ""].filter(Boolean).join(" ");
    if (classes) text = `<span class="${classes}">${text}</span>`;
    return text + (run.markers || []).map((number) => `<sup class="comment-marker">${number}</sup>`).join("");
  }).join("");
}

function commentBody(entry: CommentBody, input: ScriptPrintInput): string {
  const pieces = entry.pieces || [];
  if (!pieces.some((piece) => piece.image)) return `<p class="print-text">${escapeHtml(entry.body || "(empty)")}</p>`;
  return pieces.map((piece) => piece.image
    ? printPicture(input.assets.picture(piece.image), "Comment picture")
    : `<p class="print-text">${escapeHtml(piece.text)}</p>`).join("");
}

export function scriptPrintSections(input: ScriptPrintInput): PrintSection[] {
  const { doc, assets, services } = input;
  const facts = exportFacts(doc, services);
  const scenes = sceneFacts(doc, services);
  const summary = exportSummaryParts(facts).concat(facts.date).join(" · ");
  const statusSummary = scenes.length ? `<p class="print-meta">Shot ${facts.status.shot} · Ready ${facts.status.ready} · To do ${facts.status.todo} · Grey rows: shot scenes</p>` : "";
  const rows = doc.scenes.map((row, index) => {
    const scene = scenes[index];
    if (!scene) throw new Error("Missing captured scene facts");
    const image = rowImage(row);
    const legacy = image?.dataUrl ? decodeImageDataUrl(image.dataUrl) : null;
    const picture = image?.ref ? assets.picture(image.ref.sha256) : legacy ? { bytes: legacy.bytes, mime: legacy.ref.mime } : null;
    const main = image ? printPicture(picture, "Scene " + scene.number + " picture") : "";
    const more = morePictureRefs(row).map((ref) => printPicture(assets.picture(ref.sha256), "Scene " + scene.number + " gallery picture")).join("");
    const links = rowVideoLinks(row).map((link) => `<p>${link.href ? escapeHtml(videoHostLabel(link)) + " " : ""}${printLink(String(videoLinkText(link)), link.href)}</p>`).join("");
    return `<tr${scene.status.id === "shot" ? ' class="shot-done"' : ""}><td><strong class="scene-number">${scene.number}</strong><span class="scene-meta">${escapeHtml(scene.start)}</span>
<span class="scene-meta">${escapeHtml(scene.status.label)}</span></td>
<td>${main}${more}${links}<div class="print-text">${cellHtml(row.visualText, input)}</div></td>
<td><div class="print-text">${cellHtml(row.audioText, input)}</div></td>
<td><span${scene.readSet ? ' class="read-set"' : ""}>${escapeHtml(scene.read)}</span></td></tr>`;
  }).join("");
  const script = `<h1>${escapeHtml(facts.title)}</h1><p class="print-meta">${escapeHtml(summary)}</p>${statusSummary}` +
    (rows ? `<table class="script-table"><colgroup><col style="width:10%"><col style="width:40%"><col style="width:40%"><col style="width:10%"></colgroup>
<thead><tr><th>Scene</th><th class="visual-head">Visual</th><th class="audio-head">Audio</th><th>Read</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No scenes yet.</p>");
  const sections: PrintSection[] = [{ id: "script", title: "Script", html: script }];
  const comments = exportComments(doc, { pieces: true }, services);
  if (comments.length) {
    const open = comments.filter((comment) => !comment.resolved).length;
    const html = `<h2>Comments</h2><p class="print-meta">${open} open · ${comments.length - open} resolved</p>` + comments.map((comment) => {
      const meta = [comment.author, comment.when];
      if (comment.assignee) meta.push("Assigned to " + comment.assignee);
      if (comment.resolved) meta.push("Resolved" + (comment.resolvedBy ? " by " + comment.resolvedBy : ""));
      return `<article class="comment"><h3>${comment.number ? `<span class="comment-marker">${comment.number}</span> ` : ""}${escapeHtml(comment.where)}</h3>
<p class="print-meta">${escapeHtml(meta.filter(Boolean).join(" · "))}</p>
${comment.quoted ? `<blockquote class="print-text">${escapeHtml(comment.quoted)}</blockquote>` : ""}${commentBody(comment, input)}
${comment.replies.map((reply) => `<div class="reply"><p class="print-meta">${escapeHtml([reply.author, reply.when].filter(Boolean).join(" · "))}</p>${commentBody(reply, input)}</div>`).join("")}</article>`;
    }).join("");
    sections.push({ id: "comments", title: "Comments", html });
  }
  return sections;
}

export function buildScriptPrintPage(input: ScriptPrintInput): string {
  return buildPrintPage(exportFacts(input.doc, input.services).title, scriptPrintSections(input));
}
