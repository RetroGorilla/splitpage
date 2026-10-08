import { S } from "./_state.js";
import { readPref, writePref } from "./00p-prefs.js";
import { DEFAULT_WPM, formatDuration, wordCount } from "./01-scene-status.js";
import { bytesForSync, internDataUrl, queuePersist, rowImage, rowImageBytes } from "./02c-blobs.js";
import { morePictureRefs, pictureBytes, rowVideoLinks } from "./02d-gallery.js";
import { imageDims, sniffImageMime } from "../../shared/blob-policy.js";
import {
  htmlToPlainText,
  strBytes,
  xmlEscape,
  zipRead,
  zipWrite
} from "./14-export.js";
import {
  PRINT_COLORS,
  STATUS_PRINT,
  TAG_STATUS_PRINT,
  breakdownGroups,
  brollSummaryText,
  commentNumbers,
  exportBrollScenes,
  exportComments,
  exportFacts,
  exportRuns,
  exportSummaryParts,
  sceneFacts
} from "./14b-export-kit.js";
import { makeId } from "../adapters/identity/ids.ts";
import { escapeHtml, safeHref, unitSafePrefix } from "../core/document/text-policy.ts";
import { pad2 } from "../core/production/timing.ts";
import { flattenCues, importCues, withoutCues } from "../core/text/cues.ts";
import { importDirections } from "../core/text/directions.ts";
import { setMark } from "../core/text/edits.ts";
import { toHtml } from "../core/text/html.ts";
import { OMIT_CLOSES, toDocxRuns, toPlainText } from "../core/text/projections.ts";
import { cellLength } from "../core/text/runs.ts";
import { cellOf, fromHtml, inertBody } from "../legacy/richtext.ts";

var DOCX_CATEGORY_DOT = "● ";

var STYLES_XML;

var EXPORT_TABLE_STYLE_ID = "SplitpageTable";

export function dataUrlToBytes(dataUrl) {
  var comma = dataUrl.indexOf(",");
  var b64 = dataUrl.slice(comma + 1);
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

var DOCX_IMAGE_EXT = { "image/jpeg": "jpeg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

export function jpegSize(bytes) {
  var i = 2;
  while (i < bytes.length - 9) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    var marker = bytes[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    var len = (bytes[i + 2] << 8) | bytes[i + 3];
    i += 2 + len;
  }
  return { w: 800, h: 450 };
}

export function safeAspect(dim) {
  var w = dim && dim.w > 0 ? dim.w : 800;
  var h = dim && dim.h > 0 ? dim.h : 450;
  return { w: w, h: h, ratio: h / w };
}

function fitColumnWidths(totalWidth, minChars, headers, rowsCells, maxChars) {
  var weights = headers.map(function (h, i) {
    var longest = String(h).length;
    rowsCells.forEach(function (r) {
      var len = String(r[i] == null ? "" : r[i]).length;
      if (len > longest) longest = len;
    });
    return Math.max(minChars[i], Math.min(maxChars && maxChars[i] || 40, longest));
  });
  var sum = weights.reduce(function (a, b) { return a + b; }, 0);
  var widths = weights.map(function (w) { return Math.floor(totalWidth * w / sum); });
  var used = widths.reduce(function (a, b) { return a + b; }, 0);
  widths[widths.length - 1] += totalWidth - used;
  return widths;
}

var DIRECTION_STYLE = "SplitpageDirection";
var DIRECTION_COLOR = "6B6A65";

function omitDirectionRuns(runs) {
  var out = [], gap = false;
  runs.forEach(function (r) {
    if (r.dir) { gap = true; return; }
    if (r.text === "\n") { gap = false; out.push(r); return; }
    if (gap) {
      var last = out[out.length - 1];
      var t = r.text;
      if (OMIT_CLOSES.test(t)) {
        if (last && last.text !== "\n") out[out.length - 1] = Object.assign({}, last, { text: last.text.replace(/[ \t]+$/, "") });
      } else if (!last || /\s$/.test(last.text)) {
        t = t.replace(/^[ \t]+/, "");
      } else if (!/^\s/.test(t)) {
        t = " " + t;
      }
      if (!t) return;
      r = Object.assign({}, r, { text: t });
    }
    gap = false;
    out.push(r);
  });
  return out;
}

var CUE_STYLE = "SplitpageCue";
var CUE_COLOR = "AB413E";
var CUE_SIZE = 18;

var TAG_STYLE = "SplitpageTag";
var MARKER_STYLE = "SplitpageMarker";
var BROLL_STYLE = "SplitpageBroll";
var MARKER_SIZE = 15;
var BROLL_SIZE = 16;
var CHIP_PAD = String.fromCharCode(0x2009);
var CHIP_PAD_ENDS = new RegExp("^" + CHIP_PAD + "+|" + CHIP_PAD + "+$", "g");
var NBSP = String.fromCharCode(0xA0);

function rPrXml(p) {
  var out = "";
  if (p.style) out += '<w:rStyle w:val="' + p.style + '"/>';
  if (p.b) out += "<w:b/>";
  if (p.i) out += "<w:i/>";
  if (p.s) out += "<w:strike/>";
  if (p.color) out += '<w:color w:val="' + p.color + '"/>';
  if (p.position) out += '<w:position w:val="' + p.position + '"/>';
  if (p.sz) out += '<w:sz w:val="' + p.sz + '"/>';
  if (p.mark) out += '<w:highlight w:val="yellow"/>';
  if (p.u) out += '<w:u w:val="' + p.u + '"' + (p.uColor ? ' w:color="' + p.uColor + '"' : "") + "/>";
  if (p.bdr) out += '<w:bdr w:val="single" w:sz="4" w:space="0" w:color="' + p.bdr + '"/>';
  if (p.shd) out += '<w:shd w:val="clear" w:color="auto" w:fill="' + p.shd + '"/>';
  if (p.vertAlign) out += '<w:vertAlign w:val="' + p.vertAlign + '"/>';
  return out ? "<w:rPr>" + out + "</w:rPr>" : "";
}

function textRunXml(text, p) {
  return "<w:r>" + rPrXml(p || {}) + '<w:t xml:space="preserve">' + xmlEscape(text) + "</w:t></w:r>";
}

function markerRunsXml(nums) {
  return nums.map(function (n) {
    return textRunXml(CHIP_PAD + n + CHIP_PAD, {
      style: MARKER_STYLE, b: true, color: PRINT_COLORS.audio, sz: MARKER_SIZE, position: 6, bdr: PRINT_COLORS.audio
    });
  }).join("");
}

function docxRunsXml(html, rels, opts) {
  opts = opts || {};
  var ann = opts.annotate;
  var runs;
  if (ann) {
    runs = exportRuns(html, ann.nums);
  } else {
    var cell = cellOf(html);
    if (opts.cues === "omit") cell = withoutCues(cell);
    runs = toDocxRuns(cell);
  }
  if (opts.directions === "omit") runs = omitDirectionRuns(runs);
  var out = "<w:p>" + (opts.pPr ? "<w:pPr>" + opts.pPr + "</w:pPr>" : "") + (opts.lead || "");
  runs.forEach(function (r) {
    if (r.text === "\n") { out += "<w:r><w:br/></w:r>"; return; }
    var tag = ann && r.tag;
    var p = { b: r.b, i: r.i || r.dir, s: r.s, mark: r.mark };
    var text = r.text;
    if (ann && r.broll) {
      p.style = BROLL_STYLE;
      p.b = true;
      p.color = PRINT_COLORS.broll;
      p.sz = BROLL_SIZE;
      p.bdr = PRINT_COLORS.broll;
      text = CHIP_PAD + text + CHIP_PAD;
    } else if (r.dir) {
      p.style = DIRECTION_STYLE;
      if (!r.href) p.color = DIRECTION_COLOR;
    } else if (r.cue) {
      p.style = CUE_STYLE;
      if (!r.href) p.color = CUE_COLOR;
    } else if (tag) {
      p.style = TAG_STYLE;
      if (!r.href && tag.color) p.color = tag.color;
    }
    if (r.href) p.color = "1155CC";
    if (r.cue) p.sz = CUE_SIZE;
    else if (!p.sz && opts.sz) p.sz = opts.sz;
    var cmt = ann && r.cmt ? r.cmt.filter(function (id) { return id in ann.open; }) : [];
    if (r.u || r.href) {
      p.u = "single";
    } else if (cmt.length) {
      p.u = "dotted";
      p.uColor = cmt.some(function (id) { return ann.open[id]; }) ? PRINT_COLORS.audio : PRINT_COLORS.faint;
    } else if (tag && tag.color) {
      p.u = "single";
      p.uColor = tag.color;
    }
    var run = textRunXml(text, p);
    if (r.href) out += '<w:hyperlink r:id="' + rels.addLink(r.href) + '">' + run + "</w:hyperlink>";
    else out += run;
    if (ann && r.markers) out += markerRunsXml(r.markers);
  });
  return out + "</w:p>";
}

function docxDrawingRun(img, id, cx, cy) {
  return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="' + id + '" name="' + img.name + '"/><wp:cNvGraphicFramePr/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + id + '" name="' + img.name + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="' + img.rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

var VIDEO_LINKS_MARK = "▶ ";

function shortHref(href) {
  return String(href).replace(/^https?:\/\/(www\.)?/i, "");
}

function docxVideoLinksXml(links, rels) {
  if (!links.length) return "";
  var rPr = '<w:rPr><w:sz w:val="18"/></w:rPr>';
  var out = '<w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r>' + rPr + '<w:t xml:space="preserve">' + VIDEO_LINKS_MARK + '</w:t></w:r>';
  links.forEach(function (l, i) {
    if (i) out += '<w:r>' + rPr + '<w:t xml:space="preserve">  ·  </w:t></w:r>';
    if (l.href) {
      out += '<w:hyperlink r:id="' + rels.addLink(l.href) + '"><w:r><w:rPr><w:color w:val="1155CC"/><w:sz w:val="18"/><w:u w:val="single"/></w:rPr>' +
        '<w:t xml:space="preserve">' + xmlEscape(shortHref(l.href)) + '</w:t></w:r></w:hyperlink>';
    } else {
      out += '<w:r>' + rPr + '<w:t xml:space="preserve">' + xmlEscape(l.name + " (video file)") + '</w:t></w:r>';
    }
  });
  return out + '</w:p>';
}

function docxVideoLinksOf(pEl, linkMap) {
  var html = docxParaToHtml(pEl, linkMap);
  var text = htmlToPlainText(html);
  if (text.indexOf(VIDEO_LINKS_MARK) !== 0) return null;
  var hrefs = [];
  inertBody(html).querySelectorAll("a[href]").forEach(function (a) { hrefs.push(a.getAttribute("href")); });
  var parts = text.slice(VIDEO_LINKS_MARK.length).split("  ·  ");
  var links = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    var file = /^(.+) \(video file\)$/.exec(p);
    if (file) { links.push({ name: file[1] }); continue; }
    var at = hrefs.findIndex(function (h) { return h === p || shortHref(h) === p; });
    if (at === -1) return null;
    links.push({ href: hrefs.splice(at, 1)[0] });
  }
  return links.length ? links : null;
}

function docxCellXml(inner, widthDxa, opts) {
  opts = opts || {};
  var mar = opts.mar || {};
  var marXml = ["top", "left", "bottom", "right"].map(function (side) {
    return mar[side] === undefined ? "" : '<w:' + side + ' w:w="' + mar[side] + '" w:type="dxa"/>';
  }).join("");
  return '<w:tc><w:tcPr><w:tcW w:w="' + widthDxa + '" w:type="dxa"/>' +
    (opts.span ? '<w:gridSpan w:val="' + opts.span + '"/>' : "") +
    (opts.bottom ? '<w:tcBorders><w:bottom w:val="single" w:sz="' + opts.bottom.sz + '" w:space="0" w:color="' + opts.bottom.color + '"/></w:tcBorders>' : "") +
    (marXml ? "<w:tcMar>" + marXml + "</w:tcMar>" : "") + "</w:tcPr>" +
    (inner || cellParaXml("")) + "</w:tc>";
}

function cellParaXml(runs, o) {
  o = o || {};
  return "<w:p><w:pPr>" + (o.keepNext ? "<w:keepNext/>" : "") +
    '<w:spacing w:before="' + (o.before || 0) + '" w:after="' + (o.after || 0) + '"/>' +
    (o.jc ? '<w:jc w:val="' + o.jc + '"/>' : "") + "</w:pPr>" + runs + "</w:p>";
}

function docxLineBreakParagraph(text, indentDxa, rPr) {
  var runXml = String(text || "").split(/\r\n|\r|\n/).map(function (line, i) {
    return (i > 0 ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + xmlEscape(line) + '</w:t>';
  }).join('');
  return '<w:p><w:pPr><w:spacing w:after="120"/><w:ind w:left="' + indentDxa + '"/></w:pPr>' +
    '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + runXml + '</w:r></w:p>';
}

var PAGE_W = 10080;
var COL_SCENE = 1080, COL_VISUAL = 3880, COL_AUDIO = 4400, COL_READ = 720;
var VISUAL_SZ = 20;
var HEAD_SZ = 17;
var GUTTER_SZ = 16;

var LAMP_CHARS = { outline: "○", fill: "●", half: "◐", check: "✓", ring: "↩" };

function lampRunsXml(status, label, sz) {
  return textRunXml(LAMP_CHARS[status.lamp] || LAMP_CHARS.outline, { color: status.color, sz: sz }) +
    textRunXml(" " + label, { color: status.lamp === "outline" ? PRINT_COLORS.faint : PRINT_COLORS.dim, sz: sz });
}

function sceneCellXml(f) {
  var st = STATUS_PRINT[f.status.id] || STATUS_PRINT.todo;
  return docxCellXml(
    cellParaXml(textRunXml(f.number, { b: true, sz: 26 })) +
    cellParaXml(textRunXml(f.start, { color: PRINT_COLORS.faint, sz: GUTTER_SZ }), { after: 80 }) +
    cellParaXml(lampRunsXml(st, f.status.label, GUTTER_SZ)),
    COL_SCENE, { mar: { left: 0 } });
}

function readCellXml(f) {
  var p = { color: PRINT_COLORS.dim, sz: 18 };
  if (f.readSet) p.bdr = PRINT_COLORS.borderStrong;
  return docxCellXml(cellParaXml(textRunXml(f.readSet ? CHIP_PAD + f.read + CHIP_PAD : f.read, p), { jc: "right" }),
    COL_READ, { mar: { right: 0 } });
}

var HEAD_RULE_SZ = 8;

function headCellXml(text, width, color, opts) {
  opts = opts || {};
  return docxCellXml(cellParaXml(textRunXml(text, { b: true, color: color || PRINT_COLORS.dim, sz: HEAD_SZ }), { jc: opts.jc }),
    width, { mar: Object.assign({ top: 0, bottom: 80 }, opts.mar), bottom: { sz: HEAD_RULE_SZ, color: PRINT_COLORS.borderStrong } });
}

var KEEP_WHOLE_LINES = 10;

function sceneLineEstimate(row) {
  function lines(html) {
    return toPlainText(cellOf(html)).split("\n").reduce(function (n, l) { return n + Math.max(1, Math.ceil(l.length / 40)); }, 0);
  }
  var pics = (rowImage(row) ? 1 : 0) + morePictureRefs(row).length;
  return Math.max(lines(row.visualText) + pics * 8, lines(row.audioText));
}

function commentOpenness() {
  var out = Object.create(null);
  (S.state.comments || []).forEach(function (c) { if (c && c.id) out[c.id] = !c.resolved; });
  return out;
}

var META_STYLE = "SplitpageMeta";

function metaParaXml(text) {
  return '<w:p><w:pPr><w:pStyle w:val="' + META_STYLE + '"/></w:pPr>' + textRunXml(text) + "</w:p>";
}

function titleParaXml(title) {
  return '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>' + textRunXml(title) + "</w:p>";
}

function headingParaXml(text, newPage) {
  return '<w:p><w:pPr><w:pStyle w:val="Heading1"/>' + (newPage ? "<w:pageBreakBefore/>" : "") + "</w:pPr>" +
    textRunXml(text) + "</w:p>";
}

function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

function tableXml(cols, rowsXml) {
  var width = cols.reduce(function (a, b) { return a + b; }, 0);
  return '<w:tbl><w:tblPr><w:tblStyle w:val="' + EXPORT_TABLE_STYLE_ID + '"/><w:tblW w:w="' + width + '" w:type="dxa"/>' +
    tableBordersXml() + '<w:tblLayout w:type="fixed"/>' +
    '<w:tblLook w:val="0620" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>' +
    "</w:tblPr><w:tblGrid>" + cols.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join("") + "</w:tblGrid>" +
    rowsXml + "</w:tbl>";
}

function tableBordersXml() {
  var hair = 'w:val="single" w:sz="4" w:space="0" w:color="' + PRINT_COLORS.border + '"';
  return "<w:tblBorders>" +
    '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom ' + hair + '/><w:right w:val="nil"/>' +
    '<w:insideH ' + hair + '/><w:insideV w:val="nil"/></w:tblBorders>';
}

var BREAKDOWN_HEAD_WORDS = ["Item", "Status", "Scenes", "Assigned to", "Notes"];

var FLAG_COLOR = "C4302A";
var SHOT_INDENT = 400;

export function buildDocx() {
  var media = [];
  var links = [];
  var rels = {
    addLink: function (href) {
      links.push(href);
      return "rIdL" + links.length;
    },
    addImage: function (bytes, mime) {
      var ext = DOCX_IMAGE_EXT[mime] || "jpeg";
      media.push({ bytes: bytes, ext: ext });
      return { rid: "rIdM" + media.length, name: "image" + media.length + "." + ext };
    }
  };

  var pictureParts = {};

  var facts = exportFacts();
  var body = titleParaXml(facts.title) + metaParaXml(exportSummaryParts(facts).concat(facts.date).join(" · "));

  var rowsXml = "";
  rowsXml += "<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>" +
    headCellXml("Scene", COL_SCENE, null, { mar: { left: 0 } }) +
    headCellXml("Visual", COL_VISUAL, PRINT_COLORS.visual) +
    headCellXml("Audio", COL_AUDIO, PRINT_COLORS.audio) +
    headCellXml("Read", COL_READ, null, { jc: "right", mar: { right: 0 } }) +
    "</w:tr>";

  var scenes = sceneFacts();
  var ann = { nums: commentNumbers(), open: commentOpenness() };
  var maxW = (COL_VISUAL - 200) * 635;
  S.state.rows.forEach(function (row, idx) {
    var visual = "";
    var pic = rowImage(row) && rowImageBytes(row);
    if (pic) {
      try {
        var bytes = pic.bytes;
        var dim = safeAspect(rowImage(row).ref ? { w: pic.width, h: pic.height } : jpegSize(bytes));
        var img = rels.addImage(bytes, pic.mime);
        var cx = Math.round(Math.min(maxW, dim.w * 9525));
        var cy = Math.round(cx * dim.ratio);
        visual += cellParaXml(docxDrawingRun(img, media.length, cx, cy), { after: 80 });
        if (rowImage(row).ref) pictureParts[rowImage(row).ref.sha256] = { rid: img.rid, name: img.name, w: dim.w, h: dim.h };
      } catch (e) { }
    }
    morePictureRefs(row).forEach(function (ref) {
      var more = pictureBytes(ref);
      if (!more) return;
      try {
        var mdim = safeAspect({ w: more.width, h: more.height });
        var mimg = rels.addImage(more.bytes, more.mime);
        var mcx = Math.round(Math.min(maxW, mdim.w * 9525));
        visual += cellParaXml(docxDrawingRun(mimg, media.length, mcx, Math.round(mcx * mdim.ratio)), { after: 80 });
        pictureParts[ref.sha256] = { rid: mimg.rid, name: mimg.name, w: mdim.w, h: mdim.h };
      } catch (e) { }
    });
    visual += docxVideoLinksXml(rowVideoLinks(row), rels);
    visual += docxRunsXml(row.visualText, rels, { annotate: ann, sz: VISUAL_SZ, pPr: '<w:spacing w:after="0"/>' });
    var audio = docxRunsXml(row.audioText, rels, { annotate: ann, pPr: '<w:spacing w:after="0"/>' });
    rowsXml += "<w:tr>" + (sceneLineEstimate(row) <= KEEP_WHOLE_LINES ? "<w:trPr><w:cantSplit/></w:trPr>" : "") +
      sceneCellXml(scenes[idx]) + docxCellXml(visual, COL_VISUAL) + docxCellXml(audio, COL_AUDIO) +
      readCellXml(scenes[idx]) + "</w:tr>";
  });

  body += tableXml([COL_SCENE, COL_VISUAL, COL_AUDIO, COL_READ], rowsXml);
  var appendix = 0;
  var groups = breakdownGroups();
  if (groups.length) {
    var itemCount = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    body += headingParaXml("Production breakdown", !appendix++) +
      metaParaXml(plural(itemCount, "tracked item") + " · " + plural(groups.length, "category", "categories"));

    var bHeaders = BREAKDOWN_HEAD_WORDS;
    var items = [];
    groups.forEach(function (g) { items = items.concat(g.items); });
    var bMins = [12, 13, 10, 13, 14];
    var bMaxes = [28, 13, 16, 18, 40];
    var bCellRows = items.map(function (r) {
      return [r.name, "● " + r.statusLabel, r.scenes.join(", "), r.owner,
        r.notes + (r.broll.length ? " B-roll: " + r.broll.join("; ") : "")];
    });
    var bCols = fitColumnWidths(PAGE_W, bMins, bHeaders, bCellRows, bMaxes);
    var BD_SZ = 19;
    var edge = function (i) {
      return i === 0 ? { left: 0 } : i === bHeaders.length - 1 ? { right: 0 } : {};
    };

    var bRows = "<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>" +
      bHeaders.map(function (h, i) { return headCellXml(h, bCols[i], null, { mar: edge(i) }); }).join("") + "</w:tr>";

    groups.forEach(function (g) {
      var color = g.color || PRINT_COLORS.text;
      bRows += "<w:tr><w:trPr><w:cantSplit/></w:trPr>" +
        docxCellXml(cellParaXml(
          textRunXml(DOCX_CATEGORY_DOT, { color: color, sz: 20 }) +
          textRunXml(g.label, { b: true, color: color, sz: 20 }) +
          textRunXml("  " + g.items.length, { color: PRINT_COLORS.faint, sz: 18 }), { keepNext: true }),
        PAGE_W, { span: bHeaders.length, mar: { top: 240, left: 0, right: 0, bottom: 80 } }) + "</w:tr>";
      g.items.forEach(function (r) {
        var st = TAG_STATUS_PRINT[r.status] || TAG_STATUS_PRINT.needed;
        var notes = r.notes ? cellParaXml(textRunXml(r.notes, { color: PRINT_COLORS.dim, sz: BD_SZ })) : "";
        r.broll.forEach(function (shot) {
          notes += cellParaXml(textRunXml("B-roll ", { b: true, color: PRINT_COLORS.broll, sz: 16 }) +
            textRunXml(shot, { color: PRINT_COLORS.dim, sz: 17 }), { before: notes ? 40 : 0 });
        });
        var cells = [
          cellParaXml(textRunXml(r.name, { sz: BD_SZ })),
          cellParaXml(lampRunsXml(st, r.statusLabel, BD_SZ)),
          cellParaXml(textRunXml(r.scenes.join(", "), { color: PRINT_COLORS.dim, sz: BD_SZ })),
          cellParaXml(textRunXml(r.owner, { color: PRINT_COLORS.dim, sz: BD_SZ })),
          notes
        ];
        bRows += "<w:tr><w:trPr><w:cantSplit/></w:trPr>" + cells.map(function (inner, i) {
          return docxCellXml(inner, bCols[i], { mar: Object.assign({ top: 70, bottom: 90 }, edge(i)) });
        }).join("") + "</w:tr>";
      });
    });

    body += tableXml(bCols, bRows);
  }

  var shots = exportBrollScenes();
  if (shots.length) {
    body += headingParaXml("B-roll shot list", !appendix++) + metaParaXml(brollSummaryText(shots));
    shots.forEach(function (g) {
      body += '<w:p><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="3" w:color="' + PRINT_COLORS.border + '"/></w:pBdr>' +
        '<w:tabs><w:tab w:val="right" w:pos="' + PAGE_W + '"/></w:tabs><w:spacing w:before="280" w:after="100"/></w:pPr>' +
        textRunXml(g.label, { b: true, sz: 20 }) +
        (g.start ? textRunXml("  " + g.start, { color: PRINT_COLORS.faint, sz: 18 }) : "") +
        "<w:r><w:tab/></w:r>" +
        textRunXml(g.done + "/" + g.total + " shot", { color: PRINT_COLORS.faint, sz: 18 }) + "</w:p>";
      g.items.forEach(function (it, k) {
        var details = [];
        if (it.location) details.push(textRunXml(it.location, { color: PRINT_COLORS.dim, sz: 17 }));
        if (it.owner) details.push(textRunXml(it.owner, { color: PRINT_COLORS.dim, sz: 17 }));
        if (it.propsWithStatus.length) details.push(textRunXml(it.propsWithStatus.join(", "), { color: PRINT_COLORS.dim, sz: 17 }));
        if (it.flagged) details.push(textRunXml("Flagged", { b: true, color: FLAG_COLOR, sz: 17 }));
        var more = details.length || it.note;
        body += '<w:p><w:pPr>' + (more ? "<w:keepNext/>" : "") + '<w:spacing w:before="' + (k ? 120 : 0) + '" w:after="0"/>' +
          '<w:ind w:left="' + SHOT_INDENT + '" w:hanging="' + SHOT_INDENT + '"/></w:pPr>' +
          textRunXml(it.shot ? "☑" : "☐", { color: it.shot ? PRINT_COLORS.broll : PRINT_COLORS.faint, sz: 22 }) +
          "<w:r><w:tab/></w:r>" + textRunXml(it.name, { sz: 20 }) + "</w:p>";
        var sep = textRunXml("  ·  ", { color: PRINT_COLORS.faint, sz: 17 });
        if (details.length) {
          body += '<w:p><w:pPr>' + (it.note ? "<w:keepNext/>" : "") + '<w:spacing w:before="20" w:after="0"/><w:ind w:left="' + SHOT_INDENT + '"/></w:pPr>' +
            details.join(sep) + "</w:p>";
        }
        if (it.note) {
          body += '<w:p><w:pPr><w:spacing w:before="20" w:after="0"/><w:ind w:left="' + SHOT_INDENT + '"/></w:pPr>' +
            textRunXml(it.note, { i: true, color: PRINT_COLORS.dim, sz: 17 }) + "</w:p>";
        }
      });
    });
  }

  var comments = exportComments({ pieces: true });
  if (comments.length) {
    var openCount = comments.filter(function (c) { return !c.resolved; }).length;
    body += headingParaXml("Comments", !appendix) +
      metaParaXml([openCount ? openCount + " open" : "", comments.length - openCount ? (comments.length - openCount) + " resolved" : ""]
        .filter(Boolean).join(" · "));

    var CIMG_MAXW = 0.6, CIMG_MAXH = 3302000;
    var drawingId = media.length;

    function commentPictureXml(sha, indentDxa) {
      var img = pictureParts[sha];
      if (img === undefined) {
        img = null;
        var bytes = bytesForSync(sha);
        var mime = bytes && sniffImageMime(bytes);
        var dims = mime && imageDims(bytes);
        if (dims && dims.width > 0 && dims.height > 0) {
          img = rels.addImage(bytes, mime);
          img.w = dims.width;
          img.h = dims.height;
        }
        pictureParts[sha] = img;
      }
      if (!img) return docxLineBreakParagraph("[image unavailable]", indentDxa, "<w:i/>");
      var scale = Math.min(9525, (10080 - indentDxa) * 635 * CIMG_MAXW / img.w, CIMG_MAXH / img.h);
      var cx = Math.max(1, Math.round(img.w * scale));
      var cy = Math.max(1, Math.round(img.h * scale));
      return '<w:p><w:pPr><w:spacing w:after="120"/><w:ind w:left="' + indentDxa + '"/></w:pPr>' +
        docxDrawingRun(img, ++drawingId, cx, cy) + '</w:p>';
    }

    function commentBodyXml(entry, indentDxa) {
      var pieces = entry.pieces || [];
      if (!pieces.some(function (p) { return p.image; })) {
        return docxLineBreakParagraph(entry.body || '(empty)', indentDxa, '');
      }
      return pieces.map(function (p) {
        return p.image ? commentPictureXml(p.image, indentDxa) : docxLineBreakParagraph(p.text, indentDxa, '');
      }).join("");
    }

    comments.forEach(function (c) {
      var head = "";
      if (c.number) {
        head += textRunXml(NBSP + c.number + NBSP, { b: true, color: "FFFFFF", sz: 18, shd: PRINT_COLORS.audio }) +
          textRunXml("  ");
      }
      head += textRunXml(c.where, { b: true, color: c.resolved ? PRINT_COLORS.dim : PRINT_COLORS.text }) +
        textRunXml("   " + c.author, { color: PRINT_COLORS.dim, sz: 19 }) +
        (c.when ? textRunXml(" · " + c.when, { color: PRINT_COLORS.faint, sz: 19 }) : "");
      if (c.resolved) head += textRunXml("  ·  Resolved" + (c.resolvedBy ? " by " + c.resolvedBy : ""), { color: PRINT_COLORS.faint, sz: 19 });
      if (c.assignee) head += textRunXml("  ·  Assigned to " + c.assignee, { color: PRINT_COLORS.dim, sz: 19 });
      body += '<w:p><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="100"/></w:pPr>' + head + "</w:p>";
      if (c.quoted) {
        body += '<w:p><w:pPr><w:keepNext/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="' +
          (c.resolved ? PRINT_COLORS.borderStrong : PRINT_COLORS.audio) + '"/></w:pBdr>' +
          '<w:spacing w:after="120"/><w:ind w:left="' + (360 + 180) + '"/></w:pPr>' +
          textRunXml("“" + c.quoted + "”", { i: true, color: PRINT_COLORS.dim }) + "</w:p>";
      }
      body += commentBodyXml(c, 360);
      c.replies.forEach(function (rp) {
        body += '<w:p><w:pPr><w:keepNext/><w:spacing w:before="60" w:after="20"/><w:ind w:left="720"/></w:pPr>' +
          textRunXml("↳ " + rp.author, { b: true, sz: 18 }) +
          (rp.when ? textRunXml(" · " + rp.when, { color: PRINT_COLORS.faint, sz: 18 }) : "") + "</w:p>";
        body += commentBodyXml(rp, 720);
      });
    });
  }

  return packDocx(body, links, media);
}

var THEME_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Splitpage">' +
  '<a:themeElements>' +
  '<a:clrScheme name="Splitpage">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="171613"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="E9E8E4"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="2863AB"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="9E5800"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="00717F"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="764AA2"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="2A7449"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="AB413E"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="1155CC"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="764AA2"/></a:folHlink>' +
  '</a:clrScheme>' +
  '<a:fontScheme name="Splitpage">' +
  '<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="Splitpage">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '</a:lnStyleLst>' +
  '<a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '</a:effectStyleLst>' +
  '<a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:bgFillStyleLst>' +
  '</a:fmtScheme>' +
  '</a:themeElements>' +
  '</a:theme>';

var FOOTER_TITLE_MAX = 90;

function footerXml(title) {
  var rPr = '<w:rPr><w:color w:val="' + PRINT_COLORS.faint + '"/><w:sz w:val="16"/></w:rPr>';
  var t = function (s) { return "<w:r>" + rPr + '<w:t xml:space="preserve">' + xmlEscape(s) + "</w:t></w:r>"; };
  var field = function (name) {
    return "<w:r>" + rPr + '<w:fldChar w:fldCharType="begin"/></w:r>' +
      "<w:r>" + rPr + '<w:instrText xml:space="preserve"> ' + name + " </w:instrText></w:r>" +
      "<w:r>" + rPr + '<w:fldChar w:fldCharType="separate"/></w:r>' + t("1") +
      "<w:r>" + rPr + '<w:fldChar w:fldCharType="end"/></w:r>';
  };
  if (title.length > FOOTER_TITLE_MAX) title = unitSafePrefix(title, FOOTER_TITLE_MAX - 1).replace(/\s+$/, "") + "…";
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="' + PRINT_COLORS.border + '"/></w:pBdr>' +
    '<w:tabs><w:tab w:val="right" w:pos="' + PAGE_W + '"/></w:tabs><w:spacing w:after="0"/>' + rPr + "</w:pPr>" +
    t(title) + "<w:r>" + rPr + "<w:tab/></w:r>" + t("Page ") + field("PAGE") + t(" of ") + field("NUMPAGES") +
    "</w:p></w:ftr>";
}

function corePropsXml(title) {
  var d = new Date();
  var day = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T00:00:00Z";
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + xmlEscape(title) + "</dc:title><dc:creator>Splitpage</dc:creator>" +
    "<cp:lastModifiedBy>Splitpage</cp:lastModifiedBy>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + day + "</dcterms:created>" +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + day + "</dcterms:modified>" +
    "</cp:coreProperties>";
}

var APP_PROPS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
  ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  "<Application>Splitpage</Application></Properties>";

var SETTINGS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  "</w:settings>";

function packDocx(body, links, media) {
  var title = S.state.title || "Untitled Script";
  body += '<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter1"/>' +
    '<w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1260" w:right="1080" w:bottom="1260" w:left="1080" w:header="720" w:footer="600" w:gutter="0"/></w:sectPr>';

  var documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' + body + '</w:body></w:document>';

  var relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
    '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>';
  links.forEach(function (href, idx) {
    relsXml += '<Relationship Id="rIdL' + (idx + 1) + '"' +
      ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"' +
      ' Target="' + xmlEscape(href) + '" TargetMode="External"/>';
  });
  media.forEach(function (m, idx) {
    relsXml += '<Relationship Id="rIdM' + (idx + 1) + '"' +
      ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"' +
      ' Target="media/image' + (idx + 1) + '.' + m.ext + '"/>';
  });
  var extraTypes = "";
  ["png", "gif", "webp"].forEach(function (ext) {
    if (media.some(function (m) { return m.ext === ext; })) {
      extraTypes += '<Default Extension="' + ext + '" ContentType="image/' + ext + '"/>';
    }
  });
  relsXml += '</Relationships>';

  var entries = [
    { name: "[Content_Types].xml", data: strBytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="jpeg" ContentType="image/jpeg"/>' + extraTypes +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
      '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>') },
    { name: "_rels/.rels", data: strBytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>') },
    { name: "docProps/core.xml", data: strBytes(corePropsXml(title)) },
    { name: "docProps/app.xml", data: strBytes(APP_PROPS_XML) },
    { name: "word/document.xml", data: strBytes(documentXml) },
    { name: "word/styles.xml", data: strBytes(STYLES_XML) },
    { name: "word/settings.xml", data: strBytes(SETTINGS_XML) },
    { name: "word/theme/theme1.xml", data: strBytes(THEME_XML) },
    { name: "word/footer1.xml", data: strBytes(footerXml(title)) },
    { name: "word/_rels/document.xml.rels", data: strBytes(relsXml) }
  ];
  media.forEach(function (m, idx) {
    entries.push({ name: "word/media/image" + (idx + 1) + "." + m.ext, data: m.bytes });
  });

  return zipWrite(entries);
}

export var NARRATION_DIRECTIONS_KEY = "splitpage-export-directions";

export function narrationIncludesDirections() {
  return readPref(NARRATION_DIRECTIONS_KEY) !== "0";
}

export function setNarrationIncludesDirections(on) {
  writePref(NARRATION_DIRECTIONS_KEY, on ? null : "0");
}

function narrationTextOpts(opts) {
  var include = opts && typeof opts.directions === "boolean" ? opts.directions : narrationIncludesDirections();
  return include ? { cues: "omit" } : { directions: "omit", cues: "omit" };
}

export function narrationRows(opts) {
  var t = narrationTextOpts(opts);
  return S.state.rows.filter(function (row) { return toPlainText(cellOf(row.audioText), t); });
}

export function buildNarrationText(opts) {
  var t = narrationTextOpts(opts);
  var out = [S.state.title || "Untitled Script", ""];
  narrationRows(opts).forEach(function (row) {
    out.push(toPlainText(cellOf(row.audioText), t).replace(/\n[ \t]*(\n[ \t]*)+/g, "\n"));
    out.push("");
  });
  return out.join("\n");
}

var NARRATION_STYLE = "SplitpageNarration";
var SCENE_NO_STYLE = "SplitpageSceneNo";
var SCENE_NO_HANG = 560;

function groupDigits(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function buildNarrationDocx(opts) {
  var t = narrationTextOpts(opts);
  var links = [];
  var rels = { addLink: function (href) { links.push(href); return "rIdL" + links.length; } };
  var rows = narrationRows(opts);
  var words = rows.reduce(function (n, row) { return n + wordCount(row.audioText); }, 0);
  var wpm = S.state.wordsPerMinute || DEFAULT_WPM;

  var body = titleParaXml(S.state.title || "Untitled Script") +
    metaParaXml(["Narration", plural(rows.length, "scene"), groupDigits(words) + (words === 1 ? " word" : " words"),
      "about " + formatDuration(words / wpm * 60) + " at " + wpm + " wpm"].join(" · "));

  rows.forEach(function (row) {
    var number = pad2(S.state.rows.indexOf(row) + 1);
    body += docxRunsXml(row.audioText, rels, Object.assign({
      pPr: '<w:pStyle w:val="' + NARRATION_STYLE + '"/><w:ind w:left="0" w:hanging="' + SCENE_NO_HANG + '"/>',
      lead: '<w:r><w:rPr><w:rStyle w:val="' + SCENE_NO_STYLE + '"/><w:color w:val="' + PRINT_COLORS.faint + '"/><w:sz w:val="16"/></w:rPr>' +
        '<w:t xml:space="preserve">' + number + "</w:t><w:tab/></w:r>"
    }, t));
  });

  return packDocx(body, links, []);
}

var W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
var R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
var A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

function directChildren(el, localName) {
  return Array.prototype.filter.call(el.childNodes, function (n) {
    return n.nodeType === 1 && n.localName === localName;
  });
}

function docxFlag(props, name) {
  if (!props) return false;
  var el = props.getElementsByTagNameNS(W_NS, name)[0];
  if (!el) return false;
  var val = el.getAttributeNS(W_NS, "val");
  if (val === null || val === undefined) val = el.getAttribute("w:val");
  if (val === null || val === undefined || val === "") return true;
  var v = String(val).toLowerCase();
  return !(v === "0" || v === "false" || v === "none" || v === "off");
}

function runStyleName(rEl) {
  var props = rEl.getElementsByTagNameNS(W_NS, "rPr")[0];
  var rs = props && props.getElementsByTagNameNS(W_NS, "rStyle")[0];
  return rs ? (rs.getAttributeNS(W_NS, "val") || rs.getAttribute("w:val") || "").toLowerCase() : "";
}

function isDroppedRun(rEl) {
  var st = runStyleName(rEl);
  return st === MARKER_STYLE.toLowerCase() || st === SCENE_NO_STYLE.toLowerCase();
}

function colouredUnderline(props) {
  var el = props.getElementsByTagNameNS(W_NS, "u")[0];
  return !!el && !!(el.getAttributeNS(W_NS, "color") || el.getAttribute("w:color"));
}

function docxParaToHtml(pEl, linkMap, opts) {
  var html = "";
  var own = !!(opts && opts.ownExport);
  function runToHtml(rEl, href) {
    if (isDroppedRun(rEl)) return "";
    var props = rEl.getElementsByTagNameNS(W_NS, "rPr")[0];
    var b = false, i = false, u = false, s = false, mark = false, dir = false, chip = false;
    if (props) {
      b = docxFlag(props, "b");
      i = docxFlag(props, "i");
      u = docxFlag(props, "u");
      s = docxFlag(props, "strike");
      mark = docxFlag(props, "highlight");
      var rsv = runStyleName(rEl);
      if (rsv === DIRECTION_STYLE.toLowerCase()) { dir = true; i = false; }
      if (rsv === BROLL_STYLE.toLowerCase()) { b = false; chip = true; }
      if (u && own && colouredUnderline(props)) u = false;
    }
    var piece = "";
    Array.prototype.forEach.call(rEl.childNodes, function (child) {
      if (child.nodeType !== 1) return;
      var ln = child.localName;
      if (ln === "t") piece += escapeHtml(child.textContent || "");
      else if (ln === "br" || ln === "cr") piece += "<br>";
      else if (ln === "tab") piece += " ";
    });
    if (chip) piece = piece.replace(CHIP_PAD_ENDS, "");
    if (!piece) return "";
    if (mark) piece = "<mark>" + piece + "</mark>";
    if (s) piece = "<s>" + piece + "</s>";
    if (u && !href) piece = "<u>" + piece + "</u>";
    if (i) piece = "<em>" + piece + "</em>";
    if (b) piece = "<strong>" + piece + "</strong>";
    if (dir) piece = '<span class="stage-dir">' + piece + "</span>";
    var safe = href ? safeHref(href) : null;
    if (safe) piece = '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener">' + piece + "</a>";
    return piece;
  }

  Array.prototype.forEach.call(pEl.childNodes, function (child) {
    if (child.nodeType !== 1) return;
    if (child.localName === "r") { html += runToHtml(child, null); return; }
    if (child.localName === "hyperlink") {
      var rid = child.getAttributeNS(R_NS, "id");
      var href = rid && linkMap[rid] ? linkMap[rid] : null;
      var runs = child.getElementsByTagNameNS(W_NS, "r");
      for (var k = 0; k < runs.length; k++) html += runToHtml(runs[k], href);
    }
  });
  return html;
}

function paraStyleName(pEl) {
  var pPr = directChildren(pEl, "pPr")[0];
  if (!pPr) return "";
  var st = directChildren(pPr, "pStyle")[0];
  if (!st) return "";
  return (st.getAttributeNS(R_NS, "val") || st.getAttribute("w:val") || st.getAttribute("val") || "").toLowerCase();
}

function isHeadingPara(pEl) {
  return /^heading|^title$/.test(paraStyleName(pEl));
}

function isAllBoldPara(pEl) {
  var runs = pEl.getElementsByTagNameNS(W_NS, "r");
  var sawText = false;
  for (var i = 0; i < runs.length; i++) {
    if (isDroppedRun(runs[i])) continue;
    var texts = runs[i].getElementsByTagNameNS(W_NS, "t");
    var hasText = false;
    for (var j = 0; j < texts.length; j++) {
      if ((texts[j].textContent || "").trim()) { hasText = true; break; }
    }
    if (!hasText) continue;
    sawText = true;
    if (!docxFlag(runs[i].getElementsByTagNameNS(W_NS, "rPr")[0], "b")) return false;
  }
  return sawText;
}

function allEmbedIds(el) {
  return Array.prototype.map.call(el.getElementsByTagNameNS(A_NS, "blip"), function (b) {
    return b.getAttributeNS(R_NS, "embed");
  }).filter(Boolean);
}

function firstEmbedId(el) {
  var blip = el.getElementsByTagNameNS(A_NS, "blip")[0];
  return blip ? blip.getAttributeNS(R_NS, "embed") : null;
}

var VISUAL_HEAD = /^(video|visual|picture|image|shot|shots|action|camera|b-?roll|screen|graphics?)\b/;
var AUDIO_HEAD = /^(audio|voice|vo|narration|narrator|dialogue|dialog|script|line|lines|copy|speech)\b/;

var BREAKDOWN_HEADERS = [
  ["category", "item", "status", "assigned to", "mentions", "scenes", "notes"],
  ["item", "status", "scenes", "assigned to", "notes"]
];
function isBreakdownHeader(head) {
  return BREAKDOWN_HEADERS.some(function (words) {
    return words.length === head.length && words.every(function (w, i) { return head[i] === w; });
  });
}

var EXPORT_TABLE_STYLE = EXPORT_TABLE_STYLE_ID.toLowerCase();
var EXPORT_SECTION_HEADINGS = ["Production breakdown", "B-roll shot list", "Comments"];

function tableStyleName(tblEl) {
  var tblPr = directChildren(tblEl, "tblPr")[0];
  var st = tblPr && directChildren(tblPr, "tblStyle")[0];
  if (!st) return "";
  return (st.getAttributeNS(W_NS, "val") || st.getAttribute("w:val") || "").toLowerCase();
}

function exportTailStart(blocks) {
  var sawExportTable = false;
  for (var i = 0; i < blocks.length; i++) {
    var n = blocks[i];
    if (n.localName === "tbl") {
      if (tableStyleName(n) === EXPORT_TABLE_STYLE) sawExportTable = true;
      continue;
    }
    if (sawExportTable && paraStyleName(n) === "heading1" &&
        EXPORT_SECTION_HEADINGS.indexOf((n.textContent || "").trim()) !== -1) return i;
  }
  return blocks.length;
}

function mapTableColumns(rowsText) {
  var head = (rowsText[0] || []).map(function (t) { return t.toLowerCase().trim(); });
  if (isBreakdownHeader(head)) return null;
  var vi = head.findIndex(function (t) { return VISUAL_HEAD.test(t); });
  var ai = head.findIndex(function (t) { return AUDIO_HEAD.test(t); });
  if (vi !== -1 && ai !== -1 && vi !== ai) return { vi: vi, ai: ai, skipHeader: true };

  var width = 0;
  rowsText.forEach(function (r) { width = Math.max(width, r.length); });
  var used = [];
  for (var c = 0; c < width; c++) {
    var any = rowsText.some(function (r) { return (r[c] || "").trim(); });
    if (any) used.push(c);
  }
  if (used.length < 2) return null;
  return { vi: used[0], ai: used[1], skipHeader: false };
}

export async function docxToRows(file) {
  var zip = await zipRead(await file.arrayBuffer());
  var docBytes = await zip.get("word/document.xml");
  if (!docBytes) throw new Error("no-document-xml");
  var xml = new DOMParser().parseFromString(new TextDecoder().decode(docBytes), "application/xml");
  if (xml.getElementsByTagName("parsererror").length) throw new Error("bad-xml");

  var linkMap = {}, imageMap = {};
  var relBytes = await zip.get("word/_rels/document.xml.rels");
  if (relBytes) {
    var relXml = new DOMParser().parseFromString(new TextDecoder().decode(relBytes), "application/xml");
    Array.prototype.forEach.call(relXml.getElementsByTagName("Relationship"), function (rel) {
      var type = rel.getAttribute("Type") || "";
      if (type.indexOf("/hyperlink") !== -1) linkMap[rel.getAttribute("Id")] = rel.getAttribute("Target");
      else if (type.indexOf("/image") !== -1) imageMap[rel.getAttribute("Id")] = rel.getAttribute("Target");
    });
  }

  var bodyEl = xml.getElementsByTagNameNS(W_NS, "body")[0];
  if (!bodyEl) throw new Error("no-body");

  var blocks = Array.prototype.filter.call(bodyEl.childNodes, function (n) {
    return n.nodeType === 1 && (n.localName === "p" || n.localName === "tbl");
  });
  var ownExport = blocks.some(function (n) {
    return n.localName === "tbl" ? tableStyleName(n) === EXPORT_TABLE_STYLE : paraStyleName(n) === META_STYLE.toLowerCase();
  });
  var paraOpts = { ownExport: ownExport };
  blocks = blocks.slice(0, exportTailStart(blocks)).filter(function (n) {
    return !(n.localName === "p" && paraStyleName(n) === META_STYLE.toLowerCase());
  });

  var loose = blocks.filter(function (n) { return n.localName === "p" && !isHeadingPara(n); });
  var withText = loose.filter(function (n) { return htmlToPlainText(docxParaToHtml(n, linkMap, paraOpts)); });
  var boldCount = withText.filter(isAllBoldPara).length;
  var boldMeansVisual = boldCount > 0 && boldCount < withText.length * 0.7;

  var rows = [], title = null, pending = null;

  function flush() {
    if (pending) { rows.push(pending); pending = null; }
  }
  function newRow(fields) {
    return {
      id: makeId(),
      visualText: fields.visualText || "",
      imageRef: null,
      audioText: fields.audioText || "",
      _pendingImage: fields._pendingImage || null,
      _pendingMore: fields._pendingMore || null,
      _links: fields._links || null
    };
  }

  blocks.forEach(function (node) {
    if (node.localName === "tbl") {
      flush();
      var trs = directChildren(node, "tr");
      var cellHtml = [], cellEls = [], cellLinks = [];
      for (var t = 0; t < trs.length; t++) {
        var tcs = directChildren(trs[t], "tc");
        var rowLinks = [];
        cellEls.push(tcs);
        cellLinks.push(rowLinks);
        cellHtml.push(tcs.map(function (tc) {
          var parts = [];
          directChildren(tc, "p").forEach(function (pEl) {
            var vl = docxVideoLinksOf(pEl, linkMap);
            if (vl) { vl.forEach(function (l) { rowLinks.push(l); }); return; }
            var h = docxParaToHtml(pEl, linkMap, paraOpts);
            if (h) parts.push(h);
          });
          return parts.join("<br>");
        }));
      }
      var mapping = mapTableColumns(cellHtml.map(function (r) {
        return r.map(function (h) { return htmlToPlainText(h); });
      }));
      if (!mapping) return;

      for (var i = mapping.skipHeader ? 1 : 0; i < cellHtml.length; i++) {
        var v = cellHtml[i][mapping.vi] || "";
        var a = cellHtml[i][mapping.ai] || "";
        var targets = [];
        for (var c = 0; c < cellEls[i].length; c++) {
          allEmbedIds(cellEls[i][c]).forEach(function (id) {
            if (imageMap[id] && targets.indexOf(imageMap[id]) === -1) targets.push(imageMap[id]);
          });
        }
        if (!htmlToPlainText(v) && !htmlToPlainText(a) && !targets.length && !cellLinks[i].length) continue;
        rows.push(newRow({
          visualText: v, audioText: a,
          _pendingImage: targets[0] || null,
          _pendingMore: targets.length > 1 ? targets.slice(1) : null,
          _links: cellLinks[i].length ? cellLinks[i] : null
        }));
      }
      return;
    }

    var html = docxParaToHtml(node, linkMap, paraOpts);
    var plain = htmlToPlainText(html);
    var embedId = firstEmbedId(node);
    var target = embedId && imageMap[embedId] ? imageMap[embedId] : null;
    if (!plain && !target) return;

    if (isHeadingPara(node)) {
      if (title === null && !rows.length && !pending) { title = plain; return; }
      flush();
      rows.push(newRow({ visualText: "<strong>" + html + "</strong>" }));
      return;
    }

    if (target) {
      if (pending && !pending.imageRef && !pending._pendingImage) {
        pending._pendingImage = target;
        if (plain) pending.visualText = pending.visualText ? pending.visualText + "<br>" + html : html;
      } else {
        flush();
        pending = newRow({ visualText: plain ? html : "", _pendingImage: target });
      }
      return;
    }

    var bracketed = /^\s*[[(].*[\])]\s*$/.test(plain) && plain.length < 200;
    if ((boldMeansVisual && isAllBoldPara(node)) || bracketed) {
      flush();
      pending = newRow({ visualText: html });
      return;
    }

    if (pending && !pending.audioText) {
      pending.audioText = html;
      flush();
    } else {
      flush();
      rows.push(newRow({ audioText: html }));
    }
  });
  flush();

  async function pictureAt(target) {
    try {
      var path = target.indexOf("/") === 0 ? target.slice(1) : "word/" + target;
      var imgBytes = await zip.get(path);
      if (!imgBytes) return null;
      var raw = bytesToDataUrl(imgBytes, mimeForPath(path));
      var rec = internDataUrl(await toJpegDataUrl(raw));
      if (rec) queuePersist([rec.sha256]);
      return rec;
    } catch (e) { return null; }
  }
  for (var ri = 0; ri < rows.length; ri++) {
    var pendingTarget = rows[ri]._pendingImage;
    var pendingMore = rows[ri]._pendingMore || [];
    var pendingLinks = rows[ri]._links;
    delete rows[ri]._pendingImage;
    delete rows[ri]._pendingMore;
    delete rows[ri]._links;
    if (pendingTarget) rows[ri].imageRef = await pictureAt(pendingTarget);
    var more = [];
    for (var mi = 0; mi < pendingMore.length; mi++) {
      var mrec = await pictureAt(pendingMore[mi]);
      if (mrec) more.push({ imageRef: mrec });
    }
    (pendingLinks || []).forEach(function (l) { more.push({ links: [Object.assign({}, l, { poster: true })] }); });
    if (more.length) rows[ri].moreImages = more;
    rows[ri].audioText = audioDirectionsHtml(rows[ri].audioText);
    rows[ri].visualText = noDirectionsHtml(rows[ri].visualText);
  }

  return { title: title, rows: rows, looseText: "" };
}

export function audioDirectionsHtml(html) {
  if (!html) return html;
  var dirs = html.indexOf("((") !== -1 || html.indexOf("stage-dir") !== -1;
  var cues = /(sfx|music)[ \t\u00a0]*:/i.test(html);
  if (!dirs && !cues) return html;
  var c = fromHtml(html);
  if (dirs) c = importDirections(c);
  if (cues) c = importCues(c);
  return toHtml(c);
}

function noDirectionsHtml(html) {
  if (!html || (html.indexOf("stage-dir") === -1 && html.indexOf("audio-cue") === -1)) return html;
  var c = fromHtml(html);
  return toHtml(flattenCues(setMark(c, 0, cellLength(c), "dir", false)));
}

function toJpegDataUrl(dataUrl) {
  return new Promise(function (resolve) {
    if (!dataUrl) { resolve(null); return; }
    if (dataUrl.indexOf("data:image/jpeg") === 0) { resolve(dataUrl); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var scale = Math.min(1, 1000 / Math.max(img.width, img.height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      } catch (e) { resolve(null); }
    };
    img.onerror = function () { resolve(null); };
    img.src = dataUrl;
  });
}

function mimeForPath(path) {
  var ext = (/\.([a-z0-9]+)$/i.exec(path) || ["", ""])[1].toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function bytesToDataUrl(bytes, mime) {
  var bin = "", CHUNK = 0x8000;
  for (var i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return "data:" + mime + ";base64," + btoa(bin);
}

export function __init() {
  var C = PRINT_COLORS;
  var font = function (which) {
    return '<w:rFonts w:asciiTheme="' + which + 'HAnsi" w:hAnsiTheme="' + which + 'HAnsi" w:cstheme="' + which + 'HAnsi"/>';
  };
  var charStyle = function (id, name, rPr) {
    return '<w:style w:type="character" w:customStyle="1" w:styleId="' + id + '"><w:name w:val="' + name + '"/>' +
      "<w:rPr>" + rPr + "</w:rPr></w:style>";
  };
  var paraStyle = function (id, name, pPr, rPr, custom) {
    return '<w:style w:type="paragraph"' + (custom ? ' w:customStyle="1"' : "") + ' w:styleId="' + id + '"><w:name w:val="' + name + '"/>' +
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      "<w:pPr>" + pPr + "</w:pPr><w:rPr>" + rPr + "</w:rPr></w:style>";
  };

  STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults>' +
    "<w:rPrDefault><w:rPr>" + font("minor") +
    '<w:color w:val="' + C.text + '"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/>' +
    "</w:rPr></w:rPrDefault>" +
    '<w:pPrDefault><w:pPr><w:widowControl/><w:spacing w:after="160" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    "</w:docDefaults>" +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    paraStyle("Title", "Title", '<w:keepNext/><w:spacing w:after="80" w:line="240" w:lineRule="auto"/>',
      font("major") + '<w:b/><w:sz w:val="40"/><w:szCs w:val="40"/>') +
    paraStyle(META_STYLE, "Document details", '<w:keepNext/><w:spacing w:after="360"/>',
      '<w:color w:val="' + C.dim + '"/><w:sz w:val="18"/><w:szCs w:val="18"/>', true) +
    paraStyle("Heading1", "heading 1", '<w:keepNext/><w:keepLines/><w:spacing w:before="480" w:after="80"/><w:outlineLvl w:val="0"/>',
      font("major") + '<w:b/><w:sz w:val="28"/><w:szCs w:val="28"/>') +
    paraStyle(NARRATION_STYLE, "Narration", '<w:spacing w:after="200" w:line="360" w:lineRule="auto"/>',
      '<w:sz w:val="24"/><w:szCs w:val="24"/>', true) +
    charStyle(DIRECTION_STYLE, "Stage direction", '<w:i/><w:color w:val="' + DIRECTION_COLOR + '"/>') +
    charStyle(CUE_STYLE, "Sound cue", '<w:color w:val="' + CUE_COLOR + '"/><w:sz w:val="' + CUE_SIZE + '"/>') +
    charStyle(TAG_STYLE, "Production tag", '<w:u w:val="single"/>') +
    charStyle(MARKER_STYLE, "Comment marker", '<w:b/><w:color w:val="' + C.audio + '"/><w:position w:val="6"/>' +
      '<w:sz w:val="' + MARKER_SIZE + '"/><w:bdr w:val="single" w:sz="4" w:space="0" w:color="' + C.audio + '"/>') +
    charStyle(BROLL_STYLE, "B-roll key", '<w:b/><w:color w:val="' + C.broll + '"/><w:sz w:val="' + BROLL_SIZE + '"/>' +
      '<w:bdr w:val="single" w:sz="4" w:space="0" w:color="' + C.broll + '"/>') +
    charStyle(SCENE_NO_STYLE, "Scene number", '<w:color w:val="' + C.faint + '"/><w:sz w:val="16"/>') +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
      '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/>' +
      '<w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '<w:style w:type="table" w:styleId="' + EXPORT_TABLE_STYLE_ID + '"><w:name w:val="Splitpage Table"/>' +
      '<w:basedOn w:val="TableNormal"/>' +
      "<w:tblPr>" + tableBordersXml() +
      '<w:tblCellMar><w:top w:w="110" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>' +
      '<w:bottom w:w="130" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>' +
      "</w:tblPr>" +
      '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr></w:tblStylePr>' +
      "</w:style>" +
    "</w:styles>";
}
