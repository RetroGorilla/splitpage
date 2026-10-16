import { rowImage, rowImageDataUrl, rowImageKey } from "./02c-blobs.js";
import { morePictureRefs, rowVideoLinks, videoLinkLabel, videoLinkText } from "./02d-gallery.js";
import {
  breakdownGroups,
  brollSummaryText,
  capturedPicture,
  capturedRowPicture,
  exportAssetsNow,
  exportBrollScenes,
  exportComments,
  exportFacts,
  exportSummaryParts,
  sceneFacts
} from "./14b-export-kit.js";
import { breakdownRows, commentBodyText, commentEntries } from "./14c-export-projections.js";
import { base64Encode } from "../core/document/media.ts";
import { pad2 } from "../core/production/timing.ts";
import { toMarkdown, toPlainText } from "../core/text/projections.ts";
import { cellOf, htmlToMarkdown } from "../legacy/richtext.ts";

function mdCell(value) {
  return String(value == null ? "" : value)
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, " ");
}

function appendMarkdownTail(lines, doc, opts) {
  if (opts && opts.export) { appendExportTail(lines, doc); return; }
  var breakdown = breakdownRows(doc);
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

  var comments = commentEntries(doc, { pieces: true, clockMode: doc.clockMode });
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

export function exportMetaLine(facts) {
  return exportSummaryParts(facts).concat(facts.date).join(" · ");
}

function mdSceneFactsLine(f) {
  return "**" + f.status.label + "** · Read " + f.read + (f.readSet ? ", set by hand" : "");
}

function mdReadCell(f) {
  return f.read + (f.readSet ? ", set by hand" : "");
}

function mdMarkerRun(numbers, marks) {
  return {
    text: numbers.map(function (n) { return "<sup>" + n + "</sup>"; }).join(""),
    marks: marks
  };
}

function markdownWithMarkers(html, nums) {
  var cell = cellOf(html);
  if (!cell.some(function (r) { return r.marks && r.marks.cmt; })) return toMarkdown(cell);
  var out = [];
  cell.forEach(function (r, i) {
    var ids = r.marks && r.marks.cmt;
    var next = cell[i + 1];
    var nextIds = (next && next.marks && next.marks.cmt) || [];
    var ending = (ids || []).filter(function (id) { return nextIds.indexOf(id) === -1 && nums[id]; })
      .map(function (id) { return nums[id]; })
      .sort(function (a, b) { return a - b; });
    if (!ending.length) { out.push(r); return; }
    var own = {};
    Object.keys(r.marks).forEach(function (k) { if (k !== "cmt") own[k] = r.marks[k]; });
    var tail = r.atom ? null : /\s+$/.exec(r.text);
    if (tail && tail.index > 0) {
      out.push({ text: r.text.slice(0, tail.index), marks: r.marks });
      out.push(mdMarkerRun(ending, own));
      out.push({ text: tail[0], marks: r.marks });
      return;
    }
    out.push(r);
    var carried = {};
    Object.keys(own).forEach(function (k) {
      if (k !== "tag" && next && !next.atom && next.marks && next.marks[k] === own[k]) carried[k] = own[k];
    });
    out.push(mdMarkerRun(ending, carried));
  });
  return toMarkdown(out);
}

function mdHardBreaks(md) {
  return md.replace(/([^\n])\n(?=[^\n])/g, "$1  \n");
}

function mdLine(value) {
  return String(value == null ? "" : value).replace(/\s*(\r\n|\r|\n)\s*/g, " ").trim();
}

function mdBrollTask(r) {
  var parts = [];
  if (r.location) parts.push(mdLine(r.location));
  if (r.owner) parts.push(mdLine(r.owner));
  if (r.props.length) parts.push("Props: " + r.props.map(mdLine).join(", "));
  if (r.flagged) parts.push("**Flagged**");
  if (r.note) parts.push("Note: " + mdLine(r.note));
  return "- [" + (r.shot ? "x" : " ") + "] " + mdLine(r.name) + (parts.length ? " — " + parts.join(" · ") : "");
}

function appendExportTail(lines, doc) {
  var groups = breakdownGroups(doc);
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

  var broll = exportBrollScenes(doc);
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

  var comments = exportComments(doc, { pieces: true });
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

function dataUrlImageExt(dataUrl) {
  var m = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl || "");
  var t = m ? m[1].toLowerCase() : "jpeg";
  if (t === "jpeg") return "jpg";
  if (t === "svg+xml") return "svg";
  return t;
}

function markdownImagePath(row, i) {
  var img = rowImage(row);
  return "images/scene-" + pad2(i + 1) + "." + dataUrlImageExt(img && img.ref ? "data:" + img.ref.mime : img && img.dataUrl);
}

function markdownHasPicture(row, assets) {
  var img = rowImage(row);
  return !!img && (!!img.dataUrl || !!assets.picture(img.ref.sha256));
}

function markdownMorePictures(row, i, assets) {
  var out = [];
  morePictureRefs(row).forEach(function (ref, k) {
    var pic = capturedPicture(assets, ref);
    if (!pic) return;
    out.push({ path: "images/scene-" + pad2(i + 1) + "-" + (k + 2) + "." + dataUrlImageExt("data:" + ref.mime), bytes: pic.bytes });
  });
  return out;
}

export function markdownExportImages(doc, assets) {
  var out = [];
  doc.scenes.forEach(function (row, i) {
    var pic = rowImage(row) && capturedRowPicture(assets, row);
    if (pic) out.push({ path: markdownImagePath(row, i), bytes: pic.bytes });
    out = out.concat(markdownMorePictures(row, i, assets));
  });
  return out;
}

export function toMarkdownDoc(doc, opts) {
  var limit = opts && opts.scenes;
  var assets = (opts && opts.assets) || exportAssetsNow(doc);
  var facts = exportFacts(doc);
  var scenes = sceneFacts(doc);
  var nums = doc.commentNumbers;
  var lines = [];
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
    lines.push("### Scene " + scenes[i].number + " · " + scenes[i].start);
    lines.push("");
    lines.push(mdSceneFactsLine(scenes[i]));
    lines.push("");
    if (markdownHasPicture(row, assets)) {
      lines.push("![visual for scene " + pad2(i + 1) + "](" + markdownImagePath(row, i) + ")");
      lines.push("");
    }
    var more = markdownMorePictures(row, i, assets);
    more.forEach(function (m, k) {
      lines.push("![visual " + (k + 2) + " for scene " + pad2(i + 1) + "](" + m.path + ")");
      lines.push("");
    });
    var vlinks = rowVideoLinks(row);
    vlinks.forEach(function (l) {
      lines.push(l.href
        ? "▶ [" + videoLinkLabel(l).replace(/([[\]()])/g, "\\$1") + "](" + l.href.replace(/[()\s]/g, encodeURIComponent) + ")"
        : "▶ " + l.name.replace(/([\\`*_[\]<>])/g, "\\$1") + " _(video file)_");
    });
    if (vlinks.length) lines.push("");
    var vmd = mdHardBreaks(markdownWithMarkers(row.visualText, nums));
    if (vmd) {
      lines.push("*Visual —* " + vmd);
      lines.push("");
    }
    var amd = mdHardBreaks(markdownWithMarkers(row.audioText, nums));
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
  if (!limit) appendMarkdownTail(lines, doc, { export: true });
  return lines.join("\n");
}

function mdRichTableCell(md) {
  return String(md || "").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

function capturedRowDataUrl(assets, row) {
  var img = rowImage(row);
  if (!img) return null;
  if (img.dataUrl) return img.dataUrl;
  var pic = capturedPicture(assets, img.ref);
  return pic ? "data:" + pic.mime + ";base64," + base64Encode(pic.bytes) : null;
}

export function mdSceneCellSource(row, i, model, assets) {
  var toMd = model ? function (html) { return toMarkdown(cellOf(html)); } : htmlToMarkdown;
  var text = toMd(row.visualText);
  var visual = text;
  var image = assets ? capturedRowDataUrl(assets, row) : rowImageDataUrl(row);
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

export function toMarkdownTableDoc(doc, opts) {
  var s = doc.document;
  var exporting = !!(opts && opts.export);
  var limit = exporting && opts.scenes;
  var assets = (opts && opts.assets) || null;
  var lines = [];
  lines.push("# " + (s.title || "Untitled Script"));
  lines.push("");
  if (exporting && s.rows.length) {
    lines.push("_" + exportMetaLine(exportFacts(doc)) + "_");
    lines.push("");
  }
  if (!s.rows.length) {
    lines.push(exporting ? "_No scenes yet._" : "_No rows yet._");
  } else if (exporting) {
    var scenes = sceneFacts(doc);
    lines.push("| # | Start | Status | Visual | Audio | Read |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    (limit ? s.rows.slice(0, limit) : s.rows).forEach(function (row, i) {
      var cell = mdSceneCellSource(row, i, false, assets);
      lines.push("| " + [scenes[i].number, scenes[i].start, scenes[i].status.label].join(" | ") + " | " +
                 mdRichTableCell(cell.visual) + " | " + mdRichTableCell(cell.audio) + " | " +
                 mdReadCell(scenes[i]) + " |");
    });
  } else {
    lines.push("| # | Visual | Audio | Status |");
    lines.push("| --- | --- | --- | --- |");
    s.rows.forEach(function (row, i) {
      var cell = mdSceneCellSource(row, i, false, assets);
      lines.push("| " + pad2(i + 1) + " | " + mdRichTableCell(cell.visual) + " | " +
                 mdRichTableCell(cell.audio) + " | " + (row.status || "todo") + " |");
    });
  }
  lines.push("");
  if (!limit) appendMarkdownTail(lines, doc, { export: exporting });
  return lines.join("\n");
}

export function htmlToPlainScript(doc) {
  var lines = [doc.title || "Untitled Script", ""];
  doc.scenes.forEach(function (row, i) {
    lines.push("[" + pad2(i + 1) + "] VISUAL: " + toPlainText(cellOf(row.visualText)));
    rowVideoLinks(row).forEach(function (l) { lines.push("      VIDEO: " + videoLinkText(l)); });
    lines.push("      AUDIO: " + toPlainText(cellOf(row.audioText)));
    lines.push("");
  });

  var breakdown = breakdownRows(doc);
  if (breakdown.length) {
    lines.push("PRODUCTION BREAKDOWN");
    lines.push("====================");
    lines.push("");
    breakdown.forEach(function (r) {
      var where = r.inScript === "no"
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

  var comments = commentEntries(doc, { pieces: true, clockMode: doc.clockMode });
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
        var prefix = "  > " + rp.author + (rp.when ? ", " + rp.when : "") + ": ";
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
