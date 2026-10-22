import type { ExportServices } from "../../application/export/services.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import type { DocumentRow } from "../../core/document/validated.ts";
import type { Frozen } from "../../core/document/freeze.ts";
import type { ExportAssets } from "../../application/export/assets.ts";
import type { Marks, Run } from "../../core/text/runs.ts";
import type { ExportFacts } from "./export-kit.ts";
import type { SceneFacts, ShotRecord } from "./export-projections.ts";
import { capturedPicture, capturedRowPicture, exportAssetsNow } from "./export-assets.ts";
import { rowImageDataUrl } from "../storage/02c-blobs.js";
import { rowImage, rowImageKey } from "../../core/document/media.ts";
import { morePictureRefs, rowVideoLinks, videoLinkLabel, videoLinkText } from "../storage/02d-gallery.js";
import {
  breakdownGroups,
  brollSummaryText,
  exportBrollScenes,
  exportComments,
  exportFacts,
  exportSummaryParts
} from "./export-kit.ts";
import { sceneFacts, breakdownRows, commentBodyText, commentEntries } from "./export-projections.ts";
import { exportServices } from "../../application/export/services.ts";
import { base64Encode } from "../../core/document/media.ts";
import { pad2 } from "../../core/production/timing.ts";
import { toMarkdown, toPlainText } from "../../core/text/projections.ts";

type Row = Frozen<DocumentRow>;
export interface MarkdownOptions {
  scenes?: number | undefined;
  assets?: ExportAssets | null | undefined;
  export?: boolean | undefined;
}

function mdCell(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, " ");
}

function appendMarkdownTail(lines: string[], doc: ExportDocument, opts: MarkdownOptions | null | undefined, services: ExportServices): void {
  if (opts && opts.export) { appendExportTail(lines, doc, services); return; }
  const breakdown = breakdownRows(doc);
  if (breakdown.length) {
    lines.push("## Production breakdown");
    lines.push("");
    lines.push("| Category | Item | Status | Assigned to | Mentions | Scenes | Notes |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    breakdown.forEach(function (r) {
      lines.push("| " + [r.categoryLabel, r.name, r.statusLabel, r.owner, r.mentions,
                         r.scenes.join(", "), r.notes].map(mdCell).join(" | ") + " |");
    });
    lines.push("");
  }

  const comments = commentEntries(doc, { pieces: true, clockMode: doc.clockMode }, services);
  if (comments.length) {
    lines.push("## Comments");
    lines.push("");
    comments.forEach(function (c) {
      lines.push("**" + c.location + "**" +
                 (c.resolved ? " _(resolved" + (c.resolvedBy ? " by " + c.resolvedBy : "") + ")_" : "") +
                 (c.assignee ? " _(assigned to " + c.assignee + ")_" : "") +
                 " — " + c.author + (c.when ? " · " + c.when : ""));
      lines.push("");
      if (c.quoted) {
        lines.push("> " + c.quoted.split(/\r\n|\r|\n/).join("  \n> "));
        lines.push("");
      }
      lines.push((commentBodyText(c) || "_(empty)_").split(/\r\n|\r|\n/).join("  \n"));
      c.replies.forEach(function (rp) {
        lines.push("");
        lines.push("> ↳ **" + rp.author + "**" + (rp.when ? " · " + rp.when : "") + ":  " +
                   (commentBodyText(rp) || "_(empty)_").split(/\r\n|\r|\n/).join("  \n> "));
      });
      lines.push("");
      lines.push("---");
      lines.push("");
    });
  }
}

export function exportMetaLine(facts: ExportFacts): string {
  return exportSummaryParts(facts).concat(facts.date).join(" · ");
}

function mdSceneFactsLine(f: SceneFacts): string {
  return "**" + f.status.label + "** · Read " + f.read + (f.readSet ? ", set by hand" : "");
}

function mdReadCell(f: SceneFacts): string {
  return f.read + (f.readSet ? ", set by hand" : "");
}

function mdMarkerRun(numbers: number[], marks: Marks): Run {
  return {
    text: numbers.map(function (n) { return "<sup>" + n + "</sup>"; }).join(""),
    marks: marks
  };
}

function markdownWithMarkers(html: unknown, nums: Readonly<Record<string, number>>, services: ExportServices): string {
  const cell = services.cellOf(html);
  if (!cell.some(function (r) { return r.marks && r.marks.cmt; })) return toMarkdown(cell);
  const out: Run[] = [];
  cell.forEach(function (r, i) {
    const ids = r.marks && r.marks.cmt;
    const next = cell[i + 1];
    const nextIds = (next && next.marks && next.marks.cmt) || [];
    const ending = (ids || []).filter(function (id) { return nextIds.indexOf(id) === -1 && nums[id]; })
      .map(function (id) { return nums[id] ?? 0; })
      .sort(function (a, b) { return a - b; });
    if (!ending.length) { out.push(r); return; }
    const own: Marks = { ...r.marks };
    delete own.cmt;
    const tail = r.atom ? null : /\s+$/.exec(r.text);
    if (tail && tail.index > 0) {
      out.push({ text: r.text.slice(0, tail.index), marks: r.marks });
      out.push(mdMarkerRun(ending, own));
      out.push({ text: tail[0], marks: r.marks });
      return;
    }
    out.push(r);
    const carried: Marks = {};
    function carry<K extends keyof typeof own>(key: K): void {
      const value = own[key];
      if (key !== "tag" && next && !next.atom && next.marks[key] === value && value !== undefined) carried[key] = value;
    }
    carry("b"); carry("i"); carry("u"); carry("s"); carry("hl");
    carry("dir"); carry("cue"); carry("href");
    out.push(mdMarkerRun(ending, carried));
  });
  return toMarkdown(out);
}

function mdHardBreaks(md: string): string {
  return md.replace(/([^\n])\n(?=[^\n])/g, "$1  \n");
}

function mdLine(value: unknown): string {
  return String(value == null ? "" : value).replace(/\s*(\r\n|\r|\n)\s*/g, " ").trim();
}

function mdBrollTask(r: ShotRecord): string {
  const parts: string[] = [];
  if (r.location) parts.push(mdLine(r.location));
  if (r.owner) parts.push(mdLine(r.owner));
  if (r.props.length) parts.push("Props: " + r.props.map(mdLine).join(", "));
  if (r.flagged) parts.push("**Flagged**");
  if (r.note) parts.push("Note: " + mdLine(r.note));
  return "- [" + (r.shot ? "x" : " ") + "] " + mdLine(r.name) + (parts.length ? " — " + parts.join(" · ") : "");
}

function appendExportTail(lines: string[], doc: ExportDocument, services: ExportServices): void {
  const groups = breakdownGroups(doc);
  if (groups.length) {
    lines.push("## Production breakdown");
    lines.push("");
    groups.forEach(function (g) {
      lines.push("### " + g.label + " (" + g.items.length + ")");
      lines.push("");
      lines.push("| Item | Status | Scenes | Assigned to | Notes |");
      lines.push("| --- | --- | --- | --- | --- |");
      g.items.forEach(function (r) {
        lines.push("| " + [r.name, r.statusLabel, r.scenes.join(", "), r.owner || "—", r.notes].map(mdCell).join(" | ") + " |");
      });
      lines.push("");
    });
  }

  const broll = exportBrollScenes(doc, services);
  if (broll.length) {
    lines.push("## B-roll shot list");
    lines.push("");
    lines.push("_" + brollSummaryText(broll) + "_");
    lines.push("");
    broll.forEach(function (g) {
      lines.push("**" + g.label + "**" + (g.start ? " · " + g.start : "") + " · " + g.done + "/" + g.total + " shot");
      lines.push("");
      g.items.forEach(function (r) { lines.push(mdBrollTask(r)); });
      lines.push("");
    });
  }

  const comments = exportComments(doc, { pieces: true }, services);
  if (comments.length) {
    lines.push("## Comments");
    lines.push("");
    comments.forEach(function (c) {
      lines.push("**" + (c.number ? c.number + " · " : "") + c.where + "**" +
                 (c.resolved ? " _(resolved" + (c.resolvedBy ? " by " + c.resolvedBy : "") + ")_" : "") +
                 (c.assignee ? " _(assigned to " + c.assignee + ")_" : "") +
                 " — " + c.author + (c.when ? " · " + c.when : ""));
      lines.push("");
      if (c.quoted) {
        lines.push("> " + c.quoted.split(/\r\n|\r|\n/).join("  \n> "));
        lines.push("");
      }
      lines.push((commentBodyText(c) || "_(empty)_").split(/\r\n|\r|\n/).join("  \n"));
      c.replies.forEach(function (rp) {
        lines.push("");
        lines.push("> ↳ **" + rp.author + "**" + (rp.when ? " · " + rp.when : "") + ":  " +
                   (commentBodyText(rp) || "_(empty)_").split(/\r\n|\r|\n/).join("  \n> "));
      });
      lines.push("");
      lines.push("---");
      lines.push("");
    });
  }
}

function dataUrlImageExt(dataUrl: string | null | undefined): string {
  const m = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl || "");
  const t = m?.[1] ? m[1].toLowerCase() : "jpeg";
  if (t === "jpeg") return "jpg";
  if (t === "svg+xml") return "svg";
  return t;
}

function markdownImagePath(row: Row, i: number): string {
  const img = rowImage(row);
  return "images/scene-" + pad2(i + 1) + "." + dataUrlImageExt(img && img.ref ? "data:" + img.ref.mime : img && img.dataUrl);
}

function markdownHasPicture(row: Row, assets: ExportAssets): boolean {
  const img = rowImage(row);
  return !!img && (!!img.dataUrl || !!(img.ref && assets.picture(img.ref.sha256)));
}

export interface MarkdownImage { path: string; bytes: Uint8Array }

function markdownMorePictures(row: Row, i: number, assets: ExportAssets): MarkdownImage[] {
  const out: MarkdownImage[] = [];
  morePictureRefs(row).forEach(function (ref, k) {
    const pic = capturedPicture(assets, ref);
    if (!pic) return;
    out.push({ path: "images/scene-" + pad2(i + 1) + "-" + (k + 2) + "." + dataUrlImageExt("data:" + ref.mime), bytes: pic.bytes });
  });
  return out;
}

export function markdownExportImages(doc: ExportDocument, assets: ExportAssets): MarkdownImage[] {
  let out: MarkdownImage[] = [];
  doc.scenes.forEach(function (row, i) {
    const pic = rowImage(row) && capturedRowPicture(assets, row);
    if (pic) out.push({ path: markdownImagePath(row, i), bytes: pic.bytes });
    out = out.concat(markdownMorePictures(row, i, assets));
  });
  return out;
}

export function toMarkdownDoc(doc: ExportDocument, opts?: MarkdownOptions | null, services: ExportServices = exportServices()): string {
  const limit = opts && opts.scenes;
  const assets = (opts && opts.assets) || exportAssetsNow(doc);
  const facts = exportFacts(doc, services);
  const scenes = sceneFacts(doc, services);
  const nums = doc.commentNumbers;
  const lines: string[] = [];
  lines.push("# " + facts.title);
  lines.push("");
  if (!doc.scenes.length) {
    lines.push("_No scenes yet._");
    lines.push("");
  } else {
    lines.push("_" + exportMetaLine(facts) + "_");
    lines.push("");
  }
  (limit ? doc.scenes.slice(0, limit) : doc.scenes).forEach(function (row, i) {
    const f = scenes[i];
    if (!f) throw new Error("Missing scene facts");
    lines.push("### Scene " + f.number + " · " + f.start);
    lines.push("");
    lines.push(mdSceneFactsLine(f));
    lines.push("");
    if (markdownHasPicture(row, assets)) {
      lines.push("![visual for scene " + pad2(i + 1) + "](" + markdownImagePath(row, i) + ")");
      lines.push("");
    }
    const more = markdownMorePictures(row, i, assets);
    more.forEach(function (m, k) {
      lines.push("![visual " + (k + 2) + " for scene " + pad2(i + 1) + "](" + m.path + ")");
      lines.push("");
    });
    const vlinks = rowVideoLinks(row);
    vlinks.forEach(function (l) {
      lines.push(l.href
        ? "▶ [" + videoLinkLabel(l).replace(/([[\]()])/g, "\\$1") + "](" + l.href.replace(/[()\s]/g, encodeURIComponent) + ")"
        : "▶ " + (l.name || "").replace(/([\\`*_[\]<>])/g, "\\$1") + " _(video file)_");
    });
    if (vlinks.length) lines.push("");
    const vmd = mdHardBreaks(markdownWithMarkers(row.visualText, nums, services));
    if (vmd) {
      lines.push("*Visual —* " + vmd);
      lines.push("");
    }
    const amd = mdHardBreaks(markdownWithMarkers(row.audioText, nums, services));
    if (amd) {
      lines.push(amd);
      lines.push("");
    } else if (!vmd && !markdownHasPicture(row, assets) && !more.length && !vlinks.length) {
      lines.push("_(blank scene)_");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  });
  if (!limit) appendMarkdownTail(lines, doc, { export: true }, services);
  return lines.join("\n");
}

function mdRichTableCell(md: string): string {
  return String(md || "").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

function capturedRowDataUrl(assets: ExportAssets, row: Row): string | null {
  const img = rowImage(row);
  if (!img) return null;
  if (img.dataUrl) return img.dataUrl;
  const pic = capturedPicture(assets, img.ref);
  return pic ? "data:" + pic.mime + ";base64," + base64Encode(pic.bytes) : null;
}

export function mdSceneCellSource(row: Row, i: number, model?: boolean, assets?: ExportAssets | null, services: ExportServices = exportServices()) {
  const toMd = model ? function (html: unknown) { return toMarkdown(services.cellOf(html)); } : services.htmlToMarkdown;
  const text = toMd(row.visualText);
  let visual = text;
  const image = assets ? capturedRowDataUrl(assets, row) : rowImageDataUrl(row);
  if (image) {
    visual = "![visual for scene " + pad2(i + 1) + "](" + image + ")" + (visual ? "<br>" + visual : "");
  }
  return {
    visual: String(visual).replace(/\r\n|\r|\n/g, "<br>").trim(),
    visualText: String(text).replace(/\r\n|\r|\n/g, "<br>").trim(),
    image: image ? rowImageKey(row) : null,
    audio: String(toMd(row.audioText)).replace(/\r\n|\r|\n/g, "<br>").trim()
  };
}

export function toMarkdownTableDoc(doc: ExportDocument, opts?: MarkdownOptions | null, services: ExportServices = exportServices()): string {
  const s = doc.document;
  const exporting = !!(opts && opts.export);
  const limit = exporting ? opts?.scenes : undefined;
  const assets = (opts && opts.assets) || null;
  const lines: string[] = [];
  lines.push("# " + (s.title || "Untitled Script"));
  lines.push("");
  if (exporting && s.rows.length) {
    lines.push("_" + exportMetaLine(exportFacts(doc, services)) + "_");
    lines.push("");
  }
  if (!s.rows.length) {
    lines.push(exporting ? "_No scenes yet._" : "_No rows yet._");
  } else if (exporting) {
    const scenes = sceneFacts(doc, services);
    lines.push("| # | Start | Status | Visual | Audio | Read |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    (limit ? s.rows.slice(0, limit) : s.rows).forEach(function (row, i) {
      const cell = mdSceneCellSource(row, i, false, assets, services);
      const f = scenes[i];
      if (!f) throw new Error("Missing scene facts");
      lines.push("| " + [f.number, f.start, f.status.label].join(" | ") + " | " +
                 mdRichTableCell(cell.visual) + " | " + mdRichTableCell(cell.audio) + " | " +
                 mdReadCell(f) + " |");
    });
  } else {
    lines.push("| # | Visual | Audio | Status |");
    lines.push("| --- | --- | --- | --- |");
    s.rows.forEach(function (row, i) {
      const cell = mdSceneCellSource(row, i, false, assets, services);
      lines.push("| " + pad2(i + 1) + " | " + mdRichTableCell(cell.visual) + " | " +
                 mdRichTableCell(cell.audio) + " | " + (row.status || "todo") + " |");
    });
  }
  lines.push("");
  if (!limit) appendMarkdownTail(lines, doc, { export: exporting }, services);
  return lines.join("\n");
}

export function htmlToPlainScript(doc: ExportDocument, services: ExportServices = exportServices()): string {
  const lines = [doc.title || "Untitled Script", ""];
  doc.scenes.forEach(function (row, i) {
    lines.push("[" + pad2(i + 1) + "] VISUAL: " + toPlainText(services.cellOf(row.visualText)));
    rowVideoLinks(row).forEach(function (l) { lines.push("      VIDEO: " + videoLinkText(l)); });
    lines.push("      AUDIO: " + toPlainText(services.cellOf(row.audioText)));
    lines.push("");
  });

  const breakdown = breakdownRows(doc);
  if (breakdown.length) {
    lines.push("PRODUCTION BREAKDOWN");
    lines.push("====================");
    lines.push("");
    breakdown.forEach(function (r) {
      const where = r.inScript === "no"
        ? "not in script"
        : r.mentions + " mention" + (r.mentions === 1 ? "" : "s") +
          (r.scenes.length ? ", scene" + (r.scenes.length === 1 ? " " : "s ") + r.scenes.join(", ") : "");
      lines.push(r.categoryLabel + ": " + r.name +
        "  [" + r.statusLabel + "]" +
        (r.owner ? "  —  " + r.owner : "") +
        "  (" + where + ")");
      if (r.notes) {
        r.notes.split(/\r\n|\r|\n/).forEach(function (l) { lines.push("    " + l); });
      }
    });
    lines.push("");
  }

  const comments = commentEntries(doc, { pieces: true, clockMode: doc.clockMode }, services);
  if (comments.length) {
    lines.push("COMMENTS");
    lines.push("========");
    lines.push("");
    comments.forEach(function (c) {
      lines.push(c.location + (c.resolved ? " (resolved)" : "") +
                 "  —  " + c.author + (c.when ? ", " + c.when : ""));
      if (c.quoted) {
        c.quoted.split(/\r\n|\r|\n/).forEach(function (l) { lines.push('  "' + l + '"'); });
      }
      (commentBodyText(c) || "(empty)").split(/\r\n|\r|\n/).forEach(function (l) { lines.push("  " + l); });
      c.replies.forEach(function (rp) {
        lines.push("");
        const prefix = "  > " + rp.author + (rp.when ? ", " + rp.when : "") + ": ";
        (commentBodyText(rp) || "(empty)").split(/\r\n|\r|\n/).forEach(function (l, i) {
          lines.push((i === 0 ? prefix : "    ") + l);
        });
      });
      lines.push("");
      lines.push("------------------------------");
      lines.push("");
    });
  }
  return lines.join("\n");
}
