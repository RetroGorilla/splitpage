  /* ================= .docx writing ================= */

  function dataUrlToBytes(dataUrl) {
    var comma = dataUrl.indexOf(",");
    var b64 = dataUrl.slice(comma + 1);
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* read intrinsic pixel size straight out of the JPEG's SOF marker */
  function jpegSize(bytes) {
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

  /* never divide by a bogus declared width */
  function safeAspect(dim) {
    var w = dim && dim.w > 0 ? dim.w : 800;
    var h = dim && dim.h > 0 ? dim.h : 450;
    return { w: w, h: h, ratio: h / w };
  }

  /* Column widths that actually fit what's in them, instead of a fixed guess
     — a Notes column full of real prose gets more room than a two-word
     Status column, whatever the content looks like this run. `mins` is a
     floor in the SAME character-count units as `longest`, not a twip width —
     mixing the two would make the floor win every time, since a sane twip
     minimum (hundreds) always dwarfs a column's actual character count.
     Each column's weight is its longest cell (header included, so a header
     alone always fits), clamped so one very long outlier can't starve every
     other column; widths are then totalWidth split proportionally to those
     weights, with the rounding remainder folded into the last column so the
     grid always sums to exactly totalWidth. */
  function fitColumnWidths(totalWidth, minChars, headers, rowsCells) {
    var weights = headers.map(function (h, i) {
      var longest = String(h).length;
      rowsCells.forEach(function (r) {
        var len = String(r[i] == null ? "" : r[i]).length;
        if (len > longest) longest = len;
      });
      return Math.max(minChars[i], Math.min(40, longest));
    });
    var sum = weights.reduce(function (a, b) { return a + b; }, 0);
    var widths = weights.map(function (w) { return Math.floor(totalWidth * w / sum); });
    var used = widths.reduce(function (a, b) { return a + b; }, 0);
    widths[widths.length - 1] += totalWidth - used;
    return widths;
  }

  function docxRunsXml(html, rels) {
    var runs = htmlToRuns(html);
    if (!runs.length) return '<w:p/>';
    var out = '<w:p>';
    var openLink = null;
    runs.forEach(function (r) {
      if (r.text === "\n") { out += '<w:r><w:br/></w:r>'; return; }
      var props = "";
      if (r.b) props += "<w:b/>";
      if (r.i) props += "<w:i/>";
      if (r.u) props += '<w:u w:val="single"/>';
      if (r.s) props += "<w:strike/>";
      if (r.mark) props += '<w:highlight w:val="yellow"/>';
      if (r.href) props += '<w:color w:val="1155CC"/><w:u w:val="single"/>';
      var run = '<w:r>' + (props ? "<w:rPr>" + props + "</w:rPr>" : "") +
        '<w:t xml:space="preserve">' + xmlEscape(r.text) + '</w:t></w:r>';
      if (r.href) {
        var rid = rels.addLink(r.href);
        out += '<w:hyperlink r:id="' + rid + '">' + run + '</w:hyperlink>';
      } else {
        out += run;
      }
    });
    if (openLink) out += "</w:hyperlink>";
    return out + '</w:p>';
  }

  function docxCellXml(inner, widthDxa) {
    return '<w:tc><w:tcPr><w:tcW w:w="' + widthDxa + '" w:type="dxa"/>' +
      '<w:tcMar><w:top w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/>' +
      '<w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>' +
      (inner || "<w:p/>") + '</w:tc>';
  }

  /* A left-indented paragraph for plain (already-unformatted) multi-line
     text — comment bodies and quotes, not the rich row content that
     docxRunsXml() handles. Each source line becomes its own <w:t>, joined
     by <w:br/> so line breaks survive instead of collapsing to one line. */
  function docxLineBreakParagraph(text, indentDxa, rPr) {
    var runXml = String(text || "").split(/\r\n|\r|\n/).map(function (line, i) {
      return (i > 0 ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + xmlEscape(line) + '</w:t>';
    }).join('');
    return '<w:p><w:pPr><w:spacing w:after="120"/><w:ind w:left="' + indentDxa + '"/></w:pPr>' +
      '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + runXml + '</w:r></w:p>';
  }

  /* One <w:tblPr> shape shared by both tables in the script export: a named
     table style carries the header shading and row banding (styles.xml),
     tblLook turns those conditional formats on for THIS table, and the
     explicit borders stay as direct formatting so the hairline rule still
     shows in viewers that ignore table styles entirely (older LibreOffice,
     some online renderers). */
  var TABLE_PR = '<w:tblStyle w:val="SplitpageTable"/>' +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (side) {
      return '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="D9D5CC"/>';
    }).join("") + '</w:tblBorders>';

  /* A narrow centered cell for the scene-number column — its own small
     builder rather than a new docxCellXml() parameter, since every other
     caller of docxCellXml wants the plain left-aligned shape. */
  function docxNumberCellXml(text, widthDxa, isHeader) {
    var rPr = isHeader
      ? '<w:b/><w:caps/><w:sz w:val="18"/>'
      : '<w:b/><w:color w:val="8A6D3B"/>';
    return '<w:tc><w:tcPr><w:tcW w:w="' + widthDxa + '" w:type="dxa"/><w:vAlign w:val="center"/>' +
      '<w:tcMar><w:top w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/>' +
      '<w:left w:w="60" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tcMar></w:tcPr>' +
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr>' + rPr +
      '</w:rPr><w:t xml:space="preserve">' + xmlEscape(text) + '</w:t></w:r></w:p></w:tc>';
  }

  function buildDocx() {
    /* twentieths of a point, inside 1080-twip margins on a Letter page
       (12240 wide) — 10080 usable, split into a narrow scene-number column
       and two even Visual/Audio columns so scene numbering has somewhere to
       live without turning the two-column shape into a three-column one the
       importer would have to unlearn (mapTableColumns treats an unmatched
       extra column as exactly this: a scene-number column to ignore). */
    var COL_NO = 700;
    var COL = (10080 - COL_NO) / 2;
    var media = [];
    var links = [];
    var rels = {
      addLink: function (href) {
        links.push(href);
        return "rIdL" + links.length;
      },
      addImage: function (bytes) {
        media.push(bytes);
        return { rid: "rIdM" + media.length, name: "image" + media.length + ".jpeg" };
      }
    };

    var body = "";
    body += '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>' +
      '<w:r><w:t xml:space="preserve">' + xmlEscape(state.title || "Untitled Script") + '</w:t></w:r></w:p>';

    var rowsXml = "";
    /* header row */
    rowsXml += '<w:tr><w:trPr><w:tblHeader/></w:trPr>' +
      docxNumberCellXml("No.", COL_NO, true) +
      docxCellXml('<w:p><w:r><w:rPr><w:b/><w:caps/><w:sz w:val="18"/></w:rPr><w:t>Visual</w:t></w:r></w:p>', COL) +
      docxCellXml('<w:p><w:r><w:rPr><w:b/><w:caps/><w:sz w:val="18"/></w:rPr><w:t>Audio</w:t></w:r></w:p>', COL) +
      '</w:tr>';

    state.rows.forEach(function (row, idx) {
      var visual = "";
      if (row.visualImage) {
        try {
          var bytes = dataUrlToBytes(row.visualImage);
          var dim = safeAspect(jpegSize(bytes));
          var img = rels.addImage(bytes);
          var maxW = 2750000; /* ~2.9in in EMU, fits the cell */
          var cx = Math.round(Math.min(maxW, dim.w * 9525));
          var cy = Math.round(cx * dim.ratio);
          visual += '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
            '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
            '<wp:docPr id="' + media.length + '" name="' + img.name + '"/><wp:cNvGraphicFramePr/>' +
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
            '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + media.length + '" name="' + img.name + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
            '<pic:blipFill><a:blip r:embed="' + img.rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
            '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
            '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
        } catch (e) { /* unreadable image — skip it rather than break the export */ }
      }
      visual += docxRunsXml(row.visualText, rels);
      rowsXml += '<w:tr>' + docxNumberCellXml(pad2(idx + 1), COL_NO, false) +
        docxCellXml(visual, COL) + docxCellXml(docxRunsXml(row.audioText, rels), COL) + '</w:tr>';
    });

    body += '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' + TABLE_PR + '</w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="' + COL_NO + '"/><w:gridCol w:w="' + COL + '"/><w:gridCol w:w="' + COL + '"/></w:tblGrid>' +
      rowsXml + '</w:tbl>';

    var breakdown = breakdownRows();
    if (breakdown.length) {
      body += '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
        '<w:r><w:t>Production breakdown</w:t></w:r></w:p>';

      var bHeaders = ["Category", "Item", "Status", "Assigned to", "Mentions", "Scenes", "Notes"];
      /* floors in characters, not twips — see fitColumnWidths above */
      var bMins = [10, 10, 8, 10, 6, 8, 10];
      var bCellRows = breakdown.map(function (r) {
        return [r.categoryLabel, r.name, r.statusLabel, r.owner, String(r.mentions), r.scenes.join(", "), r.notes];
      });
      /* columns sized to what's actually in them (fitColumnWidths above),
         not a fixed guess a long Notes column would just wrap badly under */
      var bCols = fitColumnWidths(10080, bMins, bHeaders, bCellRows);

      var bRows = '<w:tr><w:trPr><w:tblHeader/></w:trPr>' +
        bHeaders.map(function (h, i) {
          return docxCellXml('<w:p><w:r><w:rPr><w:b/><w:caps/><w:sz w:val="18"/></w:rPr>' +
            '<w:t>' + h + '</w:t></w:r></w:p>', bCols[i]);
        }).join("") + '</w:tr>';

      bCellRows.forEach(function (cells) {
        bRows += '<w:tr>' + cells.map(function (text, i) {
          return docxCellXml('<w:p><w:r><w:t xml:space="preserve">' + xmlEscape(text) +
            '</w:t></w:r></w:p>', bCols[i]);
        }).join("") + '</w:tr>';
      });

      body += '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' + TABLE_PR + '</w:tblPr>' +
        '<w:tblGrid>' + bCols.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join("") + '</w:tblGrid>' +
        bRows + '</w:tbl>';
    }

    var comments = commentEntries();
    if (comments.length) {
      body += '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
        '<w:r><w:t>Comments</w:t></w:r></w:p>';
      comments.forEach(function (c) {
        body += '<w:p><w:pPr><w:spacing w:before="200" w:after="20"/></w:pPr>' +
          '<w:r><w:rPr><w:b/><w:color w:val="8A6D3B"/></w:rPr><w:t xml:space="preserve">' + xmlEscape(c.location) +
          (c.resolved ? ' (resolved)' : '') + '</w:t></w:r>' +
          '<w:r><w:rPr><w:i/><w:color w:val="7A7364"/></w:rPr><w:t xml:space="preserve">' +
          xmlEscape('  —  ' + c.author + (c.when ? ', ' + c.when : '')) + '</w:t></w:r></w:p>';
        if (c.quoted) {
          body += docxLineBreakParagraph('“' + c.quoted + '”', 360, '<w:i/>');
        }
        body += docxLineBreakParagraph(c.body || '(empty)', 360, '');
        c.replies.forEach(function (rp) {
          body += '<w:p><w:pPr><w:spacing w:before="60" w:after="0"/><w:ind w:left="720"/></w:pPr>' +
            '<w:r><w:rPr><w:b/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">↳ ' +
            xmlEscape(rp.author + (rp.when ? ', ' + rp.when : '')) + ': </w:t></w:r></w:p>';
          body += docxLineBreakParagraph(rp.body || '(empty)', 720, '');
        });
      });
    }

    return packDocx(body, links, media);
  }

  /* Everything below the body: page setup, theme, styles, footer,
     relationships and the zip itself — identical for any .docx this file
     produces, so the narration export builds its own body and hands it to
     the same packer rather than growing a second copy of the boilerplate. */

  /* A minimal but schema-complete DrawingML theme — the "document theme
     font" Word actually reads styles.xml's asciiTheme/hAnsiTheme references
     against. Calibri/Calibri Light are Word's own long-standing defaults, so
     every Windows and Mac install already has them; only the color scheme
     is Splitpage's own. fmtScheme's four lists are fixed-size in the OOXML
     schema (3 entries each) but nothing here ever draws a themed shape, so
     each entry is the simplest legal one rather than a copy of Word's own
     gradients. */
  var THEME_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Splitpage">' +
    '<a:themeElements>' +
    '<a:clrScheme name="Splitpage">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="3B3527"/></a:dk2>' +
    '<a:lt2><a:srgbClr val="F4F1EA"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="8A6D3B"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="6E7B6B"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="C9A15A"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="1155CC"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="7A4FA0"/></a:folHlink>' +
    '</a:clrScheme>' +
    '<a:fontScheme name="Splitpage">' +
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
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

  /* Page numbers in the footer (Done bullet): a standard PAGE field, plus
     the title so a printed or scattered page still says what it's from. A
     hairline top border stands in for the rule a running footer usually
     sits under. */
  function footerXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="D9D5CC"/></w:pBdr>' +
      '<w:tabs><w:tab w:val="right" w:pos="10080"/></w:tabs>' +
      '<w:rPr><w:sz w:val="16"/><w:color w:val="7A7364"/></w:rPr></w:pPr>' +
      '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A7364"/></w:rPr>' +
      '<w:t xml:space="preserve">' + xmlEscape(state.title || "Untitled Script") + '</w:t></w:r>' +
      '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A7364"/></w:rPr><w:tab/></w:r>' +
      '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A7364"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A7364"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
      '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A7364"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A7364"/></w:rPr><w:t>1</w:t></w:r>' +
      '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="7A7364"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p></w:ftr>';
  }

  /* Named paragraph, character and table styles — a document theme font
     (via the theme part above), a table style carrying the header shading
     and row banding, and colors that come from the theme's own scheme
     rather than hard-coded hex wherever a style needs one. */
  var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults>' +
    '<w:rPrDefault><w:rPr>' +
    '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:cstheme="minorHAnsi"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="2B2B22"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>' +
      '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="8" w:color="D9D5CC"/></w:pBdr>' +
      '<w:spacing w:after="240"/></w:pPr>' +
      '<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:cstheme="majorHAnsi"/>' +
      '<w:b/><w:color w:val="2B2B22"/><w:sz w:val="40"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>' +
      '<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="120"/></w:pPr>' +
      '<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:cstheme="majorHAnsi"/>' +
      '<w:b/><w:caps/><w:color w:val="8A6D3B"/><w:sz w:val="26"/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="SplitpageTable"><w:name w:val="Splitpage Table"/>' +
      '<w:basedOn w:val="TableNormal"/>' +
      '<w:tblPr>' +
      '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (side) {
        return '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="D9D5CC"/>';
      }).join("") +
      '</w:tblBorders>' +
      '<w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/>' +
      '<w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>' +
      '</w:tblPr>' +
      '<w:tblStylePr w:type="firstRow">' +
      '<w:rPr><w:b/><w:caps/><w:color w:val="3B3527"/></w:rPr>' +
      '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="EDE9DF"/></w:tcPr>' +
      '</w:tblStylePr>' +
      '<w:tblStylePr w:type="band1Horz">' +
      '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F7F5EF"/></w:tcPr>' +
      '</w:tblStylePr>' +
      '</w:style>' +
    '</w:styles>';

  function packDocx(body, links, media) {
    body += '<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter1"/>' +
      '<w:pgSz w:w="12240" w:h="15840"/>' +
      '<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:footer="720"/></w:sectPr>';

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
      '<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
      '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>';
    links.forEach(function (href, idx) {
      relsXml += '<Relationship Id="rIdL' + (idx + 1) + '"' +
        ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"' +
        ' Target="' + xmlEscape(href) + '" TargetMode="External"/>';
    });
    media.forEach(function (_, idx) {
      relsXml += '<Relationship Id="rIdM' + (idx + 1) + '"' +
        ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"' +
        ' Target="media/image' + (idx + 1) + '.jpeg"/>';
    });
    relsXml += '</Relationships>';

    var entries = [
      { name: "[Content_Types].xml", data: strBytes(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
        '</Types>') },
      { name: "_rels/.rels", data: strBytes(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>') },
      { name: "word/document.xml", data: strBytes(documentXml) },
      { name: "word/styles.xml", data: strBytes(STYLES_XML) },
      { name: "word/theme/theme1.xml", data: strBytes(THEME_XML) },
      { name: "word/footer1.xml", data: strBytes(footerXml()) },
      { name: "word/_rels/document.xml.rels", data: strBytes(relsXml) }
    ];
    media.forEach(function (bytes, idx) {
      entries.push({ name: "word/media/image" + (idx + 1) + ".jpeg", data: bytes });
    });

    return zipWrite(entries);
  }

  /* ================= the narration on its own =================

     The audio column lifted back out as an ordinary document: one paragraph
     per scene, blank line between — which is exactly the shape "Paste a
     script…" reads back in its paragraph mode, so a narration exported here
     and re-imported reproduces the same rows it came from.

     The visual column, the breakdown and the comments are all deliberately
     missing. This is the file you hand to a voice artist, or carry into
     Word to keep writing, not another copy of the whole script — every
     other export already is that. */

  function narrationRows() {
    return state.rows.filter(function (row) { return htmlToPlainText(row.audioText); });
  }

  function buildNarrationText() {
    var out = [state.title || "Untitled Script", ""];
    narrationRows().forEach(function (row) {
      /* A blank line is the separator between scenes in this format, so one
         *inside* a scene would split it in two on the way back in — the
         round trip this format exists for, quietly broken by a scene whose
         narration happened to contain two line breaks in a row. Runs of
         blank lines collapse to a single break; the scene stays one scene. */
      out.push(htmlToPlainText(row.audioText).replace(/\n[ \t]*(\n[ \t]*)+/g, "\n"));
      out.push("");
    });
    return out.join("\n");
  }

  function buildNarrationDocx() {
    var links = [];
    var rels = { addLink: function (href) { links.push(href); return "rIdL" + links.length; } };

    var body = '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>' +
      '<w:r><w:t xml:space="preserve">' + xmlEscape(state.title || "Untitled Script") + '</w:t></w:r></w:p>';

    narrationRows().forEach(function (row) {
      /* docxRunsXml() opens its own <w:p>, so paragraph properties have to
         be spliced in after it rather than passed down — 1.5 line spacing
         and a gap between paragraphs, because the point of this file is
         that somebody can read it aloud off a page. */
      body += docxRunsXml(row.audioText, rels).replace("<w:p>",
        '<w:p><w:pPr><w:spacing w:after="200" w:line="360" w:lineRule="auto"/></w:pPr>');
    });

    return packDocx(body, links, []);
  }

  /* ================= .docx reading ================= */

  var W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  var R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  var A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

  function directChildren(el, localName) {
    return Array.prototype.filter.call(el.childNodes, function (n) {
      return n.nodeType === 1 && n.localName === localName;
    });
  }

  /* Word writes <w:b w:val="0"/> to switch a style's bold OFF — treating the
     element's mere presence as "on" makes every such run bold. */
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

  function docxParaToHtml(pEl, linkMap) {
    var html = "";
    function runToHtml(rEl, href) {
      var props = rEl.getElementsByTagNameNS(W_NS, "rPr")[0];
      var b = false, i = false, u = false, s = false, mark = false;
      if (props) {
        b = docxFlag(props, "b");
        i = docxFlag(props, "i");
        u = docxFlag(props, "u");
        s = docxFlag(props, "strike");
        mark = docxFlag(props, "highlight");
      }
      var piece = "";
      Array.prototype.forEach.call(rEl.childNodes, function (child) {
        if (child.nodeType !== 1) return;
        var ln = child.localName;
        if (ln === "t") piece += escapeHtml(child.textContent || "");
        else if (ln === "br" || ln === "cr") piece += "<br>";
        else if (ln === "tab") piece += " ";
      });
      if (!piece) return "";
      if (mark) piece = "<mark>" + piece + "</mark>";
      if (s) piece = "<s>" + piece + "</s>";
      if (u && !href) piece = "<u>" + piece + "</u>";
      if (i) piece = "<em>" + piece + "</em>";
      if (b) piece = "<strong>" + piece + "</strong>";
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

  /* ---- reading a Word document ----

     Real scripts are not one uniform shape: a document typically mixes prose
     (narration and stage directions) with one or more two-column tables, in a
     meaningful order. So walk the body in document order and convert BOTH,
     rather than taking the tables and throwing the prose away. */

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

  /* true when every run carrying text is bold — the usual convention for a
     stage direction sitting among plain narration */
  function isAllBoldPara(pEl) {
    var runs = pEl.getElementsByTagNameNS(W_NS, "r");
    var sawText = false;
    for (var i = 0; i < runs.length; i++) {
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

  function firstEmbedId(el) {
    var blip = el.getElementsByTagNameNS(A_NS, "blip")[0];
    return blip ? blip.getAttributeNS(R_NS, "embed") : null;
  }

  var VISUAL_HEAD = /^(video|visual|picture|image|shot|shots|action|camera|b-?roll|screen|graphics?)\b/;
  var AUDIO_HEAD = /^(audio|voice|vo|narration|narrator|dialogue|dialog|script|line|lines|copy|speech)\b/;

  /* buildDocx()'s own "Production breakdown" table, verbatim — none of its
     header words match VISUAL_HEAD/AUDIO_HEAD, so without this check
     mapTableColumns() fell into its no-header fallback and grabbed the
     first two columns ("Category"/"Item") as if they were Visual/Audio,
     turning every breakdown row (and the header row itself) into a
     fabricated scene on reimport. */
  var BREAKDOWN_HEADER = ["category", "item", "status", "assigned to", "mentions", "scenes", "notes"];
  function isBreakdownHeader(head) {
    if (head.length !== BREAKDOWN_HEADER.length) return false;
    for (var i = 0; i < BREAKDOWN_HEADER.length; i++) {
      if (head[i] !== BREAKDOWN_HEADER[i]) return false;
    }
    return true;
  }

  /* Work out which columns hold the visual and the audio. Tables in the wild
     have an extra scene-number column, and put the columns in either order. */
  function mapTableColumns(rowsText) {
    var head = (rowsText[0] || []).map(function (t) { return t.toLowerCase().trim(); });
    if (isBreakdownHeader(head)) return null;
    var vi = head.findIndex(function (t) { return VISUAL_HEAD.test(t); });
    var ai = head.findIndex(function (t) { return AUDIO_HEAD.test(t); });
    if (vi !== -1 && ai !== -1 && vi !== ai) return { vi: vi, ai: ai, skipHeader: true };

    /* no usable header — ignore columns that are empty throughout (index
       columns), then take the first two that carry content, left to right */
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

  async function docxToRows(file) {
    var zip = await zipRead(await file.arrayBuffer());
    var docBytes = await zip.get("word/document.xml");
    if (!docBytes) throw new Error("no-document-xml");
    var xml = new DOMParser().parseFromString(new TextDecoder().decode(docBytes), "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("bad-xml");

    /* hyperlink and image targets live in the rels part */
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

    /* Only read bold as "this is a direction" when the document uses it that
       way — sparingly, among plain paragraphs. In an all-bold document it
       means nothing. */
    var loose = blocks.filter(function (n) { return n.localName === "p" && !isHeadingPara(n); });
    var withText = loose.filter(function (n) { return htmlToPlainText(docxParaToHtml(n, linkMap)); });
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
        visualImage: null,
        audioText: fields.audioText || "",
        _pendingImage: fields._pendingImage || null
      };
    }

    blocks.forEach(function (node, blockIdx) {
      if (node.localName === "tbl") {
        flush();
        var trs = directChildren(node, "tr");
        var cellHtml = [], cellEls = [];
        for (var t = 0; t < trs.length; t++) {
          var tcs = directChildren(trs[t], "tc");
          cellEls.push(tcs);
          cellHtml.push(tcs.map(function (tc) {
            var parts = [];
            directChildren(tc, "p").forEach(function (pEl) {
              var h = docxParaToHtml(pEl, linkMap);
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
          /* a picture can sit in either cell — take whichever has one */
          var embed = null;
          for (var c = 0; c < cellEls[i].length && !embed; c++) embed = firstEmbedId(cellEls[i][c]);
          if (!htmlToPlainText(v) && !htmlToPlainText(a) && !embed) continue;
          rows.push(newRow({
            visualText: v, audioText: a,
            _pendingImage: embed && imageMap[embed] ? imageMap[embed] : null
          }));
        }
        return;
      }

      /* paragraph */
      var html = docxParaToHtml(node, linkMap);
      var plain = htmlToPlainText(html);
      var embedId = firstEmbedId(node);
      var target = embedId && imageMap[embedId] ? imageMap[embedId] : null;
      if (!plain && !target) return;

      if (isHeadingPara(node)) {
        /* a heading at the very top, before anything else has been kept, is
           the document's title; otherwise headings are section markers
           worth keeping as their own row. This used to also require there
           be no MORE than one heading anywhere in the whole document — but
           buildDocx() always adds a second Heading1 ("Comments" /
           "Production breakdown") once there's a saved comment or tracked
           item, which defeated that count on every one of its own exports:
           the title paragraph became a bogus row, and the whole appended
           section got walked as narration. Position (nothing kept yet) is
           the actual invariant the comment above describes — count of
           headings elsewhere in the document has nothing to do with it. */
        if (title === null && !rows.length && !pending) { title = plain; return; }
        flush();
        rows.push(newRow({ visualText: "<strong>" + html + "</strong>" }));
        return;
      }

      if (target) {
        /* an image paragraph is a visual: attach it to the row being built */
        if (pending && !pending.visualImage && !pending._pendingImage) {
          pending._pendingImage = target;
          if (plain) pending.visualText = pending.visualText ? pending.visualText + "<br>" + html : html;
        } else {
          flush();
          pending = newRow({ visualText: plain ? html : "", _pendingImage: target });
        }
        return;
      }

      /* a paragraph wrapped entirely in brackets is a direction by convention */
      var bracketed = /^\s*[\[(].*[\])]\s*$/.test(plain) && plain.length < 200;
      if ((boldMeansVisual && isAllBoldPara(node)) || bracketed) {
        flush();
        pending = newRow({ visualText: html });
        return;
      }

      /* narration: fill the direction we are holding, or stand on its own */
      if (pending && !pending.audioText) {
        pending.audioText = html;
        flush();
      } else {
        flush();
        rows.push(newRow({ audioText: html }));
      }
    });
    flush();

    /* pull each referenced picture out of the package and inline it */
    for (var ri = 0; ri < rows.length; ri++) {
      var pendingTarget = rows[ri]._pendingImage;
      delete rows[ri]._pendingImage;
      if (!pendingTarget) continue;
      try {
        var path = pendingTarget.indexOf("/") === 0 ? pendingTarget.slice(1) : "word/" + pendingTarget;
        var imgBytes = await zip.get(path);
        if (imgBytes) {
          var raw = bytesToDataUrl(imgBytes, mimeForPath(path));
          /* the exporters embed JPEG only (DCTDecode / image/jpeg part) */
          rows[ri].visualImage = await toJpegDataUrl(raw);
        }
      } catch (e) { /* unreadable picture — keep the row, drop the image */ }
    }

    return { title: title, rows: rows, looseText: "" };
  }

  /* re-encode any image to JPEG so every downstream writer can rely on it */
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
    var ext = (/\.([a-z0-9]+)$/i.exec(path) || [, ""])[1].toLowerCase();
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
