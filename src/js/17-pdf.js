import { S } from "./_state.js";
import { bytesForSync, recordFor, rowImageBytes } from "./02c-blobs.js";
import { morePictureRefs, pictureBytes, rowVideoLinks, videoLinkText } from "./02d-gallery.js";
import { cellOf, toDocxRuns } from "./04c-doc-model.js";
import { pad2 } from "./05-render.js";
import { tagCategory } from "./07-production-tags.js";
import { breakdownRows } from "./08-production-panels.js";
import { commentEntries } from "./10-comments.js";
import { concatBytes, latin1Bytes, tagPrintColor } from "./14-export.js";
import { PRINT_COLORS, TAG_STATUS_PRINT, breakdownGroups, exportDateText } from "./14b-export-kit.js";
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
   guessing it narrow silently swallows the space that follows it */
var HELV_HIGH = { 133: 1000, 145: 222, 146: 222, 147: 333, 148: 333, 149: 350, 150: 556, 151: 1000 };
var HELVB_HIGH = { 133: 1000, 145: 278, 146: 278, 147: 500, 148: 500, 149: 350, 150: 556, 151: 1000 };

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

/* `jpegs` is pdfImagesFor(S.state.rows)'s answer and `commentJpegs`
   pdfCommentImagesFor()'s. Without them only pictures that are already
   JPEG are drawn. */
export function buildPdf(jpegs, commentJpegs) {
  var PW = 612, PH = 792, M = 54;
  var GUT = 30, GAP = 16;
  var COLW = (PW - M * 2 - GUT - GAP) / 2;
  var SIZE = 9.5, LEAD = 13;
  /* A row's rule sits ROW_TAIL below the bottom of its columns: a column
     of n lines from cursor c ends (drawLines' return) at c - SIZE - n*LEAD,
     and the rule goes 6 under the lower column's end — so a column's last
     baseline sits LEAD + 6 = 19 above the rule, and the row as a whole
     (its taller column, picture included) plus ROW_TAIL is the height its
     rule needs to stay on or above the bottom margin. */
  var ROW_TAIL = SIZE + 6;
  /* The room a row gets on a fresh page: newPage() lands at PH - M, and
     the row loop's own "y -= 6" plus drawColumnHeaders()'s 8 + 16 take
     30 of it. */
  var PAGE_ROOM = PH - 2 * M - 30;

  var pages = [];
  var ops = [];
  var images = [];      /* {bytes, w, h, name} */
  var pageImages = [];  /* image names used on the current page */
  var y = 0;

  function newPage() {
    if (ops.length) pages.push({ ops: ops, images: pageImages });
    ops = [];
    pageImages = [];
    y = PH - M;
  }

  function fontFor(seg) {
    if (seg.b && seg.i) return "F4";
    if (seg.b) return "F2";
    if (seg.i) return "F3";
    return "F1";
  }

  function text(str, x, yy, font, size) {
    ops.push("BT /" + font + " " + size + " Tf 1 0 0 1 " +
      x.toFixed(2) + " " + yy.toFixed(2) + " Tm (" + pdfEscapeText(str) + ") Tj ET");
  }

  function rule(x, yy, w, thickness) {
    ops.push("q 0 0 0 rg " + x.toFixed(2) + " " + yy.toFixed(2) + " " +
      w.toFixed(2) + " " + thickness + " re f Q");
  }

  /* `size` is the size the lines were wrapped at (SIZE unless given): the
     breakdown's notes wrap at SIZE - 1, and drawn at SIZE their words ran
     into each other, the spaces between them swallowed */
  function drawLines(lines, x, startY, size) {
    var fs = size || SIZE;
    var yy = startY;
    lines.forEach(function (line) {
      var cx = x;
      line.forEach(function (seg) {
        if (seg.mark) {
          ops.push("q 0.988 0.890 0.541 rg " + cx.toFixed(2) + " " + (yy - 2.5).toFixed(2) +
            " " + seg.width.toFixed(2) + " " + (SIZE + 1).toFixed(2) + " re f Q");
        }
        if (seg.text.trim()) {
          /* a stage direction (#167): grey, as the editor shows it */
          if (seg.dir) ops.push("0.42 0.42 0.40 rg");
          /* a sound cue (#219): smaller, in the Music/SFX brick */
          else if (seg.cue) ops.push("0.671 0.255 0.243 rg");
          text(seg.text, cx, yy, fontFor(seg), seg.cue ? fs * CUE_SCALE : fs);
          if (seg.dir || seg.cue) ops.push("0 g");
          if (seg.u) rule(cx, yy - 1.6, seg.width, 0.5);
          if (seg.s) rule(cx, yy + SIZE * 0.28, seg.width, 0.5);
        }
        cx += seg.width;
      });
      yy -= LEAD;
    });
    return yy;
  }

  function columnHeight(lines) { return lines.length * LEAD; }

  /* Where drawLines() would leave a column of n lines started at cursor
     c (c - SIZE when n is 0), in the same arithmetic. */
  function columnEnd(c, n) {
    var yy = c - SIZE;
    for (var i = 0; i < n; i++) yy -= LEAD;
    return yy;
  }

  function drawColumnHeaders() {
    text("VISUAL", M + GUT, y, "F2", 8);
    text("AUDIO", M + GUT + COLW + GAP, y, "F2", 8);
    y -= 8;
    ops.push("q 0.85 0.84 0.81 RG 0.7 w " + M + " " + y.toFixed(2) + " m " + (PW - M) + " " + y.toFixed(2) + " l S Q");
    y -= 16;
  }

  newPage();

  /* title */
  text(S.state.title || "Untitled Script", M, y - 18, "F2", 18);
  y -= 40;
  drawColumnHeaders();

  S.state.rows.forEach(function (row, idx) {
    /* Runs from the document model (#85). Neighbours in one format that
       the stored markup kept in separate elements come out as one run, so
       a word split across two <strong>s is one word to wrap, never broken
       between its halves at the end of a line. */
    /* the scene's video links (#135) head its visual column, under its
       pictures, as the addresses themselves: a printed page has no link
       to click */
    var vRuns = toDocxRuns(cellOf(row.visualText));
    var videoRuns = [];
    rowVideoLinks(row).forEach(function (l) {
      videoRuns.push({ text: "Video: " + videoLinkText(l), i: true }, { text: "\n" });
    });
    if (videoRuns.length && !vRuns.length) videoRuns.pop();
    var vLines = pdfWrapRuns(videoRuns.concat(vRuns), COLW, SIZE);
    var aLines = pdfWrapRuns(toDocxRuns(cellOf(row.audioText)), COLW, SIZE);

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
        var natW = COLW, natH = COLW * dim.ratio;
        /* A tall/portrait image (a phone-screenshot crop, say) can have a
           natural height that alone exceeds a WHOLE page's usable height
           — safeAspect() only guards against a zero/negative width, not
           an extreme ratio. The draw guard further down only checks
           whether it fits from the current y, with no fallback if it
           can't fit ANYWHERE — even a fresh page — so it was silently
           skipped: never drawn, no warning. Cap it to the full usable
           page height here (PH - 2*M), shrinking width to match, so
           there's always at least one page it fits on. */
        /* The most vertical room an image can ever get is right after a
           forced page break: newPage() lands at PH - M, then the row
           loop's own "y -= 6" plus drawColumnHeaders()'s 8pt + 16pt of
           header/rule/gap eat 30pt of that before the image is drawn —
           capping to the whole page's height (PH - 2*M) still left it
           30pt short of fitting even there. */
        var maxH = PAGE_ROOM;
        /* ...and when nothing will follow the picture onto a later page —
           no visual text under it, and all the audio beside it fits on
           its page — the row's rule is ROW_TAIL + 8 under the picture on
           that same page, so the cap leaves room for that too, or the
           rule would fall up to 23.5pt below the bottom margin (30.5 for
           a picture at the old cap). With visual text the picture keeps
           the whole page and the text (and the rule) carry on overleaf. */
        if (!vLines.length && columnHeight(aLines) + ROW_TAIL <= PAGE_ROOM) maxH = PAGE_ROOM - 8 - ROW_TAIL;
        if (natH > maxH) { natW = natW * (maxH / natH); natH = maxH; }
        imgRef = { name: name, w: natW, h: natH };
        imgH = imgRef.h + 8;
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
    var thumbW = (COLW - STRIP_GAP * (STRIP_N - 1)) / STRIP_N;
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

    /* ROW_TAIL, not the 14 of the row gap below the rule: with 14 a row
       that passed this check by less than 1.5pt had its rule drawn up to
       1.5pt under the bottom margin. A row with nothing in it keeps the
       14 — it never enters the text loop, so its rule is drawn at its top
       (y), which the 14 already keeps inside the margin. */
    var empty = !vLines.length && !aLines.length && !imgRef && !stripLines.length;
    var need = Math.max(columnHeight(vLines) + imgH, columnHeight(aLines)) + (empty ? 14 : ROW_TAIL);
    if (y - need < M && y < PH - M - 40) { newPage(); y -= 6; drawColumnHeaders(); }

    text(pad2(idx + 1), M, y - SIZE, "F2", 8);

    var vy = y;
    if (imgRef && vy - imgRef.h >= M) {
      pageImages.push(imgRef.name);
      ops.push("q " + imgRef.w.toFixed(2) + " 0 0 " + imgRef.h.toFixed(2) + " " +
        (M + GUT).toFixed(2) + " " + (vy - imgRef.h).toFixed(2) + " cm /" + imgRef.name + " Do Q");
      vy -= imgRef.h + 8;
    }
    stripLines.forEach(function (line) {
      if (vy - line.h < M) return;
      line.items.forEach(function (it) {
        pageImages.push(it.name);
        ops.push("q " + it.w.toFixed(2) + " 0 0 " + it.h.toFixed(2) + " " +
          (M + GUT + it.x).toFixed(2) + " " + (vy - it.h).toFixed(2) + " cm /" + it.name + " Do Q");
      });
      vy -= line.h + STRIP_GAP;
    });

    /* The loop below is the only thing that moves y past the picture, and
       a row with no text in either column never enters it — so y dropped
       by the 14pt row gap alone and the next row was drawn over this
       row's picture. End such a row where the loop would have ended it
       with nothing to draw: its empty visual column starts below the
       picture (vy), so min(vCursor, aCursor) - SIZE - 6 = vy - SIZE - 6.
       A row with any text already gets that from the loop; a row with no
       picture (vy === y) is left exactly as it was. */
    if (vy !== y && !vLines.length && !aLines.length) y = vy - SIZE - 6;

    /* A row can be taller than a page. Draw what fits, break, and continue —
       otherwise the overflow is emitted below the page edge and disappears. */
    var vRest = vLines, aRest = aLines;
    var vCursor = vy, aCursor = y;
    var drewPic = vy !== y;
    var guard = 0;
    while ((vRest.length || aRest.length) && guard++ < 400) {
      /* A block of n lines starting at startY = cursor - SIZE has its
         last baseline at cursor - SIZE - (n-1)*LEAD, so the largest n
         whose baseline still clears the bottom margin M is
         floor((cursor - SIZE - M) / LEAD) + 1, not the bare floor() —
         the missing +1 undercounted by exactly one line on every
         multi-page row, forcing an unnecessary early page break and an
         ~LEAD-tall blank gap at the bottom of the column. */
      var vFit = Math.max(0, Math.floor((vCursor - SIZE - M) / LEAD) + 1);
      var aFit = Math.max(0, Math.floor((aCursor - SIZE - M) / LEAD) + 1);
      var vTake = vRest.slice(0, vFit), aTake = aRest.slice(0, aFit);
      /* A chunk that finishes the row puts the row's rule 6 under the
         lower column's end — 19 under its last baseline. Every baseline
         clearing M does not make that rule clear it: a row finishing on a
         continuation page could put it at M - 11.5, one starting a fresh
         page under a picture anywhere down to M - 19. So when the rule
         would fall below M, the lower column's last line goes overleaf
         instead and the rule follows it there — never alone at the top
         of a page. Only a chunk that would finish the row: a row that
         fits whole passed the `need` check and never gets here short. */
      if (vTake.length === vRest.length && aTake.length === aRest.length) {
        var vLow = columnEnd(vCursor, vTake.length), aLow = columnEnd(aCursor, aTake.length);
        if (Math.min(vLow, aLow) - 6 < M - 1e-6) {
          if (vTake.length && (vLow <= aLow || !aTake.length)) vTake = vTake.slice(0, -1);
          else if (aTake.length) aTake = aTake.slice(0, -1);
        }
      }
      var vEnd = vTake.length ? drawLines(vTake, M + GUT, vCursor - SIZE) : vCursor - SIZE;
      var aEnd = aTake.length ? drawLines(aTake, M + GUT + COLW + GAP, aCursor - SIZE) : aCursor - SIZE;
      vRest = vRest.slice(vTake.length);
      aRest = aRest.slice(aTake.length);
      if (!vRest.length && !aRest.length) {
        y = Math.min(vEnd, aEnd) - 6;
        break;
      }
      /* nothing fits — bail out safely. Unless this page holds the row's
         picture: a picture filling its page left no room for a first line
         of visual text under it, and bailing here dropped that text and
         drew the rule at the top of the page, across the picture. */
      if (!vTake.length && !aTake.length && !drewPic) break;
      drewPic = false;
      newPage();
      y -= 6;
      drawColumnHeaders();
      vCursor = y;
      aCursor = y;
    }

    ops.push("q 0.90 0.89 0.86 RG 0.5 w " + M + " " + y.toFixed(2) + " m " + (PW - M) + " " + y.toFixed(2) + " l S Q");
    y -= 14;
  });

  /* ---- production breakdown ---- */
  var breakdown = breakdownRows();
  if (breakdown.length) {
    newPage();
    text("Production breakdown", M, y - 18, "F2", 16);
    y -= 36;

    /* squeezed to make room for STATUS — 504pt of usable width between the
       margins, so every column here is already at its narrowest readable
       size; anything else new has to become a second line, not a column */
    var CATW = 62, NAMEW = 118, STATW = 62, OWNW = 82, NUMW = 44;
    var STATX = M + CATW + NAMEW;
    var OWNX = STATX + STATW;
    var NUMX = OWNX + OWNW;
    var SCENEX = NUMX + NUMW;
    var SCENEW = PW - M - SCENEX;

    function breakdownHeader() {
      text("CATEGORY", M, y, "F2", 8);
      text("ITEM", M + CATW, y, "F2", 8);
      text("STATUS", STATX, y, "F2", 8);
      text("ASSIGNED TO", OWNX, y, "F2", 8);
      text("MENTIONS", NUMX, y, "F2", 8);
      text("SCENES", SCENEX, y, "F2", 8);
      y -= 8;
      ops.push("q 0.85 0.84 0.81 RG 0.7 w " + M + " " + y.toFixed(2) + " m " +
        (PW - M) + " " + y.toFixed(2) + " l S Q");
      y -= 14;
    }
    breakdownHeader();

    breakdown.forEach(function (r) {
      var nameLines = pdfWrapRuns([{ text: r.name }], NAMEW - 10, SIZE);
      var statLines = pdfWrapRuns([{ text: r.statusLabel }], STATW - 10, SIZE);
      var ownLines = pdfWrapRuns([{ text: r.owner }], OWNW - 10, SIZE);
      var sceneLines = pdfWrapRuns([{ text: r.scenes.join(", ") }], SCENEW, SIZE);
      /* notes run the full width underneath rather than squeezing into a
         sixth column — they're free prose and would wrap to nothing usable */
      var noteLines = r.notes ? pdfWrapRuns([{ text: r.notes }], PW - M * 2 - CATW, SIZE - 1) : [];
      var bodyLines = Math.max(nameLines.length, statLines.length, ownLines.length,
                               sceneLines.length, 1);
      var need = (bodyLines + noteLines.length) * LEAD + 6;
      if (y - need < M) { newPage(); y -= 6; breakdownHeader(); }

      /* the category in its colour (#171): a dot, then the label, in the
         light theme's --tag-* — the same swatch the breakdown panel draws.
         "Music/SFX", the longest label, ends ~54pt in: the column is 62. */
      var catHex = tagPrintColor(r.catId);
      if (catHex) {
        ops.push("q " + pdfRgb(catHex) + " rg " + pdfCirclePath(M + 2.6, y - SIZE + 3.3, 2.6) + " f");
        text(r.categoryLabel, M + 8, y - SIZE, "F1", SIZE);
        ops.push("Q");
      } else {
        text(r.categoryLabel, M, y - SIZE, "F1", SIZE);
      }
      drawLines(nameLines, M + CATW, y - SIZE);
      drawLines(statLines, STATX, y - SIZE);
      drawLines(ownLines, OWNX, y - SIZE);
      text(String(r.mentions), NUMX, y - SIZE, "F1", SIZE);
      drawLines(sceneLines, SCENEX, y - SIZE);
      if (noteLines.length) {
        drawLines(noteLines, M + CATW, y - SIZE - bodyLines * LEAD, SIZE - 1);
      }
      y -= need;
      ops.push("q 0.93 0.92 0.90 RG 0.5 w " + M + " " + (y + 6).toFixed(2) + " m " +
        (PW - M) + " " + (y + 6).toFixed(2) + " l S Q");
    });
  }

  /* ---- comments ---- */
  var comments = commentEntries({ pieces: true });
  if (comments.length) {
    newPage();
    text("Comments", M, y - 18, "F2", 16);
    y -= 44;
    var FULLW = PW - M * 2;

    /* split into discrete "\n" runs so pdfWrapRuns treats them as real
       line breaks, same convention toDocxRuns() uses for a line break */
    function linesToRuns(str) {
      return String(str || "").split(/\r\n|\r|\n/).reduce(function (runs, line, i) {
        if (i > 0) runs.push({ text: "\n" });
        if (line) runs.push({ text: line });
        return runs;
      }, []);
    }

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
      var headerLines = pdfWrapRuns([{ text: c.location +
        (c.resolved ? " (resolved" + (c.resolvedBy ? " by " + c.resolvedBy : "") + ")" : "") +
        (c.assignee ? " [assigned to " + c.assignee + "]" : "") +
        "  —  " + c.author + (c.when ? ", " + c.when : ""), b: true }], FULLW, SIZE);
      var quoteLines = c.quoted ? pdfWrapRuns(linesToRuns("“" + c.quoted + "”"), FULLW - 12, SIZE) : [];
      var bodyItems = commentBodyItems(c, M + 12);
      var replyBlocks = c.replies.map(function (rp) {
        return {
          /* "↳" isn't in this PDF's WinAnsi glyph set (only the chars in
             WINANSI_MAP + 0x20-0xFF render) — plain ">" instead of "?" */
          headerLines: pdfWrapRuns([{ text: "> " + rp.author + (rp.when ? ", " + rp.when : "") + ":", b: true }], FULLW - 24, SIZE),
          bodyItems: commentBodyItems(rp, M + 24)
        };
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
      addBlock(headerLines, M);
      addBlock(quoteLines, M + 12);
      addBlock(bodyItems);
      replyBlocks.forEach(function (rb) {
        addBlock(rb.headerLines, M + 24);
        addBlock(rb.bodyItems);
      });

      /* `need`: how far below y the next thing reaches — a line's LEAD,
         or a picture's gap and height (commentBodyItems). Returns whether
         it started a new page. */
      function ensureCommentRoom(need) {
        if (y - (need || LEAD) < M) {
          newPage(); y -= 6;
          text("Comments (continued)", M, y - 12, "F2", 12);
          y -= 34;
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
        y = drawLines([b.line], b.x, follows ? y : y - SIZE);
        prevBlock = b.block;
      });
      y -= 6;
      ops.push("q 0.93 0.92 0.90 RG 0.5 w " + M + " " + (y + 4).toFixed(2) + " m " +
        (PW - M) + " " + (y + 4).toFixed(2) + " l S Q");
      y -= 10;
    });
  }

  pages.push({ ops: ops, images: pageImages });

  return assemblePdf({ size: [PW, PH], pages: pages, images: images, info: { title: S.state.title || "Untitled Script" } });
}

/* ================= the lists: packing lists and the shot list =================

   Two sheets people print and carry on a shoot day — a category's packing
   list and the b-roll shot list (#150, below) — drawn as one family, in
   the app's look (#169) and the script PDF's measure: Letter, its
   margins, Helvetica. The head is a small faint kicker saying what the
   sheet is, the heading large, and a line or two of what it covers and
   the day it was printed (exportDateText: a date, never a time, so the
   same list printed twice in a day is the same file); then the list; and
   on every page the running footer (pdfFooterOps), so a page that has
   come loose still says what it is from. Everything is drawn through the
   pieces above — a lamp, a box, a pin where the app has an icon — so no
   glyph outside WinAnsi reaches the page.

   Deliberately not buildPdf()'s machinery: these need no pictures, no
   two-column wrap and no links, and sharing a page-builder with the
   script export would put a working, tested writer at risk for sheets
   that are supposed to be simple. What the two share with each other is
   here: the page, the head, a line of runs. */

var LIST_PW = 612, LIST_PH = 792, LIST_M = 54;
/* The footer's baseline: its hairline sits 11 above it, clear of the
   bottom margin every list stops at. */
var LIST_FOOT_Y = 30;

/* A sheet as it is drawn: `ops` the page being drawn, `y` the cursor, top
   down from the top margin, and `body` whether anything but heads is on
   the page yet — a row too tall for a page is drawn where it is rather
   than starting page after empty page. finish() puts the last page in and
   gives every page its footer, last, since "Page n of N" wants N. */
function listSheet() {
  var sheet = { pages: [], ops: null, y: 0, body: false };
  sheet.newPage = function () {
    if (sheet.ops) sheet.pages.push(sheet.ops);
    sheet.ops = [];
    sheet.y = LIST_PH - LIST_M;
    sheet.body = false;
  };
  sheet.text = function (str, x, y, font, size, hex) {
    sheet.ops.push(pdfTextOp(str, x, y, font, size, hex));
  };
  sheet.push = function (ops) { Array.prototype.push.apply(sheet.ops, ops); };
  sheet.finish = function (footTitle) {
    if (sheet.ops) sheet.pages.push(sheet.ops);
    sheet.ops = null;
    var n = sheet.pages.length;
    sheet.pages.forEach(function (ops, i) {
      Array.prototype.push.apply(ops, pdfFooterOps(footTitle, i + 1, n, LIST_PW, LIST_M, LIST_FOOT_Y,
        PRINT_COLORS.faint, PRINT_COLORS.border));
    });
    return sheet.pages;
  };
  sheet.newPage();
  return sheet;
}

/* Words as they are printed: a line break or a run of spaces is one space
   (a line feed is no WinAnsi character; it would print as "?"). */
function listClean(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

/* Runs ({text, b, i}) wrapped to `width` at `size` — pdfWrapRuns, which
   measures each weight as it is drawn — with each line's words put back
   together, one piece per face: [[{text, b, i, width}]]. A line is then
   one string, or two where a label leads it, which is what a reader's
   copy and paste (and the tests) want. */
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

/* One of listWrap's lines, its baseline at (x, y): the bold pieces — a
   name, a label, "Flagged" — in `boldHex`, the rest in `hex`. */
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

/* A sheet's head, from the top of its first page: the kicker; the heading
   at 20pt, wrapped — however long, it never runs off the page, as the
   packing list's title once did — after a dot in `dotHex` when there is
   one; then each line of `meta`, wrapped, the first dim and any after it
   faint. Leaves the cursor under it. */
function listHead(sheet, kicker, heading, dotHex, meta) {
  var C = PRINT_COLORS, M = LIST_M, W = LIST_PW - 2 * LIST_M;
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

/* ================= packing list (gear, props — any category) =================

   Meant to be printed and ticked off by hand: packed for the shoot, and
   back after it — a box for each, under "Out" and "Back". The breakdown
   (the script PDF's, the spreadsheet) is a table to read; this is what
   "did we pack it, did it come back" needs. One row per item, in
   alphabetical order: the two boxes, the name in bold, its status as the
   panel shows it (a lamp and the word, TAG_STATUS_PRINT), who has it and
   the scenes it is in; under the name, dim, its notes and the b-roll
   shots that need it. An item not in hand yet — Needed, Sourcing — has
   its status word in amber, the sheet's one warm colour, so it is what
   the eye finds. At the end a line to sign for whoever packed it and
   whoever brought it back. Blank where nobody has it: a printed sheet
   invites the name in pen.

   The items are the breakdown's (breakdownGroups, 14b-export-kit.js), so
   the sheet says what the Production panel and every other export say
   about them — the scenes, the owner, and for a prop the b-roll shots
   that need it (#149: the packer then knows it goes out with the second
   unit too). */
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
  /* the category's dot in its colour (#171): every item on the sheet is
     that category, so one mark at the top says it, where a dot on each
     line would only repeat it */
  var meta = [title + " · " + exportDateText()];
  if (items.length) meta.push(packingSummary(items));
  listHead(sheet, "Packing list", heading, cat ? tagPrintColor(cat.id) : null, meta);

  if (!items.length) {
    sheet.text("Nothing tagged " + (cat ? cat.label : catId) + " yet.", M, sheet.y + 4, "F1", 11, C.dim);
    return assembleTextPdf(sheet.finish(docTitle), LIST_PW, LIST_PH, docTitle);
  }

  /* The columns, from the margin: each box under its head ("Out" and
     "Back" centred over them), then Item / Status / Owner / Scenes, each
     wrapping to its own width. */
  var BOX = 11, OUT_X = M + 1.4, BACK_X = M + 29.4;
  var ITEM_X = M + 58, ITEM_W = 188;
  var STATUS_X = M + 256;
  /* room for a double-barrelled surname on one line */
  var OWNER_X = M + 338, OWNER_W = 100;
  var SCENES_X = M + 448, SCENES_W = W - 448;
  /* the rows' measure: the first baseline under a row's top, the leads of
     its name, of the lines under it and of the other columns, and the room
     under its lowest line */
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
      /* still on the list, and still to pack, but flagged the way the
         panel flags it rather than left looking like a scene list */
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
    var look = TAG_STATUS_PRINT[r.status.id] || TAG_STATUS_PRINT.needed;
    var inHand = r.status.id === "have" || r.status.id === "returned";
    sheet.ops.push(pdfLampOp(look.lamp, STATUS_X + 3.5, base + 3.4, 3.5, look.color));
    sheet.text(r.status.label, STATUS_X + 11, base, "F1", 10, inHand ? look.color : C.audio);
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

  /* the sign-off, on one page: who packed it and when, who brought it all
     back and when — lines to write on, not underscores */
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

/* "6 items · 5 have it · 1 sourcing": what is in hand, what is on its
   way, what is still needed, what has gone back — the ones there are.
   `items` are breakdownRows(), each with its status's id and label. */
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
   08d-broll-panel.js) — as a sheet to take on the day. Each group headed
   as the page heads it — a location after its pin, a scene with the
   timecode it starts at — with how much of it is shot at the right, in
   the b-roll teal once all of it is. Each shot a box, ticked in teal when
   it is in the can (B's "done", #169); the shot in bold, dimmed once
   shot, and the lines under its marker in the script; then, dim, what
   else there is to know on the day: its scene and where that starts,
   where, who has it, the props it needs (each with its status), the line
   it cuts against in full, and "Flagged" in red in front of a flagged
   one's note. What the group head already says — the location, the
   scene, the person — the shots under it do not repeat.

   A PDF, the way the packing lists are, rather than the browser's print of
   the page: the same file in the browser and the desktop app, one that can
   be sent to whoever is shooting as well as printed, and a page laid out
   for paper rather than a screen's table squeezed onto one. */
var FLAG_PRINT = "C4302A";

export function buildShotListPdf(data) {
  var C = PRINT_COLORS, M = LIST_M, W = LIST_PW - 2 * LIST_M;
  var BOX = 11, TEXT_X = M + 22, TEXT_W = W - 22;
  /* a shot's measure: its first baseline under its top, the leads of its
     name, its description and its details, the gap before the details and
     the room under its last line */
  var TOP = 17, NAME_LEAD = 14, DESC_LEAD = 13, DETAIL_GAP = 13.5, DETAIL_LEAD = 12, TAIL = 10;
  var docTitle = data.title + " — B-roll shot list";

  var sheet = listSheet();
  listHead(sheet, "B-roll shot list", data.title, null, [data.summary + " · " + data.scope + " · " + exportDateText()]);
  if (!data.groups.length) sheet.text("No shots to list.", M, sheet.y + 4, "F1", 11, C.dim);

  /* One shot's lines, laid out ahead so its room can be asked for before
     any of it is drawn: [{line, size, dy (from the line above), hex,
     boldHex}] and its height. */
  function shotOf(r, g) {
    var out = [], height = 0;
    function add(runs, size, firstDy, lead, hex, boldHex) {
      listWrap(runs, TEXT_W, size).forEach(function (line, i) {
        var dy = out.length ? (i ? lead : firstDy) : TOP;
        out.push({ line: line, size: size, dy: dy, hex: hex, boldHex: boldHex });
        height += dy;
      });
    }
    add([{ text: listClean(r.name), b: true }], 11, NAME_LEAD, NAME_LEAD, C.text, r.shot ? C.faint : C.text);
    /* the description keeps its own lines, as the script has them */
    String(r.desc || "").split("\n").forEach(function (para) {
      if (listClean(para)) add([{ text: listClean(para) }], 10, DESC_LEAD, DESC_LEAD, r.shot ? C.faint : C.dim);
    });
    var meta = [];
    if (r.scene && g.kind !== "scene") meta.push("Scene " + r.scene + (r.start ? " · " + r.start : ""));
    if (r.location && g.kind !== "location") meta.push(listClean(r.location));
    if (r.owner && g.kind !== "person") meta.push("Assigned: " + listClean(r.owner));
    if (r.props.length) meta.push("Props: " + (r.propsWithStatus || r.props).map(listClean).join(", "));
    var details = [];
    if (meta.length) details.push([{ text: meta.join("  ·  ") }]);
    /* the narration it runs under, in full and set in italic, so the
       words to shoot and the words spoken over them read apart */
    if (r.cuts) details.push([{ text: "Cuts against: " }, { text: "“" + listClean(r.cuts) + "”", i: true }]);
    if (r.flagged) details.push([{ text: "Flagged", b: true }].concat(r.note ? [{ text: " — " + listClean(r.note) }] : []));
    else if (listClean(r.note)) details.push([{ text: "Note: " + listClean(r.note) }]);
    details.forEach(function (runs, i) {
      add(runs, 9, i ? DETAIL_LEAD : DETAIL_GAP, DETAIL_LEAD, C.dim, FLAG_PRINT);
    });
    return { lines: out, shot: r.shot, height: height + TAIL };
  }

  function drawShot(s) {
    var y = sheet.y;
    s.lines.forEach(function (l, i) {
      y -= l.dy;
      if (!i) sheet.ops.push(pdfCheckboxOp(M, y - 1.5, BOX, s.shot, C.faint, C.broll));
      sheet.push(listLineOps(l.line, TEXT_X, y, l.size, l.hex, l.boldHex));
    });
    sheet.y = y - TAIL;
    sheet.body = true;
  }

  /* A group's head: its label in bold after a pin for a location, the
     timecode a scene starts at after it, faint, and done/total at the
     right; on a page it runs on to, "(continued)" in place of the count.
     The flat list (no grouping) has none. */
  var LABEL_LEAD = 15;
  function pinned(g) { return g.kind === "location" && !g.none; }
  function headLines(g) {
    return listWrap([{ text: listClean(g.label), b: true }], W - 90 - (pinned(g) ? 13 : 0), 12);
  }
  function headHeight(g) { return g.label ? 13 + (headLines(g).length - 1) * LABEL_LEAD + 8 : 0; }
  function drawHead(g, continued) {
    if (!g.label) return;
    var base = sheet.y - 13, x = pinned(g) ? M + 13 : M;
    if (pinned(g)) sheet.ops.push(listPinOp(M + 4, base + 5.6, 3.2, tagPrintColor("location")));
    var lines = headLines(g), last = base;
    lines.forEach(function (line, i) {
      last = base - i * LABEL_LEAD;
      sheet.push(listLineOps(line, x, last, 12, C.text, C.text));
    });
    var end = x + lines[lines.length - 1].reduce(function (n, p) { return n + p.width; }, 0);
    if (g.kind === "scene" && g.start) sheet.text(g.start, end + 7, last, "F1", 10, C.faint);
    var right = continued ? "(continued)" : g.done + "/" + g.total + " shot";
    var allShot = !continued && g.total && g.done === g.total;
    sheet.text(right, M + W - pdfTextWidth(right, false, 9.5), base, "F1", 9.5, allShot ? C.broll : C.faint);
    sheet.y = last - 8;
    sheet.ops.push(pdfRuleOp(M, sheet.y, M + W, C.borderStrong, 0.75));
  }

  data.groups.forEach(function (g, gi) {
    var shots = g.items.map(function (r) { return shotOf(r, g); });
    if (gi) sheet.y -= 22;
    /* a group's head never ends a page on its own: it goes over with its
       first shot */
    if (sheet.y - headHeight(g) - (shots.length ? shots[0].height : 0) < M && sheet.body) sheet.newPage();
    drawHead(g, false);
    shots.forEach(function (s, i) {
      if (sheet.y - s.height < M && sheet.body) { sheet.newPage(); drawHead(g, true); }
      else if (i) sheet.ops.push(pdfRuleOp(TEXT_X, sheet.y, M + W, C.border, 0.5));
      drawShot(s);
    });
  });

  return assembleTextPdf(sheet.finish(docTitle), LIST_PW, LIST_PH, docTitle);
}

/* The pin the shot list's page heads a location with (#169), as a shape —
   a head and a point, in `hex`, with a hole — since WinAnsi has no glyph
   for it. (cx, cy) is the centre of its head, r its radius; the point is
   2.1 r below, its sides tangent to the head. */
function listPinOp(cx, cy, r, hex) {
  return "q " + pdfRgb(hex) + " rg " + pdfCirclePath(cx, cy, r) + " f " +
    n2(cx - r * 0.88) + " " + n2(cy - r * 0.476) + " m " + n2(cx) + " " + n2(cy - r * 2.1) + " l " +
    n2(cx + r * 0.88) + " " + n2(cy - r * 0.476) + " l h f 1 1 1 rg " + pdfCirclePath(cx, cy, r * 0.4) + " f Q";
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
