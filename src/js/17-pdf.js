import { S } from "./_state.js";
import { bytesForSync, recordFor, rowImageBytes } from "./02c-blobs.js";
import { morePictureRefs, pictureBytes, rowVideoLinks, videoLinkText } from "./02d-gallery.js";
import { videoHostLabel } from "./05-render.js";
import { TAG_STATUSES, tagCategory } from "./07-production-tags.js";
import { brollShotListForPrint } from "./08d-broll-panel.js";
import { commentEntries } from "./10-comments.js";
import { concatBytes, latin1Bytes, tagPrintColor } from "./14-export.js";
import {
  PRINT_COLORS,
  STATUS_PRINT,
  TAG_STATUS_PRINT,
  breakdownGroups,
  commentNumbers,
  exportComments,
  exportDateText,
  exportFacts,
  exportRuns,
  exportSummaryParts,
  sceneFacts
} from "./14b-export-kit.js";
import { jpegSize, safeAspect } from "./15-docx.js";
import { sniffImageMime } from "../../shared/blob-policy.js";

var HELV_W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
var HELVB_W = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// Base-14 fonts are WinAnsi only
var WINANSI_MAP = { "—": 151, "–": 150, "‘": 145, "’": 146, "“": 147, "”": 148, "…": 133, "•": 149, " ": 32 };

function pdfEncodeChar(ch) {
  if (WINANSI_MAP[ch] !== undefined) return WINANSI_MAP[ch];
  var code = ch.charCodeAt(0);
  if (code >= 32 && code <= 255) return code;
  return 63;
}

var HELV_HIGH = { 133: 1000, 145: 222, 146: 222, 147: 333, 148: 333, 149: 350, 150: 556, 151: 1000, 183: 278 };
var HELVB_HIGH = { 133: 1000, 145: 278, 146: 278, 147: 500, 148: 500, 149: 350, 150: 556, 151: 1000, 183: 278 };

function pdfCharWidth(ch, bold) {
  var code = pdfEncodeChar(ch);
  if (code >= 32 && code <= 126) return (bold ? HELVB_W : HELV_W)[code - 32];
  var high = (bold ? HELVB_HIGH : HELV_HIGH)[code];
  if (high !== undefined) return high;
  return bold ? 611 : 556;
}

export function pdfTextWidth(text, bold, size) {
  var w = 0;
  for (var i = 0; i < text.length; i++) w += pdfCharWidth(text[i], bold);
  return w * size / 1000;
}

export function pdfEscapeText(s) {
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var code = pdfEncodeChar(s[i]);
    var ch = String.fromCharCode(code);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else out += ch;
  }
  return out;
}

export function pdfRgb(hex) {
  return [0, 2, 4].map(function (i) { return (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3); }).join(" ");
}

export function pdfCirclePath(cx, cy, r) {
  var k = r * 0.5523;
  function p(x, y) { return x.toFixed(2) + " " + y.toFixed(2); }
  return p(cx + r, cy) + " m " +
    p(cx + r, cy + k) + " " + p(cx + k, cy + r) + " " + p(cx, cy + r) + " c " +
    p(cx - k, cy + r) + " " + p(cx - r, cy + k) + " " + p(cx - r, cy) + " c " +
    p(cx - r, cy - k) + " " + p(cx - k, cy - r) + " " + p(cx, cy - r) + " c " +
    p(cx + k, cy - r) + " " + p(cx + r, cy - k) + " " + p(cx + r, cy) + " c h";
}

function n2(v) { return (+v).toFixed(2); }

export function pdfTextOp(str, x, y, font, size, hex) {
  var op = "BT /" + font + " " + size + " Tf 1 0 0 1 " + n2(x) + " " + n2(y) +
    " Tm (" + pdfEscapeText(str) + ") Tj ET";
  return hex ? "q " + pdfRgb(hex) + " rg " + op + " Q" : op;
}

export function pdfRoundRectPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  var k = r * 0.5523;
  return n2(x + r) + " " + n2(y) + " m " +
    n2(x + w - r) + " " + n2(y) + " l " +
    n2(x + w - r + k) + " " + n2(y) + " " + n2(x + w) + " " + n2(y + r - k) + " " + n2(x + w) + " " + n2(y + r) + " c " +
    n2(x + w) + " " + n2(y + h - r) + " l " +
    n2(x + w) + " " + n2(y + h - r + k) + " " + n2(x + w - r + k) + " " + n2(y + h) + " " + n2(x + w - r) + " " + n2(y + h) + " c " +
    n2(x + r) + " " + n2(y + h) + " l " +
    n2(x + r - k) + " " + n2(y + h) + " " + n2(x) + " " + n2(y + h - r + k) + " " + n2(x) + " " + n2(y + h - r) + " c " +
    n2(x) + " " + n2(y + r) + " l " +
    n2(x) + " " + n2(y + r - k) + " " + n2(x + r - k) + " " + n2(y) + " " + n2(x + r) + " " + n2(y) + " c h";
}

export function pdfRuleOp(x1, y, x2, hex, width) {
  return "q " + pdfRgb(hex) + " RG " + (width || 0.5) + " w " + n2(x1) + " " + n2(y) + " m " + n2(x2) + " " + n2(y) + " l S Q";
}

export function pdfLampOp(kind, cx, cy, r, hex) {
  var c = pdfRgb(hex);
  if (kind === "fill") return "q " + c + " rg " + pdfCirclePath(cx, cy, r) + " f Q";
  if (kind === "outline") return "q " + c + " RG 0.9 w " + pdfCirclePath(cx, cy, r - 0.45) + " S Q";
  if (kind === "ring") {
    return "q " + c + " RG 0.7 w " + pdfCirclePath(cx, cy, r - 0.35) + " S " + c + " rg " +
      pdfCirclePath(cx, cy, r * 0.32) + " f Q";
  }
  if (kind === "half") {
    var k = r * 0.5523;
    return "q " + c + " RG 0.9 w " + pdfCirclePath(cx, cy, r - 0.45) + " S " + c + " rg " +
      n2(cx) + " " + n2(cy + r) + " m " +
      n2(cx - k) + " " + n2(cy + r) + " " + n2(cx - r) + " " + n2(cy + k) + " " + n2(cx - r) + " " + n2(cy) + " c " +
      n2(cx - r) + " " + n2(cy - k) + " " + n2(cx - k) + " " + n2(cy - r) + " " + n2(cx) + " " + n2(cy - r) + " c h f Q";
  }
  return "q " + c + " rg " + pdfCirclePath(cx, cy, r) + " f 1 1 1 RG " + n2(r * 0.32) + " w 1 J 1 j " +
    n2(cx - r * 0.45) + " " + n2(cy + r * 0.02) + " m " + n2(cx - r * 0.1) + " " + n2(cy - r * 0.34) + " l " +
    n2(cx + r * 0.48) + " " + n2(cy + r * 0.36) + " l S Q";
}

export function pdfCheckboxOp(x, y, size, ticked, boxHex, tickHex) {
  var op = "q " + pdfRgb(boxHex || "64635E") + " RG 0.9 w " + pdfRoundRectPath(x, y, size, size, size * 0.18) + " S Q";
  if (ticked) {
    op += " q " + pdfRgb(tickHex || "00717F") + " RG " + n2(size * 0.16) + " w 1 J 1 j " +
      n2(x + size * 0.2) + " " + n2(y + size * 0.5) + " m " + n2(x + size * 0.43) + " " + n2(y + size * 0.24) + " l " +
      n2(x + size * 0.84) + " " + n2(y + size * 0.82) + " l S Q";
  }
  return op;
}

export function pdfFooterOps(title, pageNo, pageCount, PW, M, y, hex, ruleHex) {
  var size = 7.5;
  var right = "Page " + pageNo + " of " + pageCount;
  var room = PW - 2 * M - pdfTextWidth(right, false, size) - 24;
  var t = String(title || "");
  if (pdfTextWidth(t, false, size) > room) {
    while (t.length > 1 && pdfTextWidth(t + "…", false, size) > room) t = t.slice(0, -1);
    t = t.replace(/\s+$/, "") + "…";
  }
  return [
    pdfRuleOp(M, y + 11, PW - M, ruleHex || "DCDAD4", 0.5),
    pdfTextOp(t, M, y, "F1", size, hex || "64635E"),
    pdfTextOp(right, PW - M - pdfTextWidth(right, false, size), y, "F1", size, hex || "64635E")
  ];
}

function pdfInfoString(s) {
  s = String(s || "");
  if (/^[\x20-\x7e]*$/.test(s)) return "(" + s.replace(/([()\\])/g, "\\$1") + ")";
  var hex = "FEFF";
  for (var i = 0; i < s.length; i++) hex += ("000" + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
  return "<" + hex + ">";
}

function pdfDate(d) {
  function p(v) { return (v < 10 ? "0" : "") + v; }
  return "D:" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

export function assemblePdf(spec) {
  var PW = spec.size[0], PH = spec.size[1];
  var pages = spec.pages, images = spec.images || [];
  var chunks = [], offsets = [], length = 0;
  function put(data) {
    var bytes = typeof data === "string" ? latin1Bytes(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  }
  function startObj(num) { offsets[num] = length; put(num + " 0 obj\n"); }

  var numPages = pages.length;
  var OBJ_CATALOG = 1, OBJ_PAGES = 2, OBJ_F1 = 3, OBJ_F2 = 4, OBJ_F3 = 5, OBJ_F4 = 6, OBJ_INFO = 7;
  var firstPageObj = 8;
  var contentObjBase = firstPageObj + numPages;
  var imageObjBase = contentObjBase + numPages;
  var next = imageObjBase + images.length;
  var annotObjs = pages.map(function (pg) {
    return (pg.links || []).map(function () { return next++; });
  });
  var outline = (spec.outline || []).filter(function (o) { return o && o.page >= 0 && o.page < numPages; });
  var outlineRoot = outline.length ? next++ : 0;
  var outlineItems = outline.map(function () { return next++; });
  var totalObjs = next - 1;

  put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  startObj(OBJ_CATALOG);
  put("<< /Type /Catalog /Pages " + OBJ_PAGES + " 0 R /ViewerPreferences << /DisplayDocTitle true >>" +
    (outlineRoot ? " /Outlines " + outlineRoot + " 0 R /PageMode /UseOutlines" : "") + " >>\nendobj\n");

  startObj(OBJ_PAGES);
  var kids = [];
  for (var i = 0; i < numPages; i++) kids.push((firstPageObj + i) + " 0 R");
  put("<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + numPages + " >>\nendobj\n");

  [[OBJ_F1, "Helvetica"], [OBJ_F2, "Helvetica-Bold"],
   [OBJ_F3, "Helvetica-Oblique"], [OBJ_F4, "Helvetica-BoldOblique"]].forEach(function (f) {
    startObj(f[0]);
    put("<< /Type /Font /Subtype /Type1 /BaseFont /" + f[1] + " /Encoding /WinAnsiEncoding >>\nendobj\n");
  });

  var info = spec.info || {};
  startObj(OBJ_INFO);
  put("<< " + (info.title ? "/Title " + pdfInfoString(info.title) + " " : "") +
    "/Creator (Splitpage) /Producer (Splitpage) /CreationDate (" + pdfDate(info.date || new Date()) + ") >>\nendobj\n");

  pages.forEach(function (pg, idx) {
    startObj(firstPageObj + idx);
    var xobj = "";
    if (pg.images && pg.images.length) {
      xobj = " /XObject << " + pg.images.map(function (name) {
        var oi = images.findIndex(function (im) { return im.name === name; });
        return "/" + name + " " + (imageObjBase + oi) + " 0 R";
      }).join(" ") + " >>";
    }
    var annots = annotObjs[idx].length ? " /Annots [" + annotObjs[idx].map(function (o) { return o + " 0 R"; }).join(" ") + "]" : "";
    var box = pg.size || [PW, PH];
    put("<< /Type /Page /Parent " + OBJ_PAGES + " 0 R /MediaBox [0 0 " + box[0] + " " + box[1] + "]" +
      " /Resources << /Font << /F1 " + OBJ_F1 + " 0 R /F2 " + OBJ_F2 + " 0 R" +
      " /F3 " + OBJ_F3 + " 0 R /F4 " + OBJ_F4 + " 0 R >>" + xobj + " >>" + annots +
      " /Contents " + (contentObjBase + idx) + " 0 R >>\nendobj\n");
  });

  pages.forEach(function (pg, idx) {
    var stream = pg.ops.join("\n");
    startObj(contentObjBase + idx);
    put("<< /Length " + latin1Bytes(stream).length + " >>\nstream\n");
    put(stream);
    put("\nendstream\nendobj\n");
  });

  images.forEach(function (im, idx) {
    startObj(imageObjBase + idx);
    put("<< /Type /XObject /Subtype /Image /Width " + im.w + " /Height " + im.h +
      " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + im.bytes.length + " >>\nstream\n");
    put(im.bytes);
    put("\nendstream\nendobj\n");
  });

  pages.forEach(function (pg, idx) {
    (pg.links || []).forEach(function (l, k) {
      startObj(annotObjs[idx][k]);
      put("<< /Type /Annot /Subtype /Link /Rect [" + [l.x, l.y, l.x + l.w, l.y + l.h].map(n2).join(" ") + "]" +
        " /Border [0 0 0] /A << /S /URI /URI " + pdfInfoString(l.uri) + " >> >>\nendobj\n");
    });
  });

  if (outlineRoot) {
    startObj(outlineRoot);
    put("<< /Type /Outlines /First " + outlineItems[0] + " 0 R /Last " + outlineItems[outlineItems.length - 1] +
      " 0 R /Count " + outlineItems.length + " >>\nendobj\n");
    outline.forEach(function (o, k) {
      startObj(outlineItems[k]);
      put("<< /Title " + pdfInfoString(o.title) + " /Parent " + outlineRoot + " 0 R" +
        (k > 0 ? " /Prev " + outlineItems[k - 1] + " 0 R" : "") +
        (k < outline.length - 1 ? " /Next " + outlineItems[k + 1] + " 0 R" : "") +
        " /Dest [" + (firstPageObj + o.page) + " 0 R /XYZ 0 " + n2(o.y == null ? PH : o.y) + " 0] >>\nendobj\n");
    });
  }

  var xrefAt = length;
  var xref = "xref\n0 " + (totalObjs + 1) + "\n0000000000 65535 f \n";
  for (var o = 1; o <= totalObjs; o++) {
    var off = offsets[o] || 0;
    xref += ("0000000000" + off).slice(-10) + " 00000 n \n";
  }
  put(xref);
  put("trailer\n<< /Size " + (totalObjs + 1) + " /Root " + OBJ_CATALOG + " 0 R /Info " + OBJ_INFO + " 0 R >>\nstartxref\n" + xrefAt + "\n%%EOF\n");

  return concatBytes(chunks);
}

var CUE_SCALE = 0.85;

export function pdfWrapRuns(runs, maxWidth, size, opts) {
  var lines = [], line = [], lineWidth = 0;
  var markerWidth = opts && opts.markerWidth;

  function pushLine() { lines.push(line); line = []; lineWidth = 0; }

  runs.forEach(function (run) {
    if (run.dir) run = Object.assign({}, run, { i: true });
    var sz = run.cue ? size * CUE_SCALE : size;
    var seg = function (text, width) {
      var s = { text: text, b: run.b, i: run.i, u: run.u, s: run.s, mark: run.mark, width: width };
      if (run.dir) s.dir = true;
      if (run.cue) s.cue = true;
      if (run.href) s.href = run.href;
      if (run.tag) s.tag = run.tag;
      if (run.cmt) s.cmt = run.cmt;
      if (run.broll) s.broll = run.broll;
      return s;
    };
    var lastWord = null;
    if (run.text === "\n") { pushLine(); return; }
    var words = run.text.split(/(\s+)/);
    words.forEach(function (word) {
      if (!word) return;
      var isSpace = /^\s+$/.test(word);
      if (isSpace && !line.length) return;
      var w = pdfTextWidth(word, run.b, sz);
      if (!isSpace && lineWidth + w > maxWidth && line.length) pushLine();
      if (!isSpace && w > maxWidth) {
        var chunk = "";
        for (var i = 0; i < word.length; i++) {
          if (pdfTextWidth(chunk + word[i], run.b, sz) > maxWidth && chunk) {
            line.push(seg(chunk, pdfTextWidth(chunk, run.b, sz)));
            pushLine();
            chunk = "";
          }
          chunk += word[i];
        }
        if (chunk) {
          var cw = pdfTextWidth(chunk, run.b, sz);
          lastWord = seg(chunk, cw);
          line.push(lastWord);
          lineWidth += cw;
        }
        return;
      }
      var piece = seg(word, w);
      if (!isSpace) lastWord = piece;
      line.push(piece);
      lineWidth += w;
    });
    if (run.markers && lastWord) {
      var extra = markerWidth ? markerWidth(run.markers) : 0;
      lastWord.markers = run.markers;
      lastWord.markerWidth = extra;
      var at = line.indexOf(lastWord);
      if (at !== -1) {
        lineWidth += extra;
        if (lineWidth > maxWidth && at > 0) {
          var moved = line.splice(at);
          lineWidth = line.reduce(function (n, x) { return n + x.width; }, 0);
          while (line.length && /^\s+$/.test(line[line.length - 1].text)) lineWidth -= line.pop().width;
          pushLine();
          moved.forEach(function (x) { line.push(x); lineWidth += x.width; });
          lineWidth += extra;
        }
      }
    }
  });
  if (line.length) pushLine();
  return lines;
}

var PDF_IMAGE_MAX_PX = 2000;

function pdfJpegOf(pic) {
  if (!pic) return Promise.resolve(null);
  // Use coded size; EXIF-rotated width/height would lie
  if (pic.mime === "image/jpeg") return Promise.resolve({ bytes: pic.bytes, size: jpegSize(pic.bytes) });
  return new Promise(function (resolve) {
    var url;
    try { url = URL.createObjectURL(new Blob([pic.bytes], { type: pic.mime })); } catch (e) { resolve(null); return; }
    var img = new Image();
    function done(v) {
      try { URL.revokeObjectURL(url); } catch (e) {}
      resolve(v);
    }
    img.onload = function () {
      try {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, PDF_IMAGE_MAX_PX / Math.max(w, h, 1));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          if (!blob) { done(null); return; }
          blob.arrayBuffer().then(function (ab) {
            var bytes = new Uint8Array(ab);
            done({ bytes: bytes, size: jpegSize(bytes) });
          }, function () { done(null); });
        }, "image/jpeg", 0.9);
      } catch (e) { done(null); }
    };
    img.onerror = function () { done(null); };
    img.src = url;
  });
}

export function pdfImagesFor(rows) {
  rows = rows || [];
  var first = Promise.all(rows.map(function (row) {
    return pdfJpegOf(rowImageBytes(row)).then(null, function () { return null; });
  }));
  var more = Promise.all(rows.map(function (row) {
    return Promise.all(morePictureRefs(row).map(function (ref) {
      return pdfJpegOf(pictureBytes(ref)).then(null, function () { return null; });
    })).then(function (list) { return list.filter(Boolean); });
  }));
  return Promise.all([first, more]).then(function (both) {
    both[0].more = both[1];
    return both[0];
  });
}

function commentPic(sha) {
  var bytes = bytesForSync(sha);
  if (!bytes) return null;
  var rec = recordFor(sha);
  var mime = sniffImageMime(bytes) || (rec && rec.mime);
  return mime ? { bytes: bytes, mime: mime } : null;
}

function commentImageShas(entries) {
  var out = [], seen = {};
  function add(pieces) {
    (pieces || []).forEach(function (p) {
      if (p.image && !seen[p.image]) { seen[p.image] = true; out.push(p.image); }
    });
  }
  entries.forEach(function (c) {
    add(c.pieces);
    c.replies.forEach(function (rp) { add(rp.pieces); });
  });
  return out;
}

export function pdfCommentImagesFor() {
  var shas = commentImageShas(commentEntries({ pieces: true }));
  return Promise.all(shas.map(function (sha) {
    return pdfJpegOf(commentPic(sha)).then(null, function () { return null; });
  })).then(function (list) {
    var out = {};
    shas.forEach(function (sha, i) { out[sha] = list[i]; });
    return out;
  });
}

function pdfBubblePath(x, y, w, h, r, low) {
  var kr = r * 0.5523, kl = low * 0.5523;
  return n2(x + low) + " " + n2(y) + " m " +
    n2(x + w - r) + " " + n2(y) + " l " +
    n2(x + w - r + kr) + " " + n2(y) + " " + n2(x + w) + " " + n2(y + r - kr) + " " + n2(x + w) + " " + n2(y + r) + " c " +
    n2(x + w) + " " + n2(y + h - r) + " l " +
    n2(x + w) + " " + n2(y + h - r + kr) + " " + n2(x + w - r + kr) + " " + n2(y + h) + " " + n2(x + w - r) + " " + n2(y + h) + " c " +
    n2(x + r) + " " + n2(y + h) + " l " +
    n2(x + r - kr) + " " + n2(y + h) + " " + n2(x) + " " + n2(y + h - r + kr) + " " + n2(x) + " " + n2(y + h - r) + " c " +
    n2(x) + " " + n2(y + low) + " l " +
    n2(x) + " " + n2(y + low - kl) + " " + n2(x + low - kl) + " " + n2(y) + " " + n2(x + low) + " " + n2(y) + " c h";
}

function pdfFitText(str, bold, size, width) {
  str = String(str || "");
  if (pdfTextWidth(str, bold, size) <= width) return str;
  while (str.length > 1 && pdfTextWidth(str + "…", bold, size) > width) str = str.slice(0, -1);
  var sp = str.lastIndexOf(" ");
  if (sp > str.length * 0.7) str = str.slice(0, sp);
  return str.replace(/[\s,;:]+$/, "") + "…";
}

function pdfAddress(href) {
  return String(href).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function pdfCount(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

export function buildPdf(jpegs, commentJpegs) {
  var PW = 612, PH = 792, M = 54;
  var C = PRINT_COLORS;
  var TW = PW - 2 * M;
  var GUT = 46, VW = 184, GAP = 14, RW = 32;
  var VX = M + GUT, AX = VX + VW + GAP, AW = PW - M - RW - AX;
  var VS = 9, VL = 12.5, AS = 10, AL = 14;
  var SIZE = 9.5, LEAD = 13;
  var ROW_GAP = 10, TOPB = 10, TAIL = 14, PIC_GAP = 8, EMPTY = 4;
  var HEADS_H = 13 + ROW_GAP;
  var ROW_TOP = PH - M - HEADS_H;
  var PAGE_ROOM = ROW_TOP - M;
  var FOOT_Y = 28;
  var READ_R = PW - M - 3.5;
  var CUE = tagPrintColor("sound") || "AB413E";
  var HIGHLIGHT = "FCE38A";

  var facts = exportFacts();
  var scenes = sceneFacts();
  var nums = commentNumbers();
  var title = facts.title;

  var pages = [];
  var ops = [];
  var images = [];
  var pageImages = [];
  var pageLinks = [];
  var outline = [{ title: "Script", page: 0, y: PH }];
  var y = 0;

  function newPage() {
    if (ops.length) pages.push({ ops: ops, images: pageImages, links: pageLinks });
    ops = [pdfRgb(C.text) + " rg"];
    pageImages = [];
    pageLinks = [];
    y = PH - M;
  }

  function fontFor(seg) {
    if (seg.b && seg.i) return "F4";
    if (seg.b) return "F2";
    if (seg.i) return "F3";
    return "F1";
  }

  function text(str, x, yy, font, size, hex) { ops.push(pdfTextOp(str, x, yy, font, size, hex)); }
  function fill(hex, path) { ops.push("q " + pdfRgb(hex) + " rg " + path + " f Q"); }
  function stroke(hex, width, path) { ops.push("q " + pdfRgb(hex) + " RG " + width + " w " + path + " S Q"); }
  function bar(x, yy, w, h, hex) {
    ops.push("q " + pdfRgb(hex) + " rg " + x.toFixed(2) + " " + yy.toFixed(2) + " " +
      w.toFixed(2) + " " + h.toFixed(2) + " re f Q");
  }

  var MK_SIZE = 6, MK_PAD = 2, MK_H = 7.8, MK_GAP = 1.5;
  function markerW(n) { return Math.max(8, pdfTextWidth(String(n), false, MK_SIZE) + 2 * MK_PAD); }
  function markersWidth(markers) {
    return markers.reduce(function (w, n) { return w + MK_GAP + markerW(n); }, 0);
  }
  var WRAP = { markerWidth: markersWidth };

  function cellRuns(html) {
    return exportRuns(html, nums).map(function (r) {
      return r.broll ? Object.assign({}, r, { text: "B-roll" }) : r;
    });
  }

  var CHIP_SIZE = 6.5, CHIP_PAD = 2.4;
  function chip(x, b, room) {
    var tw = pdfTextWidth("B-roll", false, CHIP_SIZE);
    var w = Math.min(room, tw + 2 * CHIP_PAD);
    stroke(C.broll, 0.6, pdfRoundRectPath(x + 0.3, b - 1.9, w - 0.6, 8.4, 1.6));
    text("B-roll", x + (w - tw) / 2, b + 0.3, "F1", CHIP_SIZE, C.broll);
  }

  function segHex(seg) {
    if (seg.color) return seg.color;
    if (seg.href) return C.visual;
    if (seg.tag && seg.tag.color) return seg.tag.color;
    if (seg.dir) return C.faint;
    if (seg.cue) return CUE;
    return null;
  }

  function blank(seg) { return !seg.text.trim(); }
  function marked(line, i, test) {
    if (!blank(line[i])) return test(line[i]);
    return i > 0 && i < line.length - 1 && test(line[i - 1]) && test(line[i]) && test(line[i + 1]);
  }

  function drawSegs(line, x, b, size) {
    var cx = x, link = null;
    line.forEach(function (seg, i) {
      var sp = blank(seg);
      var hex = segHex(seg), ink = hex || C.text;
      if (seg.mark) bar(cx, b - 2.5, seg.width, size + 1, HIGHLIGHT);
      if (!sp) {
        if (seg.broll) chip(cx, b, seg.width);
        else text(seg.text, cx, b, fontFor(seg), seg.cue ? size * CUE_SCALE : size, hex);
      }
      if (marked(line, i, function (s) { return (s.u || s.href) && s.href === seg.href; })) {
        bar(cx, b - 1.7, seg.width, 0.5, ink);
      }
      if (seg.tag && seg.tag.color && marked(line, i, function (s) { return s.tag && s.tag.name === seg.tag.name; })) {
        bar(cx, b - 2.2, seg.width, 0.6, seg.tag.color);
      }
      if (seg.s && !sp) bar(cx, b + size * 0.28, seg.width, 0.5, ink);
      if (seg.cmt && marked(line, i, function (s) { return !!s.cmt; })) {
        var open = seg.cmt.some(function (id) { return nums[id]; });
        ops.push("q " + pdfRgb(open ? C.audio : C.faint) + " RG 0.9 w 1 J [0 1.8] 0 d " +
          n2(cx + 0.5) + " " + n2(b - 3.8) + " m " + n2(cx + seg.width) + " " + n2(b - 3.8) + " l S Q");
      }
      if (seg.href) {
        if (link && link.uri === seg.href && Math.abs(link.x + link.w - cx) < 0.01) link.w += seg.width;
        else {
          link = { x: cx, y: b - 2.5, w: seg.width, h: size + 2, uri: seg.href };
          pageLinks.push(link);
        }
      }
      cx += seg.width;
      (seg.markers || []).forEach(function (n) {
        var s = String(n), w = markerW(n);
        cx += MK_GAP;
        stroke(C.audio, 0.6, pdfBubblePath(cx + 0.3, b - 1.2, w - 0.6, MK_H, 2, 0.6));
        text(s, cx + (w - pdfTextWidth(s, false, MK_SIZE)) / 2, b + 0.9, "F1", MK_SIZE, C.audio);
        cx += w;
      });
    });
  }

  function drawLines(lines, x, startY, size, lead) {
    var yy = startY;
    lines.forEach(function (line) {
      drawSegs(line, x, yy, size || SIZE);
      yy -= lead || LEAD;
    });
    return yy;
  }

  function colHeight(n, lead) { return n ? TOPB + (n - 1) * lead + TAIL : EMPTY; }
  function colBottom(c, n, lead) { return c - colHeight(n, lead); }
  function colFit(c, lead) { return Math.max(0, Math.floor((c - TOPB - M) / lead) + 1); }

  function titleBlock() {
    var TS = 20, TLEAD = 24;
    var tl = pdfWrapRuns([{ text: title, b: true }], TW, TS).map(function (l) {
      return l.map(function (s) { return s.text; }).join("").trim();
    });
    if (tl.length > 2) tl = [tl[0], pdfFitText(tl.slice(1).join(" "), true, TS, TW)];
    var b = PH - M - 16;
    tl.forEach(function (s, i) { text(s, M, b - i * TLEAD, "F2", TS); });
    b -= (tl.length - 1) * TLEAD + 17;
    pdfWrapRuns([{ text: exportSummaryParts(facts).concat(facts.date).join(" · ") }], TW, 8.5).forEach(function (l, i) {
      if (i) b -= 11;
      text(l.map(function (s) { return s.text; }).join("").trim(), M, b, "F1", 8.5, C.dim);
    });
    if (!scenes.length) {
      text("No scenes yet.", M, b - 28, "F1", SIZE, C.faint);
      y = b - 28;
      return;
    }
    y = rundownStrip(b - 14);
  }

  function rundownStrip(top) {
    var SH = 15, R = 1.5, NS = 6.5;
    var n = scenes.length;
    var total = facts.seconds, target = facts.target ? facts.target.seconds : 0;
    var span = Math.max(total, target);
    if (facts.target) top -= 12;
    var G = n > 1 ? Math.min(1.5, TW * 0.2 / (n - 1)) : 0;
    var avail = TW - G * (n - 1);
    var minW = Math.min(2.5, avail / n);
    var room = Math.max(span > 0 ? avail * total / span : avail, n * minW);
    var secs = scenes.map(function (f) { return f.seconds; });
    var small = secs.map(function () { return false; });
    var k = 0;
    for (var pass = 0; total > 0 && pass <= n; pass++) {
      var fixed = 0, rest = 0;
      secs.forEach(function (s, i) { if (small[i]) fixed += minW; else rest += s; });
      k = rest > 0 ? (room - fixed) / rest : 0;
      var changed = false;
      secs.forEach(function (s, i) {
        if (!small[i] && s * k < minW) { small[i] = true; changed = true; }
      });
      if (!changed) break;
    }
    var widths = secs.map(function (s, i) { return total > 0 ? (small[i] ? minW : s * k) : room / n; });
    var FILL = { shot: C.dim, ready: C.audioSoft, todo: C.surface2 };
    var INK = { shot: "FFFFFF", ready: C.audio, todo: C.dim };
    var bottom = top - SH, x = M, at = 0, tx = null;
    scenes.forEach(function (f, i) {
      var w = widths[i], id = FILL[f.status.id] ? f.status.id : "todo", r = Math.min(R, w / 2);
      fill(FILL[id], pdfRoundRectPath(x, bottom, w, SH, r));
      if (id === "ready") stroke(C.audio, 0.6, pdfRoundRectPath(x + 0.3, bottom + 0.3, w - 0.6, SH - 0.6, r));
      if (w >= pdfTextWidth(f.number, false, NS) + 5) text(f.number, x + 2.5, bottom + 5.2, "F1", NS, INK[id]);
      if (facts.target && tx === null && target >= at && target < at + f.seconds) {
        tx = x + w * (target - at) / f.seconds;
      }
      at += f.seconds;
      x += w + G;
    });
    if (facts.target) {
      if (tx === null) tx = M + TW;
      stroke(C.text, 0.8, n2(tx) + " " + n2(top + 9) + " m " + n2(tx) + " " + n2(bottom - 2.5) + " l");
      var label = "Target " + facts.target.text, lw = pdfTextWidth(label, false, 7);
      text(label, tx - 3 - lw < M ? tx + 3 : tx - 3 - lw, top + 3, "F1", 7, C.dim);
    }
    var lb = bottom - 13, lx = M;
    [["shot", "Shot"], ["ready", "Ready"], ["todo", "To do"]].forEach(function (p) {
      var sp = STATUS_PRINT[p[0]], s = p[1] + " " + facts.status[p[0]];
      ops.push(pdfLampOp(sp.lamp, lx + 3, lb + 2.6, 3, sp.color));
      text(s, lx + 9, lb, "F1", 7.5, C.dim);
      lx += 9 + pdfTextWidth(s, false, 7.5) + 12;
    });
    return lb - 20;
  }

  function drawHeads() {
    var b = y - 8;
    text("Scene", M, b, "F2", 8, C.dim);
    fill(C.visual, pdfCirclePath(VX + 2.4, b + 2.8, 2.4));
    text("Visual", VX + 8, b, "F2", 8, C.dim);
    fill(C.audio, pdfCirclePath(AX + 2.4, b + 2.8, 2.4));
    text("Audio", AX + 8, b, "F2", 8, C.dim);
    text("Read", READ_R - pdfTextWidth("Read", true, 8), b, "F2", 8, C.dim);
    ops.push(pdfRuleOp(M, y - 13, PW - M, C.borderStrong, 0.6));
    y -= HEADS_H;
  }

  function scriptPage() { newPage(); drawHeads(); }

  var NUM_SIZE = 12, TC_SIZE = 7, ST_SIZE = 7.5, READ_SIZE = 8.5;
  function gutterOf(f) {
    var nw = pdfTextWidth(f.number, true, NUM_SIZE);
    var stacked = nw + 4 + pdfTextWidth(f.start, false, TC_SIZE) > GUT - 6;
    var drop = stacked ? 22 : 12;
    return { nw: nw, stacked: stacked, drop: drop, h: TOPB + drop + TAIL };
  }

  function drawGutter(f, g, top) {
    var b = top - TOPB;
    text(f.number, M, b, "F2", NUM_SIZE);
    if (g.stacked) text(f.start, M, b - 10, "F1", TC_SIZE, C.faint);
    else text(f.start, M + g.nw + 4, b, "F1", TC_SIZE, C.faint);
    var sb = b - g.drop, sp = STATUS_PRINT[f.status.id] || STATUS_PRINT.todo;
    ops.push(pdfLampOp(sp.lamp, M + 3, sb + 2.6, 3, sp.color));
    text(f.status.label, M + 9, sb, "F1", ST_SIZE, C.dim);
    var rw = pdfTextWidth(f.read, false, READ_SIZE);
    text(f.read, READ_R - rw, b, "F1", READ_SIZE, C.dim);
    if (f.readSet) stroke(C.borderStrong, 0.6, pdfRoundRectPath(READ_R - rw - 3.5, b - 3, rw + 7, 11.5, 2));
  }

  function drawGutterCont(f, top) {
    var b = top - TOPB;
    text(f.number, M, b, "F2", NUM_SIZE, C.faint);
    text("cont.", M + pdfTextWidth(f.number, true, NUM_SIZE) + 4, b, "F1", TC_SIZE, C.faint);
  }

  newPage();
  titleBlock();
  if (scenes.length) drawHeads();

  S.state.rows.forEach(function (row, idx) {
    var f = scenes[idx];
    var g = gutterOf(f);
    var vLines = [];
    rowVideoLinks(row).forEach(function (l) {
      var runs = l.href ? [{ text: pdfAddress(l.href), href: l.href }] : [{ text: videoLinkText(l) }];
      var label = l.href ? videoHostLabel(l) + " " : "";
      if (label && pdfTextWidth(label + runs[0].text, false, VS) <= VW) runs.unshift({ text: label });
      pdfWrapRuns(runs, VW, VS).forEach(function (line) {
        line.forEach(function (seg) { if (!seg.href) seg.color = C.faint; });
        vLines.push(line);
      });
    });
    vLines = vLines.concat(pdfWrapRuns(cellRuns(row.visualText), VW, VS, WRAP));
    var aLines = pdfWrapRuns(cellRuns(row.audioText), AW, AS, WRAP);

    var imgH = 0, imgRef = null;
    var jpeg = jpegs ? jpegs[idx] : null;
    if (!jpegs) {
      var pic = rowImageBytes(row);
      if (pic && pic.mime === "image/jpeg") jpeg = { bytes: pic.bytes, size: jpegSize(pic.bytes) };
    }
    if (jpeg) {
      try {
        var bytes = jpeg.bytes;
        var dim = safeAspect(jpeg.size);
        var name = "Im" + (images.length + 1);
        images.push({ bytes: bytes, w: dim.w, h: dim.h, name: name });
        var natW = VW, natH = VW * dim.ratio;
        // Cap so tall images fit a fresh page
        var maxH = PAGE_ROOM;
        if (!vLines.length && colHeight(aLines.length, AL) <= PAGE_ROOM) maxH = PAGE_ROOM - PIC_GAP - EMPTY;
        if (natH > maxH) { natW = natW * (maxH / natH); natH = maxH; }
        imgRef = { name: name, w: natW, h: natH };
        imgH = imgRef.h + PIC_GAP;
      } catch (e) { }
    }

    var moreJpegs = jpegs && jpegs.more ? (jpegs.more[idx] || []) : [];
    if (!jpegs) {
      morePictureRefs(row).forEach(function (ref) {
        var mp = pictureBytes(ref);
        if (mp && mp.mime === "image/jpeg") moreJpegs.push({ bytes: mp.bytes, size: jpegSize(mp.bytes) });
      });
    }
    var STRIP_GAP = 6, STRIP_N = 3;
    var thumbW = (VW - STRIP_GAP * (STRIP_N - 1)) / STRIP_N;
    var stripLines = [];
    moreJpegs.forEach(function (mj, k) {
      try {
        var mdim = safeAspect(mj.size);
        var mname = "Im" + (images.length + 1);
        images.push({ bytes: mj.bytes, w: mdim.w, h: mdim.h, name: mname });
        var th = Math.min(thumbW * mdim.ratio, thumbW * 1.5);
        var tw = th / mdim.ratio;
        if (k % STRIP_N === 0) stripLines.push({ h: 0, items: [] });
        var line = stripLines[stripLines.length - 1];
        line.items.push({ name: mname, w: tw, h: th, x: (k % STRIP_N) * (thumbW + STRIP_GAP) });
        line.h = Math.max(line.h, th);
      } catch (e) { }
    });
    stripLines.forEach(function (line) { imgH += line.h + STRIP_GAP; });

    var stay = idx === 0;
    if (stay && imgRef) {
      var room1 = y - M - (imgH - imgRef.h) - (vLines.length ? 0 : EMPTY);
      if (imgRef.h > room1) {
        if (room1 < 72) stay = false;
        else {
          imgH -= imgRef.h - room1;
          imgRef.w *= room1 / imgRef.h;
          imgRef.h = room1;
        }
      }
    }

    var need = Math.max(imgH + colHeight(vLines.length, VL), colHeight(aLines.length, AL), g.h);
    if (y - need < M && y < ROW_TOP - 0.01 && !stay) scriptPage();

    var top = y;
    drawGutter(f, g, top);

    var vy = top;
    if (imgRef && vy - imgRef.h >= M) {
      pageImages.push(imgRef.name);
      ops.push("q " + imgRef.w.toFixed(2) + " 0 0 " + imgRef.h.toFixed(2) + " " +
        VX.toFixed(2) + " " + (vy - imgRef.h).toFixed(2) + " cm /" + imgRef.name + " Do Q");
      vy -= imgRef.h + PIC_GAP;
    }
    stripLines.forEach(function (line) {
      if (vy - line.h < M) return;
      line.items.forEach(function (it) {
        pageImages.push(it.name);
        ops.push("q " + it.w.toFixed(2) + " 0 0 " + it.h.toFixed(2) + " " +
          (VX + it.x).toFixed(2) + " " + (vy - it.h).toFixed(2) + " cm /" + it.name + " Do Q");
      });
      vy -= line.h + STRIP_GAP;
    });

    if (!vLines.length && !aLines.length) y = Math.min(vy - EMPTY, top - g.h);

    // Tall scenes split across pages; overflow would vanish
    var vRest = vLines, aRest = aLines;
    var vCursor = vy, aCursor = top;
    var drewPic = vy !== top;
    var onFirst = true;
    var guard = 0;
    while ((vRest.length || aRest.length) && guard++ < 400) {
      var vTake = vRest.slice(0, colFit(vCursor, VL)), aTake = aRest.slice(0, colFit(aCursor, AL));
      if (vTake.length === vRest.length && aTake.length === aRest.length) {
        var vLow = colBottom(vCursor, vTake.length, VL), aLow = colBottom(aCursor, aTake.length, AL);
        if (Math.min(vLow, aLow) < M - 1e-6) {
          if (vTake.length && (vLow <= aLow || !aTake.length)) vTake = vTake.slice(0, -1);
          else if (aTake.length) aTake = aTake.slice(0, -1);
        }
      }
      if (vTake.length) drawLines(vTake, VX, vCursor - TOPB, VS, VL);
      if (aTake.length) drawLines(aTake, AX, aCursor - TOPB, AS, AL);
      var vEnd = colBottom(vCursor, vTake.length, VL), aEnd = colBottom(aCursor, aTake.length, AL);
      vRest = vRest.slice(vTake.length);
      aRest = aRest.slice(aTake.length);
      if (!vRest.length && !aRest.length) {
        y = Math.min(vEnd, aEnd);
        if (onFirst) y = Math.min(y, top - g.h);
        break;
      }
      // Picture-filled page may leave no room for text
      if (!vTake.length && !aTake.length && !drewPic) break;
      drewPic = false;
      onFirst = false;
      scriptPage();
      drawGutterCont(f, y);
      vCursor = y;
      aCursor = y;
    }

    ops.push(pdfRuleOp(M, y, PW - M, C.border, 0.5));
    y -= ROW_GAP;
  });

  function section(name, summary) {
    newPage();
    outline.push({ title: name, page: pages.length, y: PH });
    text(name, M, y - 16, "F2", 16);
    text(summary, M, y - 33, "F1", 8.5, C.dim);
    y -= 52;
  }
  function sectionGoesOn(name) {
    newPage();
    text(name + " (continued)", M, y - 10, "F2", 10, C.dim);
    y -= 26;
  }

  function linesToRuns(str) {
    return String(str || "").split(/\r\n|\r|\n/).reduce(function (runs, line, i) {
      if (i > 0) runs.push({ text: "\n" });
      if (line) runs.push({ text: line });
      return runs;
    }, []);
  }
  function tint(lines, hex) {
    lines.forEach(function (l) { l.forEach(function (s) { if (!s.broll) s.color = hex; }); });
    return lines;
  }

  var groups = breakdownGroups();
  if (groups.length) {
    var bdItems = [];
    groups.forEach(function (gr) { bdItems = bdItems.concat(gr.items); });
    section("Production breakdown", [pdfCount(bdItems.length, "item")].concat(TAG_STATUSES.map(function (st) {
      var n = bdItems.filter(function (r) { return r.status === st.id; }).length;
      return n ? n + " " + st.label.toLowerCase() : "";
    }).filter(Boolean)).join(" · "));

    var IW = 186, SX = M + 194, CX = SX + 86, OX = CX + 118;
    var CW = OX - CX - 8, OW = PW - M - OX, BL = 12.5;
    var bdHeads = function () {
      var b = y - 8;
      text("Item", M, b, "F2", 8, C.dim);
      text("Status", SX, b, "F2", 8, C.dim);
      text("Scenes", CX, b, "F2", 8, C.dim);
      text("Assigned to", OX, b, "F2", 8, C.dim);
      ops.push(pdfRuleOp(M, y - 13, PW - M, C.borderStrong, 0.6));
      y -= 13;
    };
    var bdItem = function (r) {
      var it = {
        r: r,
        name: pdfWrapRuns([{ text: r.name }], IW - 8, SIZE),
        scenes: tint(pdfWrapRuns([{ text: r.scenes.join(", ") }], CW, 8.5), C.dim),
        owner: tint(pdfWrapRuns([{ text: r.owner || "—" }], OW, 8.5), r.owner ? C.dim : C.faint),
        more: r.notes ? tint(pdfWrapRuns(linesToRuns(r.notes), TW, 8.5), C.dim) : []
      };
      r.broll.forEach(function (shot) {
        it.more = it.more.concat(tint(pdfWrapRuns([{ text: "B-roll", broll: true }, { text: " " + shot }], TW, 8.5), C.dim));
      });
      it.main = Math.max(it.name.length, it.scenes.length, it.owner.length, 1);
      it.h = 16 + (it.main + it.more.length - 1) * BL + 9;
      return it;
    };
    var bdGroupHead = function (gr) {
      var b = y - 18;
      fill(gr.color || C.faint, pdfCirclePath(M + 3.2, b + 3.3, 3.2));
      text(gr.label, M + 11, b, "F2", 10);
      text(String(gr.items.length), M + 11 + pdfTextWidth(gr.label, true, 10) + 6, b, "F1", 8.5, C.faint);
      y = b - 6;
    };
    bdHeads();
    groups.forEach(function (gr) {
      var list = gr.items.map(bdItem);
      if (y - 24 - list[0].h < M) { sectionGoesOn("Production breakdown"); bdHeads(); }
      bdGroupHead(gr);
      list.forEach(function (it) {
        if (y - it.h < M) { sectionGoesOn("Production breakdown"); bdHeads(); bdGroupHead(gr); }
        var r = it.r, b = y - 16;
        drawLines(it.name, M, b, SIZE, BL);
        var sp = TAG_STATUS_PRINT[r.status] || TAG_STATUS_PRINT.needed;
        ops.push(pdfLampOp(sp.lamp, SX + 3, b + 2.6, 3, sp.color));
        text(r.statusLabel, SX + 9, b, "F1", 8.5, C.dim);
        drawLines(it.scenes, CX, b, 8.5, BL);
        drawLines(it.owner, OX, b, 8.5, BL);
        drawLines(it.more, M, b - it.main * BL, 8.5, BL);
        y -= it.h;
        ops.push(pdfRuleOp(M, y, PW - M, C.border, 0.5));
      });
    });
  }

  var shotData = brollShotListForPrint({ filter: "all", group: "scene" });
  if (shotData.groups.length) {
    pages.push({ ops: ops, images: pageImages, links: pageLinks });
    outline.push({ title: "B-roll shot list", page: pages.length, y: SHOT_PH });
    shotListAppendixPages(shotData).forEach(function (pageOps) {
      pages.push({ ops: [pdfRgb(C.text) + " rg"].concat(pageOps), images: [], links: [], size: [SHOT_PW, SHOT_PH], margin: SHOT_M });
    });
    ops = [];
    pageImages = [];
    pageLinks = [];
  }

  var comments = exportComments({ pieces: true });
  if (comments.length) {
    var openN = comments.filter(function (c) { return !c.resolved; }).length;
    section("Comments", [openN + " open"].concat(comments.length > openN ? [(comments.length - openN) + " resolved"] : []).join(" · "));
    var FULLW = TW;
    var CI = 20, RI = CI + 14;
    var badge = function (n, x, b) {
      var s = String(n), tw = pdfTextWidth(s, true, 7), w = Math.max(13, tw + 7);
      fill(C.audio, pdfBubblePath(x, b - 2.8, w, 11, 2.6, 0.8));
      text(s, x + (w - tw) / 2, b, "F2", 7, "FFFFFF");
    };

    var CIMG_MAXW = 0.6, CIMG_MAXH = 260, CIMG_ABOVE = 3, CIMG_BELOW = 7;
    var commentImageNames = {};

    function commentJpeg(sha) {
      if (commentJpegs) return commentJpegs[sha] || null;
      var pic = commentPic(sha);
      return pic && pic.mime === "image/jpeg" ? { bytes: pic.bytes, size: jpegSize(pic.bytes) } : null;
    }

    function commentPicItem(sha, x) {
      var colW = PW - M - x;
      var jpeg = commentJpeg(sha);
      if (jpeg) {
        try {
          var dim = safeAspect(jpeg.size);
          var name = commentImageNames[sha];
          if (!name) {
            name = "Im" + (images.length + 1);
            images.push({ bytes: jpeg.bytes, w: dim.w, h: dim.h, name: name });
            commentImageNames[sha] = name;
          }
          var scale = Math.min(0.75, colW * CIMG_MAXW / dim.w, CIMG_MAXH / dim.h);
          return { pic: { name: name, w: dim.w * scale, h: dim.h * scale }, x: x };
        } catch (e) { }
      }
      return { line: pdfWrapRuns([{ text: "[image unavailable]", i: true }], colW, SIZE)[0], x: x };
    }

    function commentBodyItems(entry, x) {
      var colW = PW - M - x;
      var pieces = entry.pieces || [];
      var hasPic = pieces.some(function (p) { return p.image; });
      if (!hasPic) {
        return pdfWrapRuns(linesToRuns(entry.body || "(empty)"), colW, SIZE)
          .map(function (l) { return { line: l, x: x }; });
      }
      var items = [];
      pieces.forEach(function (p) {
        if (p.image) { items.push(commentPicItem(p.image, x)); return; }
        pdfWrapRuns(linesToRuns(p.text), colW, SIZE).forEach(function (l) { items.push({ line: l, x: x }); });
      });
      return items;
    }

    function drawCommentPic(pic, x) {
      var top = y - CIMG_ABOVE;
      if (pageImages.indexOf(pic.name) === -1) pageImages.push(pic.name);
      ops.push("q " + pic.w.toFixed(2) + " 0 0 " + pic.h.toFixed(2) + " " +
        x.toFixed(2) + " " + (top - pic.h).toFixed(2) + " cm /" + pic.name + " Do Q");
      y = top - pic.h - CIMG_BELOW;
    }

    comments.forEach(function (c) {
      var meta = [c.author + (c.when ? " · " + c.when : "")];
      if (c.assignee) meta.push("Assigned to " + c.assignee);
      if (c.resolved) meta.push("Resolved" + (c.resolvedBy ? " by " + c.resolvedBy : ""));
      var headerLines = pdfWrapRuns([{ text: c.where, b: true }, { text: "   " + meta.join(" · ") }], FULLW - CI, SIZE);
      headerLines.forEach(function (l) { l.forEach(function (s) { if (!s.b) s.color = C.faint; }); });
      var quoteLines = c.quoted ? tint(pdfWrapRuns(linesToRuns("“" + c.quoted + "”").map(function (run) {
        return Object.assign(run, { i: true });
      }), FULLW - CI, SIZE), C.dim) : [];
      var bodyItems = commentBodyItems(c, M + CI);
      var replyBlocks = c.replies.map(function (rp) {
        var hl = pdfWrapRuns([{ text: rp.author, b: true }].concat(rp.when ? [{ text: "   " + rp.when }] : []), FULLW - RI, SIZE);
        hl.forEach(function (l) { l.forEach(function (s) { if (!s.b) s.color = C.faint; }); });
        return { headerLines: hl, bodyItems: commentBodyItems(rp, M + RI) };
      });

      var threadLines = [], block = 0;
      function addBlock(items, x) {
        block++;
        items.forEach(function (it) {
          threadLines.push(it.pic ? it : { line: it.line || it, x: it.line ? it.x : x, block: block });
        });
      }
      addBlock(headerLines, M + CI);
      if (c.number) threadLines[0].badge = c.number;
      addBlock(quoteLines, M + CI);
      addBlock(bodyItems);
      replyBlocks.forEach(function (rb) {
        addBlock(rb.headerLines, M + RI);
        addBlock(rb.bodyItems);
      });

      function ensureCommentRoom(need) {
        if (y - (need || LEAD) < M) {
          sectionGoesOn("Comments");
          return true;
        }
        return false;
      }

      // First line of a block sits SIZE lower than wraps
      var prevBlock = 0;
      ensureCommentRoom();
      threadLines.forEach(function (b) {
        if (b.pic) {
          ensureCommentRoom(CIMG_ABOVE + b.pic.h);
          drawCommentPic(b.pic, b.x);
          prevBlock = 0;
          return;
        }
        var follows = b.block === prevBlock;
        if (ensureCommentRoom(follows ? LEAD - SIZE : LEAD)) follows = false;
        var base = follows ? y : y - SIZE;
        if (b.badge) badge(b.badge, M, base);
        y = drawLines([b.line], b.x, base);
        prevBlock = b.block;
      });
      y -= 6;
      ops.push(pdfRuleOp(M, y + 4, PW - M, C.border, 0.5));
      y -= 10;
    });
  }

  if (ops.length) pages.push({ ops: ops, images: pageImages, links: pageLinks });

  pages.forEach(function (pg, i) {
    pg.ops.push("/Artifact << /Type /Pagination /Subtype /Footer >> BDC");
    pdfFooterOps(title, i + 1, pages.length, pg.size ? pg.size[0] : PW, pg.margin || M, FOOT_Y, C.faint, C.border)
      .forEach(function (op) { pg.ops.push(op); });
    pg.ops.push("EMC");
  });

  return assemblePdf({ size: [PW, PH], pages: pages, images: images, info: { title: title },
    outline: outline.length > 1 ? outline : [] });
}

var LIST_PW = 612, LIST_PH = 792, LIST_M = 54;
var LIST_FOOT_Y = 30;

function listSheet(size) {
  var sheet = { pages: [], ops: null, y: 0, body: false };
  sheet.PW = size ? size[0] : LIST_PW;
  sheet.PH = size ? size[1] : LIST_PH;
  sheet.M = size ? size[2] : LIST_M;
  sheet.newPage = function () {
    if (sheet.ops) sheet.pages.push(sheet.ops);
    sheet.ops = [];
    sheet.y = sheet.PH - sheet.M;
    sheet.body = false;
  };
  sheet.text = function (str, x, y, font, size, hex) {
    sheet.ops.push(pdfTextOp(str, x, y, font, size, hex));
  };
  sheet.push = function (ops) { Array.prototype.push.apply(sheet.ops, ops); };
  sheet.bare = function () {
    if (sheet.ops) sheet.pages.push(sheet.ops);
    sheet.ops = null;
    return sheet.pages;
  };
  sheet.finish = function (footTitle) {
    sheet.bare();
    var n = sheet.pages.length;
    sheet.pages.forEach(function (ops, i) {
      Array.prototype.push.apply(ops, pdfFooterOps(footTitle, i + 1, n, sheet.PW, sheet.M, LIST_FOOT_Y,
        PRINT_COLORS.faint, PRINT_COLORS.border));
    });
    return sheet.pages;
  };
  sheet.newPage();
  return sheet;
}

// LF is not WinAnsi and would print as ?
function listClean(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

function listWrap(runs, width, size) {
  return pdfWrapRuns(runs, width, size).map(function (line) {
    var out = [];
    line.forEach(function (seg) {
      var last = out[out.length - 1];
      if (last && last.b === !!seg.b && last.i === !!seg.i) { last.text += seg.text; last.width += seg.width; }
      else out.push({ text: seg.text, b: !!seg.b, i: !!seg.i, width: seg.width });
    });
    return out;
  });
}

function listLineOps(line, x, y, size, hex, boldHex) {
  var ops = [], cx = x;
  line.forEach(function (piece) {
    var str = piece.text.replace(/\s+$/, "");
    var font = piece.b ? (piece.i ? "F4" : "F2") : (piece.i ? "F3" : "F1");
    if (str) ops.push(pdfTextOp(str, cx, y, font, size, piece.b ? boldHex || hex : hex));
    cx += piece.width;
  });
  return ops;
}

function listHead(sheet, kicker, heading, dotHex, meta) {
  var C = PRINT_COLORS, M = sheet.M, W = sheet.PW - 2 * sheet.M;
  var y = sheet.y - 7;
  sheet.text(kicker, M, y, "F1", 9, C.faint);
  var hx = dotHex ? M + 16 : M;
  listWrap([{ text: listClean(heading), b: true }], M + W - hx, 20).forEach(function (line, i) {
    y -= i ? 24 : 26;
    if (!i && dotHex) sheet.ops.push("q " + pdfRgb(dotHex) + " rg " + pdfCirclePath(M + 5, y + 7, 5) + " f Q");
    sheet.push(listLineOps(line, hx, y, 20, C.text, C.text));
  });
  y -= 6;
  meta.forEach(function (str, i) {
    listWrap([{ text: listClean(str) }], W, 10.5).forEach(function (line) {
      y -= 14.5;
      sheet.push(listLineOps(line, M, y, 10.5, i ? C.faint : C.dim));
    });
  });
  sheet.y = y - 24;
}

export function buildPackingListPdf(catId) {
  var C = PRINT_COLORS, M = LIST_M, W = LIST_PW - 2 * LIST_M;
  var cat = tagCategory(catId);
  var title = S.state.title || "Untitled Script";
  var heading = cat ? cat.plural : catId;
  var docTitle = title + " — " + heading + " packing list";
  var group = breakdownGroups().filter(function (g) { return g.catId === catId; })[0];
  var items = (group ? group.items : []).slice()
    .sort(function (a, b) { return a.name.localeCompare(b.name); });

  var sheet = listSheet();
  var meta = [title + " · " + exportDateText()];
  if (items.length) meta.push(packingSummary(items));
  listHead(sheet, "Packing list", heading, cat ? tagPrintColor(cat.id) : null, meta);

  if (!items.length) {
    sheet.text("Nothing tagged " + (cat ? cat.label : catId) + " yet.", M, sheet.y + 4, "F1", 11, C.dim);
    return assembleTextPdf(sheet.finish(docTitle), LIST_PW, LIST_PH, docTitle);
  }

  var ky = sheet.y - 4;
  var KEY_X = M + 40, KEY_W = 46, KEY_GAP = 2, KEY_H = 9;
  sheet.ops.push(pdfTextOp("Status", M, ky, "F1", 8.5, C.dim));
  sheet.ops.push(packingPillOp(null, KEY_X, ky - 1, { seg: KEY_W, gap: KEY_GAP, h: KEY_H }));
  TAG_STATUSES.forEach(function (st, i) {
    var cx = KEY_X + i * (KEY_W + KEY_GAP) + KEY_W / 2;
    sheet.ops.push(pdfTextOp(st.label, cx - pdfTextWidth(st.label, false, 7.5) / 2, ky - 12, "F1", 7.5, C.dim));
  });
  sheet.ops.push(pdfTextOp("Fill in each step as it happens", KEY_X + 4 * KEY_W + 3 * KEY_GAP + 12, ky, "F3", 8, C.faint));
  sheet.y = ky - 26;

  var BOX = 11, OUT_X = M + 1.4, BACK_X = M + 29.4;
  var ITEM_X = M + 58, ITEM_W = 188;
  var STATUS_X = M + 256;
  var OWNER_X = M + 338, OWNER_W = 100;
  var SCENES_X = M + 448, SCENES_W = W - 448;
  var TOP = 16, NAME_LEAD = 13.5, UNDER_GAP = 13, UNDER_LEAD = 11.5, COL_LEAD = 12.5, TAIL = 8;

  function columnHeads(continued) {
    var y = sheet.y;
    if (continued) { sheet.text(heading + " (continued)", M, y - 7, "F1", 9, C.faint); y -= 24; }
    y -= 8;
    [["Out", M], ["Back", M + 25.4], ["Item", ITEM_X], ["Status", STATUS_X], ["Owner", OWNER_X], ["Scenes", SCENES_X]]
      .forEach(function (h) { sheet.text(h[0], h[1], y, "F1", 8.5, C.dim); });
    sheet.ops.push(pdfRuleOp(M, y - 6, M + W, C.borderStrong, 0.75));
    sheet.y = y - 6;
  }

  function rowOf(item) {
    var orphaned = item.inScript === "no";
    var under = [];
    if (listClean(item.notes)) {
      listWrap([{ text: listClean(item.notes) }], ITEM_W, 9).forEach(function (l) { under.push({ line: l }); });
    }
    if (item.broll.length) {
      listWrap([{ text: "B-roll: ", b: true }, { text: item.broll.map(listClean).join(", ") }], ITEM_W, 9)
        .forEach(function (l) { under.push({ line: l, boldHex: C.broll }); });
    }
    var r = {
      name: listWrap([{ text: listClean(item.name), b: true }], ITEM_W, 11),
      under: under,
      status: { id: item.status, label: item.statusLabel },
      owner: item.owner ? listWrap([{ text: listClean(item.owner) }], OWNER_W, 10) : [],
      scenes: listWrap([{ text: orphaned ? "Not in script" : item.scenes.join(", ") }], SCENES_W, 9.5),
      orphaned: orphaned
    };
    var depth = (r.name.length - 1) * NAME_LEAD;
    if (under.length) depth += UNDER_GAP + (under.length - 1) * UNDER_LEAD;
    r.height = TOP + Math.max(depth, (Math.max(1, r.owner.length, r.scenes.length) - 1) * COL_LEAD) + TAIL;
    return r;
  }

  function drawRow(r) {
    var base = sheet.y - TOP, low = base;
    sheet.ops.push(pdfCheckboxOp(OUT_X, base - 1.5, BOX, false, C.faint));
    sheet.ops.push(pdfCheckboxOp(BACK_X, base - 1.5, BOX, false, C.faint));
    r.name.forEach(function (line, i) {
      low = base - i * NAME_LEAD;
      sheet.push(listLineOps(line, ITEM_X, low, 11, C.text, C.text));
    });
    r.under.forEach(function (u, i) {
      low -= i ? UNDER_LEAD : UNDER_GAP;
      sheet.push(listLineOps(u.line, ITEM_X, low, 9, C.dim, u.boldHex));
    });
    sheet.ops.push(packingPillOp(r.status.id, STATUS_X, base + 1.5, { seg: 12, gap: 1, h: 5 }));
    r.owner.forEach(function (line, i) {
      low = Math.min(low, base - i * COL_LEAD);
      sheet.push(listLineOps(line, OWNER_X, base - i * COL_LEAD, 10, C.text));
    });
    r.scenes.forEach(function (line, i) {
      low = Math.min(low, base - i * COL_LEAD);
      sheet.push(listLineOps(line, SCENES_X, base - i * COL_LEAD, 9.5, r.orphaned ? C.faint : C.dim));
    });
    sheet.y = low - TAIL;
    sheet.ops.push(pdfRuleOp(M, sheet.y, M + W, C.border, 0.5));
    sheet.body = true;
  }

  columnHeads(false);
  items.map(rowOf).forEach(function (r) {
    if (sheet.y - r.height < M && sheet.body) { sheet.newPage(); columnHeads(true); }
    drawRow(r);
  });

  var SIGN_GAP = 40, SIGN_LEAD = 30;
  if (sheet.y - SIGN_GAP - SIGN_LEAD - 6 < M) {
    sheet.newPage();
    sheet.text(heading + " (continued)", M, sheet.y - 7, "F1", 9, C.faint);
    sheet.y -= 10;
  }
  var sy = sheet.y - SIGN_GAP;
  ["Packed by", "Returned by"].forEach(function (label) {
    sheet.text(label, M, sy, "F1", 10, C.dim);
    sheet.ops.push(pdfRuleOp(M + 62, sy - 2, M + 300, C.borderStrong, 0.75));
    sheet.text("Date", M + 318, sy, "F1", 10, C.dim);
    sheet.ops.push(pdfRuleOp(M + 344, sy - 2, M + W, C.borderStrong, 0.75));
    sy -= SIGN_LEAD;
  });

  return assembleTextPdf(sheet.finish(docTitle), LIST_PW, LIST_PH, docTitle);
}

function pillFill(id) {
  var C = PRINT_COLORS;
  return { needed: C.audio, sourcing: C.audio, have: C.dim, returned: C.faint }[id] || C.audio;
}

function pillSegmentPath(x, y, w, h, roundLeft, roundRight) {
  var r = h / 2, k = r * 0.5523;
  function p(a, b) { return a.toFixed(2) + " " + b.toFixed(2); }
  var out = p(x + (roundLeft ? r : 0), y) + " m " + p(x + w - (roundRight ? r : 0), y) + " l ";
  out += roundRight
    ? p(x + w - r + k, y) + " " + p(x + w, y + r - k) + " " + p(x + w, y + r) + " c " +
      p(x + w, y + r + k) + " " + p(x + w - r + k, y + h) + " " + p(x + w - r, y + h) + " c "
    : p(x + w, y + h) + " l ";
  out += p(x + (roundLeft ? r : 0), y + h) + " l ";
  out += roundLeft
    ? p(x + r - k, y + h) + " " + p(x, y + r + k) + " " + p(x, y + r) + " c " +
      p(x, y + r - k) + " " + p(x + r - k, y) + " " + p(x + r, y) + " c "
    : p(x, y) + " l ";
  return out + "h";
}

function packingPillOp(id, x, y, size) {
  var level = id === null ? -1 : Math.max(0, TAG_STATUSES.map(function (st) { return st.id; }).indexOf(id));
  var fill = level === -1 ? "" : pdfRgb(pillFill(TAG_STATUSES[level].id));
  var edge = pdfRgb(PRINT_COLORS.faint);
  return TAG_STATUSES.map(function (st, i) {
    var path = pillSegmentPath(x + i * (size.seg + size.gap), y, size.seg, size.h, i === 0, i === TAG_STATUSES.length - 1);
    return i <= level
      ? "q " + fill + " rg " + path + " f Q"
      : "q " + edge + " RG 0.6 w " + path + " S Q";
  }).join(" ");
}

function packingSummary(items) {
  var n = {}, label = {};
  items.forEach(function (e) {
    n[e.status] = (n[e.status] || 0) + 1;
    label[e.status] = e.statusLabel.toLowerCase();
  });
  var out = [items.length + (items.length === 1 ? " item" : " items")];
  ["have", "sourcing", "needed", "returned"].forEach(function (id) {
    if (n[id]) out.push(n[id] + " " + label[id]);
  });
  return out.join(" · ");
}

function assembleTextPdf(pages, PW, PH, title) {
  return assemblePdf({
    size: [PW, PH],
    pages: pages.map(function (ops) { return { ops: ops }; }),
    info: { title: title }
  });
}

var FLAG_PRINT = "C4302A";

function shotCutsOpening(text, max) {
  if (text.length <= max) return text;
  var cut = text.slice(0, max);
  var space = cut.lastIndexOf(" ");
  if (space > max / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.–—-]+$/, "") + "…";
}

var SHOT_PW = 792, SHOT_PH = 612, SHOT_M = 36, SHOT_BOTTOM = 54;

export function buildShotListPdf(data) {
  var C = PRINT_COLORS, M = SHOT_M;
  var docTitle = data.title + " — B-roll shot list";
  var sheet = listSheet([SHOT_PW, SHOT_PH, SHOT_M]);
  listHead(sheet, "B-roll shot list", data.title, null, [data.summary + " · " + data.scope + " · " + exportDateText()]);
  if (!data.groups.length) sheet.text("No shots to list.", M, sheet.y + 4, "F1", 11, C.dim);
  else drawShotTable(sheet, data, "B-roll shot list");
  return assembleTextPdf(sheet.finish(docTitle), SHOT_PW, SHOT_PH, docTitle);
}

export function shotListAppendixPages(data) {
  var C = PRINT_COLORS, M = SHOT_M;
  var sheet = listSheet([SHOT_PW, SHOT_PH, SHOT_M]);
  sheet.text("B-roll shot list", M, sheet.y - 16, "F2", 16, C.text);
  sheet.text(data.summary + " · " + data.scope, M, sheet.y - 33, "F1", 8.5, C.dim);
  sheet.y -= 46;
  drawShotTable(sheet, data, "B-roll shot list");
  return sheet.bare();
}

function drawShotTable(sheet, data, name) {
  var C = PRINT_COLORS, M = sheet.M, W = sheet.PW - 2 * sheet.M;
  var COLS = {
    done: { x: 0, w: 16 }, scene: { x: 22, w: 40 }, shot: { x: 66, w: 184 },
    location: { x: 258, w: 72 }, props: { x: 338, w: 102 }, owner: { x: 448, w: 58 },
    flag: { x: 514, w: 80 }, notes: { x: 602, w: W - 602 }
  };
  var HEADS = [["done", "Done"], ["scene", "Scene"], ["shot", "B-roll shot"], ["location", "Location"],
    ["props", "Props"], ["owner", "Assigned"], ["flag", "Flagged"], ["notes", "Notes"]];
  var TOP = 12, TAIL = 8, MIN_ROW = 34, WRITE_LEAD = 11;

  function heads(continued) {
    if (continued) { sheet.text(name + " (continued)", M, sheet.y - 7, "F1", 9, C.faint); sheet.y -= 20; }
    var b = sheet.y - 10;
    HEADS.forEach(function (h) { sheet.text(h[1], M + COLS[h[0]].x, b, "F1", 7.5, C.dim); });
    sheet.y = b - 5;
    sheet.ops.push(pdfRuleOp(M, sheet.y, M + W, C.borderStrong, 0.75));
  }

  function col(runs, w, size, hex, lead, boldHex) {
    return listWrap(runs, w, size).map(function (line) {
      return { line: line, size: size, hex: hex, boldHex: boldHex || hex, lead: lead };
    });
  }
  function depth(lines) {
    return lines.reduce(function (n, l, i) { return n + (i ? l.lead : 0); }, 0);
  }

  function rowOf(r, showScene, g) {
    var cells = {};
    var nameHex = r.shot ? C.faint : C.text;
    if (showScene && r.scene) {
      cells.scene = col([{ text: r.scene, b: true }], COLS.scene.w, 9.5, C.text, 0)
        .concat(r.start ? col([{ text: r.start }], COLS.scene.w, 7.5, C.faint, 10) : []);
    }
    var shot = col([{ text: listClean(r.name), b: true }], COLS.shot.w, 9.5, nameHex, 11.5);
    String(r.desc || "").split("\n").forEach(function (para) {
      if (listClean(para)) shot = shot.concat(col([{ text: listClean(para) }], COLS.shot.w, 8, r.shot ? C.faint : C.dim, 10));
    });
    if (r.cuts) shot = shot.concat(col([{ text: "“" + shotCutsOpening(listClean(r.cuts), 84) + "”", i: true }], COLS.shot.w, 7.5, C.faint, 9.5));
    cells.shot = shot;
    if (r.location && g.kind !== "location") cells.location = col([{ text: listClean(r.location) }], COLS.location.w, 8.5, C.dim, 10.5);
    var props = r.propsWithStatus || r.props;
    if (props.length) {
      cells.props = [];
      props.forEach(function (p) { cells.props = cells.props.concat(col([{ text: listClean(p) }], COLS.props.w, 8.5, C.dim, 10.5)); });
    }
    if (r.owner && g.kind !== "person") cells.owner = col([{ text: listClean(r.owner) }], COLS.owner.w, 8.5, C.dim, 10.5);
    var note = listClean(r.note);
    if (r.flagged) {
      cells.flag = col([{ text: "Flagged", b: true }], COLS.flag.w, 8.5, FLAG_PRINT, 0)
        .concat(note ? col([{ text: note }], COLS.flag.w, 8, C.dim, 10) : []);
    } else if (note) {
      cells.notes = col([{ text: note }], COLS.notes.w, 8, C.dim, 10);
    }
    var tallest = 0;
    Object.keys(cells).forEach(function (k) { tallest = Math.max(tallest, depth(cells[k])); });
    return { r: r, cells: cells, height: Math.max(MIN_ROW, TOP + tallest + TAIL) };
  }

  function drawRow(row) {
    var top = sheet.y, base = top - TOP, bottom = top - row.height;
    sheet.ops.push(pdfCheckboxOp(M + COLS.done.x + 1, base - 1.2, 9, row.r.shot, C.faint, C.broll));
    var notesLow = base + WRITE_LEAD - 2;
    Object.keys(row.cells).forEach(function (k) {
      var y = base;
      row.cells[k].forEach(function (l, i) {
        y -= i ? l.lead : 0;
        sheet.push(listLineOps(l.line, M + COLS[k].x, y, l.size, l.hex, l.boldHex));
      });
      if (k === "notes") notesLow = y;
    });
    for (var wy = notesLow - WRITE_LEAD + 1; wy > bottom + 4; wy -= WRITE_LEAD) {
      sheet.ops.push(pdfRuleOp(M + COLS.notes.x, wy, M + W, C.borderStrong, 0.5));
    }
    sheet.y = bottom;
    sheet.body = true;
  }

  function band(g, continued) {
    var b = sheet.y - 14, x = M;
    if (g.kind === "location" && !g.none) {
      sheet.ops.push(listPinOp(M + 3.5, b + 4.6, 2.8, tagPrintColor("location")));
      x = M + 11;
    }
    sheet.push(listLineOps(listWrap([{ text: listClean(g.label), b: true }], W - 120, 9.5)[0], x, b, 9.5, C.text, C.text));
    var right = continued ? "(continued)" : g.done + "/" + g.total + " shot";
    var allShot = !continued && g.total && g.done === g.total;
    sheet.text(right, M + W - pdfTextWidth(right, false, 8.5), b, "F1", 8.5, allShot ? C.broll : C.faint);
    sheet.y = b - 6;
    sheet.ops.push(pdfRuleOp(M, sheet.y, M + W, C.borderStrong, 0.6));
  }

  heads(false);
  data.groups.forEach(function (g, gi) {
    var byScene = g.kind === "scene";
    var rows = g.items.map(function (r, i) { return rowOf(r, !byScene || i === 0, g); });
    var bandH = byScene ? 0 : 20;
    if (sheet.y - bandH - (rows.length ? rows[0].height : 0) < SHOT_BOTTOM && sheet.body) { sheet.newPage(); heads(true); }
    else if (gi && byScene) sheet.ops.push(pdfRuleOp(M, sheet.y, M + W, C.borderStrong, 0.6));
    if (!byScene) band(g, false);
    rows.forEach(function (row, i) {
      if (sheet.y - row.height < SHOT_BOTTOM && sheet.body) {
        sheet.newPage();
        heads(true);
        if (!byScene) band(g, true);
        else if (i) row = rowOf(row.r, true, g);
      } else if (i) {
        sheet.ops.push(pdfRuleOp(M + COLS.shot.x, sheet.y, M + W, C.border, 0.5));
      }
      drawRow(row);
    });
  });
}

function listPinOp(cx, cy, r, hex) {
  return "q " + pdfRgb(hex) + " rg " + pdfCirclePath(cx, cy, r) + " f " +
    n2(cx - r * 0.88) + " " + n2(cy - r * 0.476) + " m " + n2(cx) + " " + n2(cy - r * 2.1) + " l " +
    n2(cx + r * 0.88) + " " + n2(cy - r * 0.476) + " l h f 1 1 1 rg " + pdfCirclePath(cx, cy, r * 0.4) + " f Q";
}

export function __init() {}
