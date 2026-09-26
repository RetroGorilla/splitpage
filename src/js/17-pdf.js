import { S } from "./_state.js";
import { bytesForSync, recordFor, rowImageBytes } from "./02c-blobs.js";
import { morePictureRefs, pictureBytes, rowVideoLinks, videoLinkText } from "./02d-gallery.js";
import { videoHostLabel } from "./05-render.js";
import {
  TAG_STATUSES,
  personById,
  productionEntries,
  tagCategory,
  tagStatus
} from "./07-production-tags.js";
import { brollShotsByProp } from "./08c-broll.js";
import { commentEntries } from "./10-comments.js";
import { concatBytes, latin1Bytes, tagPrintColor } from "./14-export.js";
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
import { jpegSize, safeAspect } from "./15-docx.js";
import { sniffImageMime } from "../../shared/blob-policy.js";

/* ================= pdf ================= */

/* Adobe's Helvetica metrics (units per 1000) for codes 32..126 — enough to
   wrap text accurately without shipping a font file. */
var HELV_W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
var HELVB_W = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/* map the typographic characters a script actually contains into WinAnsi */
var WINANSI_MAP = { "—": 151, "–": 150, "‘": 145, "’": 146, "“": 147, "”": 148, "…": 133, "•": 149, " ": 32 };

function pdfEncodeChar(ch) {
  if (WINANSI_MAP[ch] !== undefined) return WINANSI_MAP[ch];
  var code = ch.charCodeAt(0);
  if (code >= 32 && code <= 255) return code;
  return 63; /* "?" for anything we can't represent */
}

/* widths for those same high codes — an em dash is a full em wide, and
   guessing it narrow silently swallows the space that follows it; the
   middle dot the exports join their facts with (183) is narrow, and
   guessed a letter's width it left a gap after it */
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

/* A category's print colour (#171; TAG_PRINT_COLORS, 14-export.js) as the
   operands of a PDF colour operator: "RRGGBB" to "0.463 0.290 0.635". */
export function pdfRgb(hex) {
  return [0, 2, 4].map(function (i) { return (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3); }).join(" ");
}

/* A filled circle's path, centred on (cx, cy): four Bézier quarters, the
   usual 0.5523 control distance. The caller sets the colour and fills. */
export function pdfCirclePath(cx, cy, r) {
  var k = r * 0.5523;
  function p(x, y) { return x.toFixed(2) + " " + y.toFixed(2); }
  return p(cx + r, cy) + " m " +
    p(cx + r, cy + k) + " " + p(cx + k, cy + r) + " " + p(cx, cy + r) + " c " +
    p(cx - k, cy + r) + " " + p(cx - r, cy + k) + " " + p(cx - r, cy) + " c " +
    p(cx - r, cy - k) + " " + p(cx - k, cy - r) + " " + p(cx, cy - r) + " c " +
    p(cx + k, cy - r) + " " + p(cx + r, cy - k) + " " + p(cx + r, cy) + " c h";
}

/* ---- the pieces every PDF here draws with ----

   Each returns content-stream operators as one string, wrapped in q/Q
   where it sets a colour, so a caller can push it anywhere. Colours are
   print hexes (PRINT_COLORS, 14b-export-kit.js; TAG_PRINT_COLORS). */

function n2(v) { return (+v).toFixed(2); }

/* One string of Helvetica: F1 regular, F2 bold, F3 oblique, F4 bold
   oblique. With a colour it is wrapped so the colour does not leak. The
   uncoloured form is byte for byte the text op the writers always
   emitted, which the tests read. */
export function pdfTextOp(str, x, y, font, size, hex) {
  var op = "BT /" + font + " " + size + " Tf 1 0 0 1 " + n2(x) + " " + n2(y) +
    " Tm (" + pdfEscapeText(str) + ") Tj ET";
  return hex ? "q " + pdfRgb(hex) + " rg " + op + " Q" : op;
}

/* A rounded rectangle's path, (x, y) its lower-left corner. */
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

/* A hairline from (x1, y) to (x2, y). */
export function pdfRuleOp(x1, y, x2, hex, width) {
  return "q " + pdfRgb(hex) + " RG " + (width || 0.5) + " w " + n2(x1) + " " + n2(y) + " m " + n2(x2) + " " + n2(y) + " l S Q";
}

/* A status lamp centred on (cx, cy), radius r (#169's lamps, which
   STATUS_PRINT / TAG_STATUS_PRINT name): "outline" an unlit ring,
   "fill" lit, "half" the left half lit inside a ring, "check" lit with a
   small white check, "ring" a thin ring with a dot (Returned). */
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
  /* check */
  return "q " + c + " rg " + pdfCirclePath(cx, cy, r) + " f 1 1 1 RG " + n2(r * 0.32) + " w 1 J 1 j " +
    n2(cx - r * 0.45) + " " + n2(cy + r * 0.02) + " m " + n2(cx - r * 0.1) + " " + n2(cy - r * 0.34) + " l " +
    n2(cx + r * 0.48) + " " + n2(cy + r * 0.36) + " l S Q";
}

/* A box to tick, lower-left (x, y), `size` square; ticked in `tickHex`. */
export function pdfCheckboxOp(x, y, size, ticked, boxHex, tickHex) {
  var op = "q " + pdfRgb(boxHex || "64635E") + " RG 0.9 w " + pdfRoundRectPath(x, y, size, size, size * 0.18) + " S Q";
  if (ticked) {
    op += " q " + pdfRgb(tickHex || "00717F") + " RG " + n2(size * 0.16) + " w 1 J 1 j " +
      n2(x + size * 0.2) + " " + n2(y + size * 0.5) + " m " + n2(x + size * 0.43) + " " + n2(y + size * 0.24) + " l " +
      n2(x + size * 0.84) + " " + n2(y + size * 0.82) + " l S Q";
  }
  return op;
}

/* The running footer every page of these PDFs carries: the title at the
   left, "Page n of N" at the right, small and faint, over a hairline —
   so a printed page that has come loose still says what it is from. `y`
   is the footer's baseline. */
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

/* A PDF text string for the document information dictionary: plain
   ASCII as a literal, anything else as UTF-16BE with its byte-order mark,
   which is how PDF says "Unicode". */
function pdfInfoString(s) {
  s = String(s || "");
  if (/^[\x20-\x7e]*$/.test(s)) return "(" + s.replace(/([()\\])/g, "\\$1") + ")";
  var hex = "FEFF";
  for (var i = 0; i < s.length; i++) hex += ("000" + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
  return "<" + hex + ">";
}

/* The day, not the second (PDF allows "D:YYYYMMDD"): the same script
   exported twice in a day is the same bytes, which is how the Export
   dialog's suite proves every route runs the one code path — and all a
   reader needs is the day, which the title block prints anyway. */
function pdfDate(d) {
  function p(v) { return (v < 10 ? "0" : "") + v; }
  return "D:" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

/* ---- one assembler for every PDF here ----

   spec.pages     [{ops: [operator strings], images: [image names used],
                    links: [{x, y, w, h, uri}]}], in order
   spec.size      [PW, PH]
   spec.images    [{name, bytes, w, h}] — JPEG streams (/DCTDecode)
   spec.info      {title} — the document information dictionary: its
                  title (which a viewer shows in place of the file name,
                  /DisplayDocTitle), Splitpage as its creator, and when
   spec.outline   [{title, page (index), y}] — bookmarks, a viewer's
                  sidebar of the document's sections

   Four Helvetica faces as F1..F4 (regular, bold, oblique, bold oblique),
   on every page. Content streams are uncompressed, one operator a line:
   the tests read them back as text. */
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
  /* each link its own annotation object, numbered in page order */
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
    put("<< /Type /Page /Parent " + OBJ_PAGES + " 0 R /MediaBox [0 0 " + PW + " " + PH + "]" +
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

/* break styled runs into lines that fit maxWidth. A stage direction's
   runs (#167, toDocxRuns: dir, already bracketed) are set in italic and
   keep dir, which drawLines prints grey. A sound cue line's runs (#219,
   cue) keep cue, which drawLines prints smaller (CUE_SCALE, measured at
   that size here) in the Music/SFX colour; a cue is a whole line, so it
   is its own line on the page. */
var CUE_SCALE = 0.85;

/* The annotations an export's runs carry (exportRuns, 14b-export-kit.js)
   ride along on every piece of the run they came from — href, tag, cmt,
   broll — except `markers`, the comment numbers drawn after a thread's
   words, which only the run's last word takes. opts.markerWidth(markers),
   when given, is the room those need, counted into that word's line so a
   marker never runs past the column: it lands on the segment as
   `markerWidth`, beside its own `width`. */
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
      /* a single word longer than the column: hard-split it */
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
    /* the thread markers after the run's last word: counted into its line,
       and when they would not fit there that word goes to the next line
       with them (whatever followed it on the line, spaces, goes too) */
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

/* ---- pictures, as JPEG ----

   This writer embeds images one way only, /Filter /DCTDecode — the image
   stream IS a JPEG file. A PNG, GIF or WebP written the same way was a
   stream no reader could decode: the picture silently never appeared
   (#82 found it). So every picture is JPEG by the time buildPdf() sees it:
   a JPEG as it is, anything else drawn onto a white canvas (PDF has no
   use for its transparency here) and encoded — which needs the browser's
   decoder, and is why this is async and done before buildPdf(). */
var PDF_IMAGE_MAX_PX = 2000;

function pdfJpegOf(pic) {
  if (!pic) return Promise.resolve(null);
  /* jpegSize: the CODED size, which is what /Width and /Height must say —
     an EXIF-rotated record's width/height would not be. */
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

/* One entry per row (by index): {bytes, size} or null. Bytes behind an
   imageRef have to be in memory first — buildFileData awaits
   ensureBytes() before it calls this. */
export function pdfImagesFor(rows) {
  rows = rows || [];
  var first = Promise.all(rows.map(function (row) {
    return pdfJpegOf(rowImageBytes(row)).then(null, function () { return null; });
  }));
  /* and the rest of each scene's gallery (#135), as `.more[index]`: a
     list per row of the same {bytes, size}, the ones that would not
     decode left out */
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

/* A picture inside a comment or reply, by sha (commentEntries' pieces):
   its bytes and type from the registry — the type sniffed, as a row's
   is, since that is what the bytes are. null when the bytes are not here. */
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

/* Every picture in the comments and replies, as JPEG: {sha: {bytes,
   size} | null}, null for one whose bytes are not here or will not
   decode. Like pdfImagesFor, the bytes must be in memory first —
   buildFileData's ensureBytes(refsIn(state)) covers comment and reply
   bodies and an image conflict card's imageValue. */
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

/* ================= the script, as a PDF =================

   File ▸ Export… ▸ PDF: the whole script, to print or to send someone to
   read, laid out the way the app lays it out (#169), so a page on a desk
   reads like the screen it came from. Page 1 opens with a title block:
   the title, one line of the document's facts (exportSummaryParts,
   14b-export-kit.js) and a rundown strip — a block per scene as wide as
   its read time, filled by its status, the target a line across it. Then
   the scenes, under column heads every page of the script repeats: each
   scene's gutter (its number, the timecode it starts at, its status), its
   Visual and its Audio, and its read time at the right edge, boxed when
   it was set by hand. In the words, what the app draws round them: a tag
   in its category's colour and underlined in it, the b-roll key as a
   chip, a link in the Visual blue that can be clicked, a comment's dotted
   underline with its thread's number after it. Then an appendix, each
   part on a page of its own with a bookmark: the production breakdown by
   category, the b-roll shots by scene, and the comments, numbered as the
   script numbers them. Every page has a footer: the title, "Page 2 of 9".

   Helvetica's WinAnsi throughout, so every mark (a lamp, a dot, a box, a
   tick) is drawn rather than typed. */

/* A thread's marker as the script draws it (app.css .cmt-anchor::after):
   a rounded box whose lower-left corner is nearly square, like a speech
   bubble's tail. (x, y) its lower-left corner; `r` the other corners'
   radius and `low` that one's. */
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

/* `str` cut short with an ellipsis where it would not fit `width` — at a
   word's end, when that loses no more than a few letters. */
function pdfFitText(str, bold, size, width) {
  str = String(str || "");
  if (pdfTextWidth(str, bold, size) <= width) return str;
  while (str.length > 1 && pdfTextWidth(str + "…", bold, size) > width) str = str.slice(0, -1);
  var sp = str.lastIndexOf(" ");
  if (sp > str.length * 0.7) str = str.slice(0, sp);
  return str.replace(/[\s,;:]+$/, "") + "…";
}

/* A web address as the page prints it: without its scheme or "www.", as
   the scene's gallery captions it (videoLinkLabel, 02d-gallery.js) — but
   whole, since on paper it is the only way to find the thing. */
function pdfAddress(href) {
  return String(href).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function pdfCount(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

/* `jpegs` is pdfImagesFor(S.state.rows)'s answer and `commentJpegs`
   pdfCommentImagesFor()'s. Without them only pictures that are already
   JPEG are drawn. */
export function buildPdf(jpegs, commentJpegs) {
  var PW = 612, PH = 792, M = 54;
  var C = PRINT_COLORS;
  var TW = PW - 2 * M;
  /* The script's columns, left to right: each scene's gutter, its Visual,
     its Audio, and its read time at the right edge. Audio a step larger
     than Visual, as the app sets them: the words someone reads aloud are
     the ones to make easy to read. */
  var GUT = 46, VW = 184, GAP = 14, RW = 32;
  var VX = M + GUT, AX = VX + VW + GAP, AW = PW - M - RW - AX;
  var VS = 9, VL = 12.5, AS = 10, AL = 14;
  /* the appendix's text */
  var SIZE = 9.5, LEAD = 13;
  /* A scene's rhythm. Its top is ROW_GAP under the rule above it (or the
     column heads' rule), every column's first baseline TOPB under its
     top, and its own rule TAIL under the last baseline of its longest
     column — or EMPTY under a column with nothing in it, which for a
     picture with no words under it is PIC_GAP + EMPTY under the picture.
     The gutter is a column too: the number's line, then the status's. */
  var ROW_GAP = 10, TOPB = 10, TAIL = 14, PIC_GAP = 8, EMPTY = 4;
  /* the column heads: their baseline 8 under the top of the page, their
     rule 5 under that, the first scene ROW_GAP under the rule */
  var HEADS_H = 13 + ROW_GAP;
  /* where a scene starts on a fresh page, and so the most room it gets */
  var ROW_TOP = PH - M - HEADS_H;
  var PAGE_ROOM = ROW_TOP - M;
  var FOOT_Y = 28;
  /* the read time's right edge, inside the box a time set by hand gets */
  var READ_R = PW - M - 3.5;
  var CUE = tagPrintColor("sound") || "AB413E";
  var HIGHLIGHT = "FCE38A";

  var facts = exportFacts();
  var scenes = sceneFacts();
  var nums = commentNumbers();
  var title = facts.title;

  var pages = [];
  var ops = [];
  var images = [];      /* {bytes, w, h, name} */
  var pageImages = [];  /* image names used on the current page */
  var pageLinks = [];   /* {x, y, w, h, uri} clickable on the current page */
  var outline = [{ title: "Script", page: 0, y: PH }];
  var y = 0;

  /* Every page starts in the text colour; whatever draws in another
     wraps itself in q ... Q (pdfTextOp), so the page comes back to it. */
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
  /* a filled bar: an underline, a strikethrough, a highlight */
  function bar(x, yy, w, h, hex) {
    ops.push("q " + pdfRgb(hex) + " rg " + x.toFixed(2) + " " + yy.toFixed(2) + " " +
      w.toFixed(2) + " " + h.toFixed(2) + " re f Q");
  }

  /* ---- the words, and what the app draws round them ---- */

  /* A thread's number after its words (exportRuns' markers): an amber
     outlined bubble each. pdfWrapRuns keeps markersWidth() of room for
     them on their word's line, so they never run past the column. */
  var MK_SIZE = 6, MK_PAD = 2, MK_H = 7.8, MK_GAP = 1.5;
  function markerW(n) { return Math.max(8, pdfTextWidth(String(n), false, MK_SIZE) + 2 * MK_PAD); }
  function markersWidth(markers) {
    return markers.reduce(function (w, n) { return w + MK_GAP + markerW(n); }, 0);
  }
  var WRAP = { markerWidth: markersWidth };

  /* A cell's runs, annotated (exportRuns): what the page draws round
     them rides along on every segment pdfWrapRuns makes. The b-roll key's
     own run ("B-roll:") becomes "B-roll", the width of the chip drawn in
     its place. */
  function cellRuns(html) {
    return exportRuns(html, nums).map(function (r) {
      return r.broll ? Object.assign({}, r, { text: "B-roll" }) : r;
    });
  }

  /* the b-roll key (#148): a small outlined chip in the b-roll teal */
  var CHIP_SIZE = 6.5, CHIP_PAD = 2.4;
  function chip(x, b, room) {
    var tw = pdfTextWidth("B-roll", false, CHIP_SIZE);
    var w = Math.min(room, tw + 2 * CHIP_PAD);
    stroke(C.broll, 0.6, pdfRoundRectPath(x + 0.3, b - 1.9, w - 0.6, 8.4, 1.6));
    text("B-roll", x + (w - tw) / 2, b + 0.3, "F1", CHIP_SIZE, C.broll);
  }

  /* A segment's colour: its own (a caption, a quote), a link's blue, its
     tag's category colour, a stage direction's grey (#167), a sound
     cue's brick (#219) — or null, the page's text colour. */
  function segHex(seg) {
    if (seg.color) return seg.color;
    if (seg.href) return C.visual;
    if (seg.tag && seg.tag.color) return seg.tag.color;
    if (seg.dir) return C.faint;
    if (seg.cue) return CUE;
    return null;
  }

  function blank(seg) { return !seg.text.trim(); }
  /* Whether segment i carries a mark that `test` looks for — a space only
     when the words both sides of it do: the one inside a two-word tag is
     underlined, the one after it is not. */
  function marked(line, i, test) {
    if (!blank(line[i])) return test(line[i]);
    return i > 0 && i < line.length - 1 && test(line[i - 1]) && test(line[i]) && test(line[i + 1]);
  }

  /* One line of pdfWrapRuns' segments from x, its baseline at b, set at
     `size` (the size it was wrapped at). */
  function drawSegs(line, x, b, size) {
    var cx = x, link = null;
    line.forEach(function (seg, i) {
      var sp = blank(seg);
      var hex = segHex(seg), ink = hex || C.text;
      if (seg.mark) bar(cx, b - 2.5, seg.width, size + 1, HIGHLIGHT);
      if (!sp) {
        if (seg.broll) chip(cx, b, seg.width);
        /* a cue is set smaller (CUE_SCALE, as pdfWrapRuns measured it) */
        else text(seg.text, cx, b, fontFor(seg), seg.cue ? size * CUE_SCALE : size, hex);
      }
      /* underlined, or a link — which the app underlines in its blue */
      if (marked(line, i, function (s) { return (s.u || s.href) && s.href === seg.href; })) {
        bar(cx, b - 1.7, seg.width, 0.5, ink);
      }
      /* a tag: underlined in its category's colour */
      if (seg.tag && seg.tag.color && marked(line, i, function (s) { return s.tag && s.tag.name === seg.tag.name; })) {
        bar(cx, b - 2.2, seg.width, 0.6, seg.tag.color);
      }
      if (seg.s && !sp) bar(cx, b + size * 0.28, seg.width, 0.5, ink);
      /* a comment's words: a dotted underline, amber while its thread is
         open and faint once it is resolved (app.css .cmt-anchor) */
      if (seg.cmt && marked(line, i, function (s) { return !!s.cmt; })) {
        var open = seg.cmt.some(function (id) { return nums[id]; });
        ops.push("q " + pdfRgb(open ? C.audio : C.faint) + " RG 0.9 w 1 J [0 1.8] 0 d " +
          n2(cx + 0.5) + " " + n2(b - 3.8) + " m " + n2(cx + seg.width) + " " + n2(b - 3.8) + " l S Q");
      }
      /* a link, a rectangle to click: one per run of its words on a line */
      if (seg.href) {
        if (link && link.uri === seg.href && Math.abs(link.x + link.w - cx) < 0.01) link.w += seg.width;
        else {
          link = { x: cx, y: b - 2.5, w: seg.width, h: size + 2, uri: seg.href };
          pageLinks.push(link);
        }
      }
      cx += seg.width;
      /* the numbers of the open threads whose words end here */
      (seg.markers || []).forEach(function (n) {
        var s = String(n), w = markerW(n);
        cx += MK_GAP;
        stroke(C.audio, 0.6, pdfBubblePath(cx + 0.3, b - 1.2, w - 0.6, MK_H, 2, 0.6));
        text(s, cx + (w - pdfTextWidth(s, false, MK_SIZE)) / 2, b + 0.9, "F1", MK_SIZE, C.audio);
        cx += w;
      });
    });
  }

  /* Lines from x, the first baseline at startY, `lead` apart (the
     appendix's SIZE and LEAD unless given); returns where the next line's
     baseline would go. */
  function drawLines(lines, x, startY, size, lead) {
    var yy = startY;
    lines.forEach(function (line) {
      drawSegs(line, x, yy, size || SIZE);
      yy -= lead || LEAD;
    });
    return yy;
  }

  /* ---- a scene's columns, in one arithmetic ----

     A column of n lines `lead` apart, from cursor c: its first baseline
     c - TOPB, its last c - TOPB - (n-1)*lead, and the scene's rule TAIL
     under that — or EMPTY under c when it has no lines. colFit is the
     most lines that fit from c with every baseline on or above M. */
  function colHeight(n, lead) { return n ? TOPB + (n - 1) * lead + TAIL : EMPTY; }
  function colBottom(c, n, lead) { return c - colHeight(n, lead); }
  function colFit(c, lead) { return Math.max(0, Math.floor((c - TOPB - M) / lead) + 1); }

  /* ---- the title block ---- */

  function titleBlock() {
    var TS = 20, TLEAD = 24;
    /* the title, two lines at most — the second cut short when it would
       need a third, so a long one never runs off the page */
    var tl = pdfWrapRuns([{ text: title, b: true }], TW, TS).map(function (l) {
      return l.map(function (s) { return s.text; }).join("").trim();
    });
    if (tl.length > 2) tl = [tl[0], pdfFitText(tl.slice(1).join(" "), true, TS, TW)];
    var b = PH - M - 16;
    tl.forEach(function (s, i) { text(s, M, b - i * TLEAD, "F2", TS); });
    b -= (tl.length - 1) * TLEAD + 17;
    /* the facts, then the date */
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

  /* The rundown, as the strip over the app's script shows it: a block per
     scene across the text width, as wide as its read time — a sliver at
     least, so every scene shows — filled by its status (shot dark, ready
     amber, to do the raised grey), its number in it where it fits. With a
     target, a line at the target and the strip as long as the target or
     the script, whichever is longer. Under it the statuses' lamps and
     counts. `top` is the strip's top; returns where the script starts. */
  function rundownStrip(top) {
    var SH = 15, R = 1.5, NS = 6.5;
    var n = scenes.length;
    var total = facts.seconds, target = facts.target ? facts.target.seconds : 0;
    var span = Math.max(total, target);
    if (facts.target) top -= 12;          /* the target's label goes above */
    var G = n > 1 ? Math.min(1.5, TW * 0.2 / (n - 1)) : 0;
    var avail = TW - G * (n - 1);
    var minW = Math.min(2.5, avail / n);
    var room = Math.max(span > 0 ? avail * total / span : avail, n * minW);
    /* widths in proportion to the seconds, with the slivers held at minW
       and the rest sharing what they leave */
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
      /* on or past the script's end: the strip's end, which is the target */
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

  /* ---- the column heads, on every page of the script ---- */

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

  /* ---- a scene's gutter ---- */

  var NUM_SIZE = 12, TC_SIZE = 7, ST_SIZE = 7.5, READ_SIZE = 8.5;
  /* The number, the timecode it starts at beside it (under it, when the
     two would not fit side by side — a hundredth scene an hour in), and
     its status a line lower. */
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
    /* the read time at the right edge, boxed when it was set by hand
       (#179), as the app boxes it */
    var rw = pdfTextWidth(f.read, false, READ_SIZE);
    text(f.read, READ_R - rw, b, "F1", READ_SIZE, C.dim);
    if (f.readSet) stroke(C.borderStrong, 0.6, pdfRoundRectPath(READ_R - rw - 3.5, b - 3, rw + 7, 11.5, 2));
  }

  /* a scene carried onto another page says which it is, faint */
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
    /* The scene's video links (#135) head its Visual column, under its
       pictures: the site's name, faint, then the address in the Visual
       blue — whole, since on paper it is all there is to go on, and a
       link besides, since a PDF on a screen can be clicked. The name only
       when the two fit on one line: alone on a line of its own it reads
       as a heading, and the address says the same. */
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
    /* Runs from the document model (#85), annotated (exportRuns).
       Neighbours in one format that the stored markup kept in separate
       elements come out as one run, so a word split across two <strong>s
       is one word to wrap, never broken between its halves at the end of
       a line. */
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
        /* A tall/portrait image (a phone-screenshot crop, say) can have a
           natural height that alone exceeds a WHOLE page's usable height
           — safeAspect() only guards against a zero/negative width, not
           an extreme ratio. The draw guard further down only checks
           whether it fits from the current y, with no fallback if it
           can't fit ANYWHERE — even a fresh page — so it was silently
           skipped: never drawn, no warning. Cap it to the most room a
           scene ever gets — PAGE_ROOM, a fresh page's under its column
           heads — shrinking width to match, so there's always at least
           one page it fits on. */
        var maxH = PAGE_ROOM;
        /* ...and when nothing will follow the picture onto a later page —
           no visual text under it, and all the audio beside it fits on
           its page — the scene's rule is PIC_GAP + EMPTY under the
           picture on that same page, so the cap leaves room for that too,
           or the rule would fall under the bottom margin. With visual
           text the picture keeps the whole page and the text (and the
           rule) carry on overleaf. */
        if (!vLines.length && colHeight(aLines.length, AL) <= PAGE_ROOM) maxH = PAGE_ROOM - PIC_GAP - EMPTY;
        if (natH > maxH) { natW = natW * (maxH / natH); natH = maxH; }
        imgRef = { name: name, w: natW, h: natH };
        imgH = imgRef.h + PIC_GAP;
      } catch (e) { /* skip an unreadable image */ }
    }

    /* The rest of the gallery (#135): small pictures under the first, three
       to a line, each as wide as a third of the column and at most half as
       tall again, aspect kept. A line that does not fit where the row is
       drawn is left out, as the first picture is. */
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
      } catch (e) { /* skip an unreadable image */ }
    });
    stripLines.forEach(function (line) { imgH += line.h + STRIP_GAP; });

    /* The first scene stays on page 1 (see below), so its picture shrinks
       to fit under the title block with the rest of its gallery — unless
       that would leave it smaller than a thumbnail, when the scene goes
       over to page 2 after all. */
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

    /* The scene's height to its rule: its tallest column — Visual with its
       pictures, Audio, or the gutter. One that does not fit in what is
       left of the page starts the next page, where it gets PAGE_ROOM —
       unless it is already at the top of one, or it is the first scene:
       going over would leave page 1 its title block and nothing else, so
       it starts there and carries on overleaf if it must. */
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

    /* The loop below is the only thing that moves y past the picture, and
       a scene with no words in either column never enters it — so the
       next scene was once drawn over this one's picture. End such a scene
       where the loop would have ended it with nothing to draw: EMPTY
       under its pictures (vy), or under its gutter, whichever is lower. */
    if (!vLines.length && !aLines.length) y = Math.min(vy - EMPTY, top - g.h);

    /* A scene can be taller than a page. Draw what fits, break, and
       continue — otherwise the overflow is emitted below the page edge and
       disappears. Each column fits as many lines as keep every baseline
       on or above M (colFit), in its own leading. */
    var vRest = vLines, aRest = aLines;
    var vCursor = vy, aCursor = top;
    var drewPic = vy !== top;
    var onFirst = true;
    var guard = 0;
    while ((vRest.length || aRest.length) && guard++ < 400) {
      var vTake = vRest.slice(0, colFit(vCursor, VL)), aTake = aRest.slice(0, colFit(aCursor, AL));
      /* A chunk that finishes the scene puts its rule TAIL under the lower
         column's last baseline. Every baseline clearing M does not make
         that rule clear it: so when the rule would fall below M, the lower
         column's last line goes overleaf instead and the rule follows it
         there — never alone at the top of a page. Only a chunk that would
         finish the scene: one that fits whole passed the `need` check and
         never gets here short. */
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
      /* nothing fits — bail out safely. Unless this page holds the scene's
         picture: a picture filling its page left no room for a first line
         of visual text under it, and bailing here dropped that text and
         drew the rule at the top of the page, across the picture. */
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

  /* ---- the appendix ----

     Each part on a page of its own, headed by its name and one line that
     sums it up, and a bookmark to it; a part that runs onto another page
     says so at the top of that page. */
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

  /* split into discrete "\n" runs so pdfWrapRuns treats them as real
     line breaks, same convention toDocxRuns() uses for a line break */
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

  /* ---- production breakdown ----

     By category, as the Production panel groups it (breakdownGroups): a
     head per category — its dot, its plural, how many — then its items
     under the panel's columns, Item, Status (a lamp and its word),
     Scenes and Assigned to; under an item its notes, and the b-roll shots
     that need it (#149). */
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
      /* a group's head never ends a page on its own */
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

  /* ---- the b-roll shot list ----

     By scene, as the B-roll panel lists it (exportBrollScenes): "Scene
     04" and where it starts, how many of its shots are in the can; each
     shot a box, ticked in the b-roll teal once it is shot, its words, and
     under them where, who and which props — "Flagged" in red at the right
     of one that has to be shot again. */
  var shotGroups = exportBrollScenes();
  if (shotGroups.length) {
    section("B-roll shot list", brollSummaryText(shotGroups));
    var SL = 12;
    var shotItem = function (r) {
      var flagW = r.flagged ? pdfTextWidth("Flagged", true, 8) + 12 : 0;
      var bits = [];
      if (r.location) bits.push("Location: " + r.location);
      if (r.owner) bits.push("Assigned to: " + r.owner);
      if (r.props.length) bits.push("Props: " + r.propsWithStatus.join(", "));
      var more = bits.length ? pdfWrapRuns([{ text: bits.join(" · ") }], TW - 16, 8.5) : [];
      if (r.note) {
        more = more.concat(pdfWrapRuns(linesToRuns(r.note).map(function (run) { return Object.assign(run, { i: true }); }), TW - 16, 8.5));
      }
      var name = pdfWrapRuns([{ text: r.name }], TW - 16 - flagW, SIZE);
      return { r: r, name: name, more: tint(more, C.dim), h: 15 + (name.length + more.length - 1) * SL + 9 };
    };
    var shotHead = function (gr) {
      var b = y - 16;
      text(gr.label, M, b, "F2", 9.5);
      if (gr.start) text(gr.start, M + pdfTextWidth(gr.label, true, 9.5) + 6, b, "F1", 8.5, C.faint);
      var count = gr.done + "/" + gr.total + " shot";
      text(count, PW - M - pdfTextWidth(count, false, 8.5), b, "F1", 8.5, C.faint);
      ops.push(pdfRuleOp(M, b - 6, PW - M, C.borderStrong, 0.6));
      y = b - 6;
    };
    shotGroups.forEach(function (gr) {
      var list = gr.items.map(shotItem);
      if (y - 22 - list[0].h < M) sectionGoesOn("B-roll shot list");
      shotHead(gr);
      list.forEach(function (it, k) {
        if (y - it.h < M) { sectionGoesOn("B-roll shot list"); shotHead(gr); }
        var r = it.r, b = y - 15;
        ops.push(pdfCheckboxOp(M, b - 1.2, 8.5, r.shot, C.faint, C.broll));
        drawLines(it.name, M + 16, b, SIZE, SL);
        if (r.flagged) text("Flagged", PW - M - pdfTextWidth("Flagged", true, 8), b, "F2", 8, "C4302A");
        drawLines(it.more, M + 16, b - it.name.length * SL, 8.5, SL);
        y -= it.h;
        if (k < list.length - 1) ops.push(pdfRuleOp(M + 16, y, PW - M, C.border, 0.5));
      });
      y -= 12;
    });
  }

  /* ---- comments ----

     Numbered as the script's markers number them (exportComments): an
     open thread's number in a filled amber badge, then where it is —
     "Scene 03 · Audio" — who and when; a resolved one no number, and who
     resolved it. The words it is about, its body, its replies indented
     under it. */
  var comments = exportComments({ pieces: true });
  if (comments.length) {
    var openN = comments.filter(function (c) { return !c.resolved; }).length;
    section("Comments", [openN + " open"].concat(comments.length > openN ? [(comments.length - openN) + " resolved"] : []).join(" · "));
    var FULLW = TW;
    /* a thread's own lines sit CI in, its badge in front of them; a
       reply's RI */
    var CI = 20, RI = CI + 14;
    var badge = function (n, x, b) {
      var s = String(n), tw = pdfTextWidth(s, true, 7), w = Math.max(13, tw + 7);
      fill(C.audio, pdfBubblePath(x, b - 2.8, w, 11, 2.6, 0.8));
      text(s, x + (w - tw) / 2, b, "F2", 7, "FFFFFF");
    };

    /* Pictures in comments (#82 P6 stores them in the body as <img
       data-blob>). Each is a block of its own in the thread, in the order
       the body has it, at the body's indent: at most CIMG_MAXW of the
       column's width and CIMG_MAXH tall — well under a fresh page's room,
       so one always fits somewhere — its aspect kept, and never larger
       than its own pixels at 96 dpi (0.75pt a pixel), so a small picture
       stays small. A picture drawn twice is embedded once. One with no
       bytes, or that would not convert, prints as "[image unavailable]". */
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
        } catch (e) { /* unreadable — fall through to the note */ }
      }
      return { line: pdfWrapRuns([{ text: "[image unavailable]", i: true }], colW, SIZE)[0], x: x };
    }

    /* A comment's or reply's body as thread items — {line, x} and {pic,
       x} — in order. A body with no picture wraps exactly as it always
       did, "(empty)" and all. */
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

    /* Top CIMG_ABOVE below y (which a text line leaves LEAD under its
       baseline, clear of descenders); the next line's glyphs start
       CIMG_BELOW under the picture. */
    function drawCommentPic(pic, x) {
      var top = y - CIMG_ABOVE;
      if (pageImages.indexOf(pic.name) === -1) pageImages.push(pic.name);
      ops.push("q " + pic.w.toFixed(2) + " 0 0 " + pic.h.toFixed(2) + " " +
        x.toFixed(2) + " " + (top - pic.h).toFixed(2) + " cm /" + pic.name + " Do Q");
      y = top - pic.h - CIMG_BELOW;
    }

    comments.forEach(function (c) {
      /* where, in bold; who, when, whom it is assigned to and who
         resolved it, faint */
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

      /* Flattened into one ordered (line, indent) list and drawn one line
         at a time, each checked against the bottom margin as it goes —
         a single up-front `need` check (the old approach) only proved
         the START of the thread fit on the page; a long body or several
         replies still ran straight past the margin with no further
         check, silently losing whatever text landed below it. This
         mirrors how the scene-row loop above already paginates. */
      /* Each line carries its block — the header, the quote, the body, a
         reply's header, a reply's body — so the layout can tell a wrapped
         line from the start of the next part. */
      var threadLines = [], block = 0;
      function addBlock(items, x) {
        block++;
        items.forEach(function (it) {
          threadLines.push(it.pic ? it : { line: it.line || it, x: it.line ? it.x : x, block: block });
        });
      }
      addBlock(headerLines, M + CI);
      /* an open thread's number, in front of its header's first line */
      if (c.number) threadLines[0].badge = c.number;
      addBlock(quoteLines, M + CI);
      addBlock(bodyItems);
      replyBlocks.forEach(function (rb) {
        addBlock(rb.headerLines, M + RI);
        addBlock(rb.bodyItems);
      });

      /* `need`: how far below y the next thing reaches — a line's LEAD,
         or a picture's gap and height (commentBodyItems). Returns whether
         it started a new page. */
      function ensureCommentRoom(need) {
        if (y - (need || LEAD) < M) {
          sectionGoesOn("Comments");
          return true;
        }
        return false;
      }

      /* After a line y is its baseline - LEAD (what drawLines returns).
         The next line of the same block goes LEAD under it — baseline y —
         as the lines of a scene's text do; the first line of a block, or
         the first after a picture or a page break, goes SIZE lower still
         (baseline y - SIZE), the gap between the parts of a thread that
         predates the line-by-line room check. That check drew every line
         as a block's first, so a wrapped comment was spaced SIZE + LEAD
         (22.5pt) a line rather than LEAD (13pt). Either way the line's
         LEAD - SIZE of descender room below its baseline must clear M. */
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

  pages.push({ ops: ops, images: pageImages, links: pageLinks });

  /* The running footer, now the pages are counted. Marked as a pagination
     artifact, which is what it is: a reader that extracts or reads the
     text aloud leaves it out. */
  pages.forEach(function (pg, i) {
    pg.ops.push("/Artifact << /Type /Pagination /Subtype /Footer >> BDC");
    pdfFooterOps(title, i + 1, pages.length, PW, M, FOOT_Y, C.faint, C.border).forEach(function (op) { pg.ops.push(op); });
    pg.ops.push("EMC");
  });

  /* bookmarks only when there is somewhere to go: a script with no
     appendix is one part, and a sidebar with its one name in it is noise */
  return assemblePdf({ size: [PW, PH], pages: pages, images: images, info: { title: title },
    outline: outline.length > 1 ? outline : [] });
}

/* ================= packing list (gear, props — any category) =================

   One line per item: a box to tick, the name, and who's got it. Meant to
   be printed and physically checked off before a shoot day — the general
   breakdown (above) is a six-column spreadsheet trying to be a checklist,
   and that is not what "did we pack it" needs.

   Deliberately its own small PDF writer rather than a call into buildPdf()
   with different content: this needs one font pair and no images, where
   the script export needs four fonts, embedded JPEGs and two-column line
   wrapping. Sharing that machinery would mean either dragging the unused
   parts along for a page nobody asked for, or extracting a page-builder
   both could share — real refactor, real risk to a working, tested export,
   for a feature that is supposed to be simple. The ~30 lines of PDF
   object/xref plumbing below are the price of not touching buildPdf() to
   get it. */
export function buildPackingListPdf(catId) {
  var cat = tagCategory(catId);
  var PW = 612, PH = 792, M = 54, SIZE = 11, LEAD = 22;
  var items = productionEntries()
    .filter(function (e) { return e.cat.id === catId; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });

  var pages = [], ops = [], y = 0;
  function newPage() {
    if (ops.length) pages.push(ops);
    ops = [];
    y = PH - M;
  }
  function text(str, x, yy, font, size) {
    ops.push("BT /" + font + " " + size + " Tf 1 0 0 1 " +
      x.toFixed(2) + " " + yy.toFixed(2) + " Tm (" + pdfEscapeText(str) + ") Tj ET");
  }
  function box(x, yy, size) {
    ops.push("q 0.4 0.4 0.4 RG 0.9 w " + x.toFixed(2) + " " + yy.toFixed(2) + " " +
      size.toFixed(2) + " " + size.toFixed(2) + " re S Q");
  }
  function rule(x, yy, w) {
    ops.push("q 0.85 0.84 0.81 RG 0.6 w " + x.toFixed(2) + " " + yy.toFixed(2) + " m " +
      (x + w).toFixed(2) + " " + yy.toFixed(2) + " l S Q");
  }
  /* the category's name in its colour (#171), the rest of the heading in
     black: every item on the sheet is that category, so one mark at the
     top says it, where a dot on each line would only repeat it */
  var catHex = cat ? tagPrintColor(cat.id) : null;
  function header() {
    var lead = (S.state.title || "Untitled Script") + "  —  ";
    var name = cat ? cat.plural : catId;
    if (!catHex) {
      text(lead + name + " packing list", M, y - 20, "F2", 15);
    } else {
      var x = M;
      text(lead, x, y - 20, "F2", 15);
      x += pdfTextWidth(lead, true, 15);
      ops.push("q " + pdfRgb(catHex) + " rg");
      text(name, x, y - 20, "F2", 15);
      ops.push("Q");
      x += pdfTextWidth(name, true, 15);
      text(" packing list", x, y - 20, "F2", 15);
    }
    y -= 40;
  }

  newPage();
  header();

  if (!items.length) {
    text("Nothing tagged " + (cat ? cat.label : catId) + " yet.", M, y - SIZE, "F1", SIZE);
    y -= LEAD;
  }

  /* Unlike buildPdf()'s two columns, this line was never run through
     pdfWrapRuns — a long item name/status/owner combination just ran
     straight off the page's right edge (unwrapped, untruncated, simply
     invisible past x=612) instead of wrapping to a second line. */
  var ITEM_TEXT_W = PW - M * 2 - 18;
  /* a prop a b-roll shot needs says which (#149): the packer then knows
     it has to go out with the second unit too */
  var shotsFor = brollShotsByProp();
  items.forEach(function (item) {
    var owner = personById(item.owner);
    var st = tagStatus(item.status) || TAG_STATUSES[0];
    var shots = shotsFor[item.key] || [];
    var lineText = item.name + "   —   " + st.label + (owner ? "  ·  " + owner.name : "") +
      (shots.length ? "  ·  B-roll: " + shots.join(", ") : "");
    var wrapped = pdfWrapRuns([{ text: lineText }], ITEM_TEXT_W, SIZE);
    var need = wrapped.length * LEAD;
    if (y - need < M) { newPage(); header(); }
    box(M, y - SIZE + 1, 10);
    wrapped.forEach(function (lineSegs, li) {
      var lineStr = lineSegs.map(function (s) { return s.text; }).join("");
      text(lineStr, M + 18, y - SIZE, "F1", SIZE);
      if (li < wrapped.length - 1) y -= LEAD;
    });
    y -= LEAD;
    rule(M, y + 8, PW - M * 2);
  });

  pages.push(ops);

  /* ---- assemble: no images — see the note above ---- */
  return assembleTextPdf(pages, PW, PH, (S.state.title || "Untitled Script") + " — " + (cat ? cat.plural : catId) + " packing list");
}

/* assemblePdf (above) for a PDF of text and lines only, no images: the
   packing list's, and the b-roll shot list's (#150), which is the same
   kind of page. `pages` is one array of content-stream operators per
   page; `title` is the document's, for a viewer's title bar. */
function assembleTextPdf(pages, PW, PH, title) {
  return assemblePdf({
    size: [PW, PH],
    pages: pages.map(function (ops) { return { ops: ops }; }),
    info: { title: title }
  });
}

/* ================= the b-roll shot list (#150) =================

   What the full-page shot list's "Print shot list" makes: the list as it
   is on screen — its filter and its grouping (brollShotListForPrint,
   08d-broll-panel.js) — as a sheet to take on the day. A box per shot
   (ticked when it is in the can), the shot in bold, and under it the
   scene, who has it, the props it needs, the line it cuts against and the
   note, with FLAGGED in red in front of a flagged one's.

   A PDF, the way the packing lists are, rather than the browser's print of
   the page: the same file in the browser and the desktop app, one that can
   be sent to whoever is shooting as well as printed, and a page laid out
   for paper rather than a screen's table squeezed onto one. The cost is
   the one the packing list already pays — Helvetica's WinAnsi, so a
   character outside it prints as "?". */
export function buildShotListPdf(data) {
  var PW = 612, PH = 792, M = 54, W = PW - M * 2;
  var TEXT_X = M + 20, TEXT_W = W - 20;
  var pages = [], ops = [], y = 0;
  function newPage() {
    if (ops.length) pages.push(ops);
    ops = [];
    y = PH - M;
  }
  function text(str, x, yy, font, size, rgb) {
    ops.push((rgb ? rgb + " rg " : "") + "BT /" + font + " " + size + " Tf 1 0 0 1 " +
      x.toFixed(2) + " " + yy.toFixed(2) + " Tm (" + pdfEscapeText(str) + ") Tj ET" + (rgb ? " 0 g" : ""));
  }
  function rule(yy, gray) {
    ops.push("q " + (gray || "0.85 0.84 0.81") + " RG 0.6 w " + M.toFixed(2) + " " + yy.toFixed(2) + " m " +
      (M + W).toFixed(2) + " " + yy.toFixed(2) + " l S Q");
  }
  function box(x, yy, shot) {
    ops.push("q 0.4 0.4 0.4 RG 0.9 w " + x.toFixed(2) + " " + yy.toFixed(2) + " 10 10 re S Q");
    if (shot) {
      /* The tick is the b-roll colour, B's "done" (#169): the light
         theme's --broll, #00717F, since the sheet prints on white. It was
         the old --ok green. */
      ops.push("q 0 0.443 0.498 RG 1.6 w " + (x + 2).toFixed(2) + " " + (yy + 5).toFixed(2) + " m " +
        (x + 4.3).toFixed(2) + " " + (yy + 2.4).toFixed(2) + " l " + (x + 8.4).toFixed(2) + " " + (yy + 8.2).toFixed(2) + " l S Q");
    }
  }
  function lines(str, bold, size, width) {
    return pdfWrapRuns([{ text: str, b: bold }], width, size).map(function (segs) {
      return segs.map(function (seg) { return seg.text; }).join("");
    });
  }
  function header(first) {
    text(data.title + "  —  B-roll shot list", M, y - 16, "F2", first ? 15 : 11);
    y -= first ? 24 : 18;
    if (first) {
      text(data.summary + "   ·   " + data.scope, M, y - 10, "F1", 10, "0.42 0.4 0.35");
      y -= 24;
    }
  }

  newPage();
  header(true);
  if (!data.groups.length) text("No shots to list.", M, y - 11, "F1", 11);

  data.groups.forEach(function (g) {
    /* a group's heading never ends a page on its own */
    if (y - 60 < M) { newPage(); header(false); }
    var count = g.done + "/" + g.total + " shot";
    text(g.label, M, y - 12, "F2", 12);
    text(count, M + W - pdfTextWidth(count, false, 10), y - 12, "F1", 10, "0.42 0.4 0.35");
    y -= 18;
    rule(y, "0.55 0.53 0.5");
    y -= 4;
    g.items.forEach(function (r) {
      var name = lines(r.name, true, 11, TEXT_W);
      var details = [];
      var meta = [];
      if (r.scene) meta.push("Scene " + r.scene);
      if (r.location && g.label !== r.location) meta.push(r.location);
      if (r.owner) meta.push("Assigned: " + r.owner);
      if (r.props.length) meta.push("Props: " + (r.propsWithStatus || r.props).join(", "));
      if (meta.length) details.push({ text: meta.join("   ·   ") });
      if (r.cuts) details.push({ text: "Cuts against: \u201C" + r.cuts.replace(/\s+/g, " ") + "\u201D" });
      if (r.flagged || r.note) details.push({ text: (r.note || "").replace(/\s+/g, " "), flag: r.flagged });
      var wrapped = [];
      details.forEach(function (d) {
        var prefix = d.flag ? "FLAGGED" + (d.text ? "  —  " : "") : "";
        lines(prefix + d.text, false, 9.5, TEXT_W).forEach(function (l, i) {
          wrapped.push({ text: l, flag: d.flag && i === 0 ? prefix : "" });
        });
      });
      var need = 8 + name.length * 14 + wrapped.length * 12.5 + 6;
      if (y - need < M) { newPage(); header(false); }
      y -= 8;
      box(M, y - 10, r.shot);
      name.forEach(function (l) {
        text(l, TEXT_X, y - 9.5, "F2", 11, r.shot ? "0.42 0.4 0.35" : null);
        y -= 14;
      });
      wrapped.forEach(function (l) {
        if (l.flag) {
          text(l.flag, TEXT_X, y - 8, "F2", 9.5, "0.70 0.15 0.12");
          text(l.text.slice(l.flag.length), TEXT_X + pdfTextWidth(l.flag, true, 9.5), y - 8, "F1", 9.5, "0.3 0.29 0.26");
        } else {
          text(l.text, TEXT_X, y - 8, "F1", 9.5, "0.3 0.29 0.26");
        }
        y -= 12.5;
      });
      y -= 6;
      rule(y);
    });
    y -= 14;
  });

  pages.push(ops);
  return assembleTextPdf(pages, PW, PH, data.title + " — B-roll shot list");
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
