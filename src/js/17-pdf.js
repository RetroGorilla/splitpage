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

  /* break styled runs into lines that fit maxWidth */
  function pdfWrapRuns(runs, maxWidth, size) {
    var lines = [], line = [], lineWidth = 0;

    function pushLine() { lines.push(line); line = []; lineWidth = 0; }

    runs.forEach(function (run) {
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
              line.push({ text: chunk, b: run.b, i: run.i, u: run.u, s: run.s, mark: run.mark, width: pdfTextWidth(chunk, run.b, size) });
              pushLine();
              chunk = "";
            }
            chunk += word[i];
          }
          if (chunk) {
            var cw = pdfTextWidth(chunk, run.b, size);
            line.push({ text: chunk, b: run.b, i: run.i, u: run.u, s: run.s, mark: run.mark, width: cw });
            lineWidth += cw;
          }
          return;
        }
        line.push({ text: word, b: run.b, i: run.i, u: run.u, s: run.s, mark: run.mark, width: w });
        lineWidth += w;
      });
    });
    if (line.length) pushLine();
    return lines;
  }

  function buildPdf() {
    var PW = 612, PH = 792, M = 54;
    var GUT = 30, GAP = 16;
    var COLW = (PW - M * 2 - GUT - GAP) / 2;
    var SIZE = 9.5, LEAD = 13;

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

    function drawLines(lines, x, startY) {
      var yy = startY;
      lines.forEach(function (line) {
        var cx = x;
        line.forEach(function (seg) {
          if (seg.mark) {
            ops.push("q 0.988 0.890 0.541 rg " + cx.toFixed(2) + " " + (yy - 2.5).toFixed(2) +
              " " + seg.width.toFixed(2) + " " + (SIZE + 1).toFixed(2) + " re f Q");
          }
          if (seg.text.trim()) {
            text(seg.text, cx, yy, fontFor(seg), SIZE);
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

    function drawColumnHeaders() {
      text("VISUAL", M + GUT, y, "F2", 8);
      text("AUDIO", M + GUT + COLW + GAP, y, "F2", 8);
      y -= 8;
      ops.push("q 0.85 0.84 0.81 RG 0.7 w " + M + " " + y.toFixed(2) + " m " + (PW - M) + " " + y.toFixed(2) + " l S Q");
      y -= 16;
    }

    newPage();

    /* title */
    text(state.title || "Untitled Script", M, y - 18, "F2", 18);
    y -= 40;
    drawColumnHeaders();

    state.rows.forEach(function (row, idx) {
      var vLines = pdfWrapRuns(htmlToRuns(row.visualText), COLW, SIZE);
      var aLines = pdfWrapRuns(htmlToRuns(row.audioText), COLW, SIZE);

      var imgH = 0, imgRef = null;
      if (row.visualImage) {
        try {
          var bytes = dataUrlToBytes(row.visualImage);
          var dim = safeAspect(jpegSize(bytes));
          var name = "Im" + (images.length + 1);
          images.push({ bytes: bytes, w: dim.w, h: dim.h, name: name });
          imgRef = { name: name, w: COLW, h: COLW * dim.ratio };
          imgH = imgRef.h + 8;
        } catch (e) { /* skip an unreadable image */ }
      }

      var need = Math.max(columnHeight(vLines) + imgH, columnHeight(aLines)) + 14;
      if (y - need < M && y < PH - M - 40) { newPage(); y -= 6; drawColumnHeaders(); }

      text(pad2(idx + 1), M, y - SIZE, "F2", 8);

      var vy = y;
      if (imgRef && vy - imgRef.h >= M) {
        pageImages.push(imgRef.name);
        ops.push("q " + imgRef.w.toFixed(2) + " 0 0 " + imgRef.h.toFixed(2) + " " +
          (M + GUT).toFixed(2) + " " + (vy - imgRef.h).toFixed(2) + " cm /" + imgRef.name + " Do Q");
        vy -= imgRef.h + 8;
      }

      /* A row can be taller than a page. Draw what fits, break, and continue —
         otherwise the overflow is emitted below the page edge and disappears. */
      var vRest = vLines, aRest = aLines;
      var vCursor = vy, aCursor = y;
      var guard = 0;
      while ((vRest.length || aRest.length) && guard++ < 400) {
        var vFit = Math.max(0, Math.floor((vCursor - SIZE - M) / LEAD));
        var aFit = Math.max(0, Math.floor((aCursor - SIZE - M) / LEAD));
        var vTake = vRest.slice(0, vFit), aTake = aRest.slice(0, aFit);
        var vEnd = vTake.length ? drawLines(vTake, M + GUT, vCursor - SIZE) : vCursor - SIZE;
        var aEnd = aTake.length ? drawLines(aTake, M + GUT + COLW + GAP, aCursor - SIZE) : aCursor - SIZE;
        vRest = vRest.slice(vTake.length);
        aRest = aRest.slice(aTake.length);
        if (!vRest.length && !aRest.length) {
          y = Math.min(vEnd, aEnd) - 6;
          break;
        }
        if (!vTake.length && !aTake.length) break;   /* nothing fits — bail out safely */
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

        text(r.categoryLabel, M, y - SIZE, "F1", SIZE);
        drawLines(nameLines, M + CATW, y - SIZE);
        drawLines(statLines, STATX, y - SIZE);
        drawLines(ownLines, OWNX, y - SIZE);
        text(String(r.mentions), NUMX, y - SIZE, "F1", SIZE);
        drawLines(sceneLines, SCENEX, y - SIZE);
        if (noteLines.length) {
          drawLines(noteLines, M + CATW, y - SIZE - bodyLines * LEAD);
        }
        y -= need;
        ops.push("q 0.93 0.92 0.90 RG 0.5 w " + M + " " + (y + 6).toFixed(2) + " m " +
          (PW - M) + " " + (y + 6).toFixed(2) + " l S Q");
      });
    }

    /* ---- comments ---- */
    var comments = commentEntries();
    if (comments.length) {
      newPage();
      text("Comments", M, y - 18, "F2", 16);
      y -= 44;
      var FULLW = PW - M * 2;

      /* split into discrete "\n" runs so pdfWrapRuns treats them as real
         line breaks, same convention htmlToRuns() uses for <br> */
      function linesToRuns(str) {
        return String(str || "").split(/\r\n|\r|\n/).reduce(function (runs, line, i) {
          if (i > 0) runs.push({ text: "\n" });
          if (line) runs.push({ text: line });
          return runs;
        }, []);
      }

      comments.forEach(function (c) {
        var headerLines = pdfWrapRuns([{ text: c.location + (c.resolved ? " (resolved)" : "") +
          "  —  " + c.author + (c.when ? ", " + c.when : ""), b: true }], FULLW, SIZE);
        var quoteLines = c.quoted ? pdfWrapRuns(linesToRuns("“" + c.quoted + "”"), FULLW - 12, SIZE) : [];
        var bodyLines = pdfWrapRuns(linesToRuns(c.body || "(empty)"), FULLW - 12, SIZE);
        var replyBlocks = c.replies.map(function (rp) {
          return {
            /* "↳" isn't in this PDF's WinAnsi glyph set (only the chars in
               WINANSI_MAP + 0x20-0xFF render) — plain ">" instead of "?" */
            headerLines: pdfWrapRuns([{ text: "> " + rp.author + (rp.when ? ", " + rp.when : "") + ":", b: true }], FULLW - 24, SIZE),
            bodyLines: pdfWrapRuns(linesToRuns(rp.body || "(empty)"), FULLW - 24, SIZE)
          };
        });

        var need = columnHeight(headerLines) + columnHeight(quoteLines) + columnHeight(bodyLines) + 14;
        replyBlocks.forEach(function (rb) { need += columnHeight(rb.headerLines) + columnHeight(rb.bodyLines); });
        if (y - need < M) {
          newPage(); y -= 6;
          text("Comments (continued)", M, y - 12, "F2", 12);
          y -= 34;
        }

        y = drawLines(headerLines, M, y - SIZE);
        if (quoteLines.length) y = drawLines(quoteLines, M + 12, y - SIZE);
        y = drawLines(bodyLines, M + 12, y - SIZE);
        replyBlocks.forEach(function (rb) {
          y = drawLines(rb.headerLines, M + 24, y - SIZE);
          y = drawLines(rb.bodyLines, M + 24, y - SIZE);
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
  function buildPackingListPdf(catId) {
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
    function header() {
      text((state.title || "Untitled Script") + "  —  " + (cat ? cat.plural : catId) + " packing list",
        M, y - 20, "F2", 15);
      y -= 40;
    }

    newPage();
    header();

    if (!items.length) {
      text("Nothing tagged " + (cat ? cat.label : catId) + " yet.", M, y - SIZE, "F1", SIZE);
      y -= LEAD;
    }

    items.forEach(function (item) {
      if (y - LEAD < M) { newPage(); header(); }
      var owner = personById(item.owner);
      var st = tagStatus(item.status) || TAG_STATUSES[0];
      box(M, y - SIZE + 1, 10);
      text(item.name + "   —   " + st.label + (owner ? "  ·  " + owner.name : ""),
        M + 18, y - SIZE, "F1", SIZE);
      y -= LEAD;
      rule(M, y + 8, PW - M * 2);
    });

    pages.push(ops);

    /* ---- assemble: one font pair, no images — see the note above ---- */
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

