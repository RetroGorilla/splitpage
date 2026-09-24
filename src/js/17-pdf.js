import { S } from "./_state.js";
import { bytesForSync, recordFor, rowImageBytes } from "./02c-blobs.js";
import { morePictureRefs, pictureBytes, rowVideoLinks, videoLinkText } from "./02d-gallery.js";
import { cellOf, toDocxRuns } from "./04c-doc-model.js";
import { pad2 } from "./05-render.js";
import {
  TAG_STATUSES,
  personById,
  productionEntries,
  tagCategory,
  tagStatus
} from "./07-production-tags.js";
import { breakdownRows } from "./08-production-panels.js";
import { brollShotsByProp } from "./08c-broll.js";
import { commentEntries } from "./10-comments.js";
import { concatBytes, latin1Bytes, tagPrintColor } from "./14-export.js";
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

function pdfTextWidth(text, bold, size) {
  var w = 0;
  for (var i = 0; i < text.length; i++) w += pdfCharWidth(text[i], bold);
  return w * size / 1000;
}

function pdfEscapeText(s) {
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
function pdfRgb(hex) {
  return [0, 2, 4].map(function (i) { return (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3); }).join(" ");
}

/* A filled circle's path, centred on (cx, cy): four Bézier quarters, the
   usual 0.5523 control distance. The caller sets the colour and fills. */
function pdfCirclePath(cx, cy, r) {
  var k = r * 0.5523;
  function p(x, y) { return x.toFixed(2) + " " + y.toFixed(2); }
  return p(cx + r, cy) + " m " +
    p(cx + r, cy + k) + " " + p(cx + k, cy + r) + " " + p(cx, cy + r) + " c " +
    p(cx - k, cy + r) + " " + p(cx - r, cy + k) + " " + p(cx - r, cy) + " c " +
    p(cx - r, cy - k) + " " + p(cx - k, cy - r) + " " + p(cx, cy - r) + " c " +
    p(cx + k, cy - r) + " " + p(cx + r, cy - k) + " " + p(cx + r, cy) + " c h";
}

/* break styled runs into lines that fit maxWidth. A stage direction's
   runs (#167, toDocxRuns: dir, already bracketed) are set in italic and
   keep dir, which drawLines prints grey. */
function pdfWrapRuns(runs, maxWidth, size) {
  var lines = [], line = [], lineWidth = 0;

  function pushLine() { lines.push(line); line = []; lineWidth = 0; }

  runs.forEach(function (run) {
    if (run.dir) run = Object.assign({}, run, { i: true });
    var seg = function (text, width) {
      var s = { text: text, b: run.b, i: run.i, u: run.u, s: run.s, mark: run.mark, width: width };
      if (run.dir) s.dir = true;
      return s;
    };
    if (run.text === "\n") { pushLine(); return; }
    var words = run.text.split(/(\s+)/);
    words.forEach(function (word) {
      if (!word) return;
      var isSpace = /^\s+$/.test(word);
      if (isSpace && !line.length) return;
      var w = pdfTextWidth(word, run.b, size);
      if (!isSpace && lineWidth + w > maxWidth && line.length) pushLine();
      /* a single word longer than the column: hard-split it */
      if (!isSpace && w > maxWidth) {
        var chunk = "";
        for (var i = 0; i < word.length; i++) {
          if (pdfTextWidth(chunk + word[i], run.b, size) > maxWidth && chunk) {
            line.push(seg(chunk, pdfTextWidth(chunk, run.b, size)));
            pushLine();
            chunk = "";
          }
          chunk += word[i];
        }
        if (chunk) {
          var cw = pdfTextWidth(chunk, run.b, size);
          line.push(seg(chunk, cw));
          lineWidth += cw;
        }
        return;
      }
      line.push(seg(word, w));
      lineWidth += w;
    });
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
          text(seg.text, cx, yy, fontFor(seg), fs);
          if (seg.dir) ops.push("0 g");
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

  /* ---- assemble the file ---- */
  var chunks = [], offsets = [], length = 0;
  function put(data) {
    var bytes = typeof data === "string" ? latin1Bytes(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  }
  function startObj(num) { offsets[num] = length; put(num + " 0 obj\n"); }

  var numPages = pages.length;
  var OBJ_CATALOG = 1, OBJ_PAGES = 2, OBJ_F1 = 3, OBJ_F2 = 4, OBJ_F3 = 5, OBJ_F4 = 6;
  var firstPageObj = 7;
  var contentObjBase = firstPageObj + numPages;
  var imageObjBase = contentObjBase + numPages;
  var totalObjs = imageObjBase + images.length - 1;

  put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  startObj(OBJ_CATALOG);
  put("<< /Type /Catalog /Pages " + OBJ_PAGES + " 0 R >>\nendobj\n");

  startObj(OBJ_PAGES);
  var kids = [];
  for (var i = 0; i < numPages; i++) kids.push((firstPageObj + i) + " 0 R");
  put("<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + numPages + " >>\nendobj\n");

  [[OBJ_F1, "Helvetica"], [OBJ_F2, "Helvetica-Bold"],
   [OBJ_F3, "Helvetica-Oblique"], [OBJ_F4, "Helvetica-BoldOblique"]].forEach(function (f) {
    startObj(f[0]);
    put("<< /Type /Font /Subtype /Type1 /BaseFont /" + f[1] + " /Encoding /WinAnsiEncoding >>\nendobj\n");
  });

  pages.forEach(function (pg, idx) {
    startObj(firstPageObj + idx);
    var xobj = "";
    if (pg.images.length) {
      xobj = " /XObject << " + pg.images.map(function (name) {
        var oi = images.findIndex(function (im) { return im.name === name; });
        return "/" + name + " " + (imageObjBase + oi) + " 0 R";
      }).join(" ") + " >>";
    }
    put("<< /Type /Page /Parent " + OBJ_PAGES + " 0 R /MediaBox [0 0 " + PW + " " + PH + "]" +
      " /Resources << /Font << /F1 " + OBJ_F1 + " 0 R /F2 " + OBJ_F2 + " 0 R" +
      " /F3 " + OBJ_F3 + " 0 R /F4 " + OBJ_F4 + " 0 R >>" + xobj + " >>" +
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

  var xrefAt = length;
  var xref = "xref\n0 " + (totalObjs + 1) + "\n0000000000 65535 f \n";
  for (var o = 1; o <= totalObjs; o++) {
    var off = offsets[o] || 0;
    xref += ("0000000000" + off).slice(-10) + " 00000 n \n";
  }
  put(xref);
  put("trailer\n<< /Size " + (totalObjs + 1) + " /Root " + OBJ_CATALOG + " 0 R >>\nstartxref\n" + xrefAt + "\n%%EOF\n");

  return concatBytes(chunks);
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

  /* ---- assemble: one font pair, no images — see the note above ---- */
  return assembleTextPdf(pages, PW, PH);
}

/* The object and xref plumbing for a PDF of text and lines only — one
   Helvetica pair (F1 regular, F2 bold), no images: the packing list's, and
   the b-roll shot list's (#150), which is the same kind of page. `pages`
   is one array of content-stream operators per page. */
function assembleTextPdf(pages, PW, PH) {
  var chunks = [], offsets = [], length = 0;
  function put(data) {
    var bytes = typeof data === "string" ? latin1Bytes(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  }
  function startObj(num) { offsets[num] = length; put(num + " 0 obj\n"); }

  var numPages = pages.length;
  var OBJ_CATALOG = 1, OBJ_PAGES = 2, OBJ_F1 = 3, OBJ_F2 = 4;
  var firstPageObj = 5;
  var contentObjBase = firstPageObj + numPages;
  var totalObjs = contentObjBase + numPages - 1;

  put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  startObj(OBJ_CATALOG);
  put("<< /Type /Catalog /Pages " + OBJ_PAGES + " 0 R >>\nendobj\n");
  startObj(OBJ_PAGES);
  var kids = [];
  for (var i = 0; i < numPages; i++) kids.push((firstPageObj + i) + " 0 R");
  put("<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + numPages + " >>\nendobj\n");
  [[OBJ_F1, "Helvetica"], [OBJ_F2, "Helvetica-Bold"]].forEach(function (f) {
    startObj(f[0]);
    put("<< /Type /Font /Subtype /Type1 /BaseFont /" + f[1] + " /Encoding /WinAnsiEncoding >>\nendobj\n");
  });
  pages.forEach(function (pg, idx) {
    startObj(firstPageObj + idx);
    put("<< /Type /Page /Parent " + OBJ_PAGES + " 0 R /MediaBox [0 0 " + PW + " " + PH + "]" +
      " /Resources << /Font << /F1 " + OBJ_F1 + " 0 R /F2 " + OBJ_F2 + " 0 R >> >>" +
      " /Contents " + (contentObjBase + idx) + " 0 R >>\nendobj\n");
  });
  pages.forEach(function (pg, idx) {
    var stream = pg.join("\n");
    startObj(contentObjBase + idx);
    put("<< /Length " + latin1Bytes(stream).length + " >>\nstream\n");
    put(stream);
    put("\nendstream\nendobj\n");
  });
  var xrefAt = length;
  var xref = "xref\n0 " + (totalObjs + 1) + "\n0000000000 65535 f \n";
  for (var o = 1; o <= totalObjs; o++) {
    var off = offsets[o] || 0;
    xref += ("0000000000" + off).slice(-10) + " 00000 n \n";
  }
  put(xref);
  put("trailer\n<< /Size " + (totalObjs + 1) + " /Root " + OBJ_CATALOG + " 0 R >>\nstartxref\n" + xrefAt + "\n%%EOF\n");

  return concatBytes(chunks);
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
  return assembleTextPdf(pages, PW, PH);
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
