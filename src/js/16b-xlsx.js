import { S } from "./_state.js";
import { breakdownTable } from "./08-production-panels.js";
import { brollTable } from "./08d-broll-panel.js";
import { strBytes, tagPrintColor, xmlEscape, zipWrite } from "./14-export.js";
import { PRINT_COLORS, STATUS_PRINT, TAG_STATUS_PRINT } from "./14b-export-kit.js";
import { scriptTable } from "./16-csv.js";

/* ================= Excel workbooks (.xlsx) =================

   Adam, 2026-09-28: a spreadsheet export "that comes out cleanly with
   enough space for notes stuff" — which a .csv cannot do, being values
   and commas with nowhere to keep a column's width. The same tables the
   .csv files are written from (scriptTable, 16-csv.js; breakdownTable,
   08-production-panels.js; brollTable, 08d-broll-panel.js), so the two
   never disagree, written as SpreadsheetML:

   - every column its own width, the long ones (Visual, Audio, Notes)
     wide, and every cell wrapped and top-aligned, so a scene's words
     read in full;
   - the heading row bold on a grey band, frozen, with a filter on it,
     and repeated on every printed page; the Visual and Audio headings in
     the app's column colours;
   - statuses and categories in the colours the PDF and Word exports
     print them in (PRINT_COLORS, STATUS_PRINT, TAG_STATUS_PRINT,
     TAG_PRINT_COLORS — the light palette whatever the app's theme);
   - a blank, ruled Notes column on the script sheet to write in, and
     room in the breakdown's and the shot list's own notes;
   - landscape pages, fitted to the width, "Page N of M" at the foot.

   The script's workbook is a sheet per part — Script, then Comments,
   Breakdown and B-roll when there are any — where the .csv strings the
   comments under the scenes. Strings go in the shared-string table (every
   reader takes it); a count ("Mentions") is a number. Nothing in it is
   stamped finer than the day, so two exports are the same bytes (suite
   98), as the Word export's are. Zipped by zipWrite (14-export.js), store
   only, which Excel, Numbers, Sheets and LibreOffice all open. */

var NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
var NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
var MAX_CELL = 32767;   /* the most characters a cell holds */

function pad2(n) { return (n < 10 ? "0" : "") + n; }

/* Column n (0-based) as letters: 0 A, 25 Z, 26 AA. */
export function colName(n) {
  var s = "";
  n += 1;
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ---- styles ----

   A small registry: each distinct look ({bold, italic, color, fill, wrap,
   align, border}) becomes one cellXfs entry, its font, fill and border
   shared with any other look that has the same. Index 0 is the plain
   default every workbook must start with. */
function styleSheet() {
  var fonts = ['<font><sz val="11"/><color rgb="FF' + PRINT_COLORS.text + '"/><name val="Calibri"/><family val="2"/></font>'];
  var fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  var borders = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  var xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  var seen = { "": 0 };
  function indexOf(list, xml) {
    var i = list.indexOf(xml);
    if (i === -1) { list.push(xml); i = list.length - 1; }
    return i;
  }
  function side(tag, color) {
    return color ? "<" + tag + ' style="thin"><color rgb="FF' + color + '"/></' + tag + ">" : "<" + tag + "/>";
  }
  return {
    /* the cellXfs index for look `o` */
    id: function (o) {
      o = o || {};
      var key = JSON.stringify([o.bold, o.italic, o.color, o.fill, o.wrap, o.align, o.valign, o.border]);
      if (key in seen) return seen[key];
      var font = indexOf(fonts, '<font>' + (o.bold ? "<b/>" : "") + (o.italic ? "<i/>" : "") + '<sz val="11"/>' +
        '<color rgb="FF' + (o.color || PRINT_COLORS.text) + '"/><name val="Calibri"/><family val="2"/></font>');
      var fill = o.fill
        ? indexOf(fills, '<fill><patternFill patternType="solid"><fgColor rgb="FF' + o.fill + '"/><bgColor indexed="64"/></patternFill></fill>')
        : 0;
      /* "rule": a hairline under a row; "head": a stronger one under the
         heading; "total": a strong one over the totals */
      var b = o.border === "head" ? "<border><left/><right/><top/>" + side("bottom", PRINT_COLORS.borderStrong) + "<diagonal/></border>"
        : o.border === "total" ? "<border><left/><right/>" + side("top", PRINT_COLORS.borderStrong) + "<bottom/><diagonal/></border>"
        : o.border === "rule" ? "<border><left/><right/><top/>" + side("bottom", PRINT_COLORS.border) + "<diagonal/></border>"
        : borders[0];
      var border = indexOf(borders, b);
      xfs.push('<xf numFmtId="0" fontId="' + font + '" fillId="' + fill + '" borderId="' + border + '" xfId="0"' +
        ' applyFont="1"' + (fill ? ' applyFill="1"' : "") + (border ? ' applyBorder="1"' : "") + ' applyAlignment="1">' +
        '<alignment vertical="' + (o.valign || "top") + '"' + (o.align ? ' horizontal="' + o.align + '"' : "") +
        (o.wrap ? ' wrapText="1"' : "") + "/></xf>");
      seen[key] = xfs.length - 1;
      return seen[key];
    },
    xml: function () {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="' + NS + '">' +
        '<fonts count="' + fonts.length + '">' + fonts.join("") + "</fonts>" +
        '<fills count="' + fills.length + '">' + fills.join("") + "</fills>" +
        '<borders count="' + borders.length + '">' + borders.join("") + "</borders>" +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="' + xfs.length + '">' + xfs.join("") + "</cellXfs>" +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>";
    }
  };
}

/* ---- shared strings ---- */
function stringTable() {
  var list = [], at = Object.create(null), count = 0;
  return {
    id: function (s) {
      count++;
      if (!(s in at)) { at[s] = list.length; list.push(s); }
      return at[s];
    },
    xml: function () {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="' + NS + '" count="' + count + '" uniqueCount="' + list.length + '">' +
        list.map(function (s) {
          /* leading or trailing space, or a line break, is kept only when said so */
          var keep = /^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : "";
          return "<si><t" + keep + ">" + xmlEscape(s) + "</t></si>";
        }).join("") + "</sst>";
    }
  };
}

/* A cell's text: one line ending per break, no carriage returns, at most
   what a cell holds. */
function cellText(v) {
  var s = String(v == null ? "" : v).replace(/\r\n?/g, "\n");
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL - 1) + "…" : s;
}

/* ---- a sheet ----

   `sheet`: {name, cols: [widths in characters], head: [cells], headStyles
   (optional, per column), rows: [{cells, styles: [xf per column], total}]}.
   A cell is a string or a number; "" is written as an empty cell that
   still carries its style, so the Notes column is ruled all the way down. */
function sheetXml(sheet, index, strings) {
  var ncol = sheet.cols.length;
  var last = colName(ncol - 1);
  var nrows = sheet.rows.length + 1;
  var out = [];
  var row = function (r, cells, xfs) {
    var cs = cells.map(function (v, c) {
      var ref = colName(c) + r;
      var s = xfs[c] ? ' s="' + xfs[c] + '"' : "";
      if (typeof v === "number" && isFinite(v)) return '<c r="' + ref + '"' + s + "><v>" + v + "</v></c>";
      var text = cellText(v);
      if (text === "") return '<c r="' + ref + '"' + s + "/>";
      return '<c r="' + ref + '"' + s + ' t="s"><v>' + strings.id(text) + "</v></c>";
    });
    return '<row r="' + r + '">' + cs.join("") + "</row>";
  };
  out.push(row(1, sheet.head, sheet.headStyles));
  sheet.rows.forEach(function (r, i) { out.push(row(i + 2, r.cells, r.styles)); });
  var filterTo = sheet.filterRows ? sheet.filterRows + 1 : nrows;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="' + NS + '" xmlns:r="' + NS_R + '">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    '<dimension ref="A1:' + last + nrows + '"/>' +
    '<sheetViews><sheetView workbookViewId="0"' + (index === 0 ? ' tabSelected="1"' : "") + ">" +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    "<cols>" + sheet.cols.map(function (w, c) {
      return '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + w + '" customWidth="1"/>';
    }).join("") + "</cols>" +
    "<sheetData>" + out.join("") + "</sheetData>" +
    '<autoFilter ref="A1:' + last + filterTo + '"/>' +
    '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>' +
    '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    "<headerFooter><oddFooter>" + xmlEscape("&L&A&RPage &P of &N") + "</oddFooter></headerFooter>" +
    "</worksheet>";
}

/* A sheet's name in a formula: always quoted, a quote doubled. */
function sheetRef(name) { return "'" + name.replace(/'/g, "''") + "'"; }

/* The package around the sheets: the workbook naming them (with each
   one's filter range and printed heading row), the styles, the strings
   and the document's properties. */
export function buildWorkbook(sheets, title, styles) {
  var strings = stringTable();
  var parts = sheets.map(function (sh, i) { return sheetXml(sh, i, strings); });
  var names = [];
  sheets.forEach(function (sh, i) {
    var last = colName(sh.cols.length - 1);
    var to = (sh.filterRows || sh.rows.length) + 1;
    names.push('<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">' +
      xmlEscape(sheetRef(sh.name) + "!$A$1:$" + last + "$" + to) + "</definedName>");
    names.push('<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">' +
      xmlEscape(sheetRef(sh.name) + "!$1:$1") + "</definedName>");
  });
  var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="' + NS + '" xmlns:r="' + NS_R + '">' +
    '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
    sheets.map(function (sh, i) {
      return '<sheet name="' + xmlEscape(sh.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    }).join("") + "</sheets><definedNames>" + names.join("") + "</definedNames></workbook>";
  var n = sheets.length;
  var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map(function (sh, i) {
      return '<Relationship Id="rId' + (i + 1) + '" Type="' + NS_R + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
    }).join("") +
    '<Relationship Id="rId' + (n + 1) + '" Type="' + NS_R + '/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId' + (n + 2) + '" Type="' + NS_R + '/sharedStrings" Target="sharedStrings.xml"/>' +
    "</Relationships>";
  var types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map(function (sh, i) {
      return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }).join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>";
  var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + NS_R + '/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="' + NS_R + '/extended-properties" Target="docProps/app.xml"/>' +
    "</Relationships>";
  /* the day, not the second: two exports of one script are one file */
  var d = new Date();
  var day = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T00:00:00Z";
  var core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + xmlEscape(title) + "</dc:title><dc:creator>Splitpage</dc:creator>" +
    "<cp:lastModifiedBy>Splitpage</cp:lastModifiedBy>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + day + "</dcterms:created>" +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + day + "</dcterms:modified>" +
    "</cp:coreProperties>";
  var app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    "<Application>Splitpage</Application></Properties>";
  var entries = [
    { name: "[Content_Types].xml", data: strBytes(types) },
    { name: "_rels/.rels", data: strBytes(rootRels) },
    { name: "docProps/core.xml", data: strBytes(core) },
    { name: "docProps/app.xml", data: strBytes(app) },
    { name: "xl/workbook.xml", data: strBytes(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: strBytes(wbRels) }
  ];
  parts.forEach(function (xml, i) { entries.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: strBytes(xml) }); });
  /* the strings last: every sheet above has put its own in */
  entries.push({ name: "xl/styles.xml", data: strBytes(styles.xml()) });
  entries.push({ name: "xl/sharedStrings.xml", data: strBytes(strings.xml()) });
  return zipWrite(entries);
}

/* ---- the sheets ---- */

function looks(styles) {
  var body = { wrap: true, border: "rule" };
  var o = function (extra) { return styles.id(Object.assign({}, body, extra)); };
  return {
    head: styles.id({ bold: true, fill: PRINT_COLORS.surface2, border: "head", wrap: true, valign: "center" }),
    headVisual: styles.id({ bold: true, color: PRINT_COLORS.visual, fill: PRINT_COLORS.surface2, border: "head", wrap: true, valign: "center" }),
    headAudio: styles.id({ bold: true, color: PRINT_COLORS.audio, fill: PRINT_COLORS.surface2, border: "head", wrap: true, valign: "center" }),
    body: o({}),
    center: o({ align: "center" }),
    bold: o({ bold: true }),
    dim: o({ color: PRINT_COLORS.faint }),
    reply: o({ italic: true, color: PRINT_COLORS.dim }),
    total: styles.id({ bold: true, border: "total" }),
    with: o
  };
}

function fill(n, v) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }

/* Script: the scenes, then Total (and Target), then a blank ruled Notes
   column to write in. */
function scriptSheet(L, t) {
  var head = t.head.concat(["Notes"]);
  var headStyles = head.map(function (h) { return h === "Visual" ? L.headVisual : h === "Audio" ? L.headAudio : L.head; });
  var rows = t.scenes.map(function (s) {
    var st = STATUS_PRINT[s.status] || STATUS_PRINT.todo;
    var styles = fill(head.length, L.body);
    styles[0] = L.with({ bold: true, align: "center" });
    styles[1] = L.center;
    styles[2] = L.with({ color: st.color, bold: s.status === "shot", fill: s.status === "ready" ? PRINT_COLORS.audioSoft : null });
    styles[3] = L.center;
    styles[4] = L.center;
    styles[9] = L.center;
    return { cells: s.cells.concat([""]), styles: styles };
  });
  t.summary.forEach(function (cells) {
    rows.push({ cells: cells.concat([""]), styles: fill(head.length, L.total), total: true });
  });
  return {
    name: "Script",
    head: head,
    headStyles: headStyles,
    /*      Scene Start Status Read Set Visual Audio Tags B-roll Open Notes */
    cols: [7, 9, 10, 8, 9, 46, 60, 32, 30, 11, 40],
    rows: rows,
    /* the filter covers the scenes, not the totals under them */
    filterRows: t.scenes.length
  };
}

function commentsSheet(L, t) {
  if (!t.comments.length) return null;
  return {
    name: "Comments",
    head: t.commentHead,
    headStyles: fill(t.commentHead.length, L.head),
    /*      No. Location Status Assigned Author Date Quoted Comment */
    cols: [6, 20, 18, 16, 18, 20, 36, 60],
    rows: t.comments.map(function (c) {
      var base = c.reply ? L.reply : c.resolved ? L.dim : L.body;
      var styles = fill(t.commentHead.length, base);
      if (!c.reply) styles[0] = L.with({ bold: true, align: "center", color: c.resolved ? PRINT_COLORS.faint : null });
      return { cells: c.cells, styles: styles };
    })
  };
}

function breakdownSheet(L, standalone) {
  var t = breakdownTable();
  if (!t.rows.length && !standalone) return null;
  var rows = t.rows.map(function (r) {
    var st = TAG_STATUS_PRINT[r.status] || TAG_STATUS_PRINT.needed;
    var styles = fill(t.head.length, L.body);
    styles[0] = L.with({ bold: true, color: tagPrintColor(r.catId) });
    styles[1] = L.bold;
    styles[2] = L.with({ color: st.color, bold: r.status === "have", fill: r.status === "sourcing" ? PRINT_COLORS.audioSoft : null });
    styles[4] = L.center;
    styles[6] = L.center;
    styles[9] = L.center;
    return { cells: r.cells, styles: styles };
  });
  if (!rows.length) rows.push({ cells: ["(nothing labelled yet)"].concat(fill(t.head.length - 1, "")), styles: fill(t.head.length, L.dim) });
  return {
    name: "Breakdown",
    head: t.head,
    headStyles: fill(t.head.length, L.head),
    /*      Category Item Status Assigned Mentions Scenes In Notes B-roll First Group */
    cols: [13, 28, 11, 16, 10, 16, 9, 44, 30, 12, 22],
    rows: rows
  };
}

/* "Cuts against" is the whole narration a shot plays under — a paragraph,
   which wrapped in its column made one shot a page tall (Excel sizes a row
   to its tallest cell). The sheet shows its opening words, enough to find
   the place; the .csv keeps all of it. */
var CUTS_CHARS = 90;

function opening(s) {
  s = String(s || "");
  if (s.length <= CUTS_CHARS) return s;
  var cut = s.slice(0, CUTS_CHARS);
  var sp = cut.lastIndexOf(" ");
  return (sp > CUTS_CHARS / 2 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?—–-]+$/, "") + "…";
}

function brollSheet(L, standalone) {
  var t = brollTable();
  if (!t.rows.length && !standalone) return null;
  var rows = t.rows.map(function (r) {
    r = { shot: r.shot, flagged: r.flagged, cells: r.cells.slice() };
    r.cells[6] = opening(r.cells[6]);
    var styles = fill(t.head.length, L.body);
    styles[0] = L.with({ bold: true, align: "center" });
    styles[1] = L.bold;
    styles[2] = r.shot ? L.with({ bold: true }) : L.dim;
    styles[3] = r.flagged ? L.with({ bold: true, color: PRINT_COLORS.audio, align: "center" }) : L.center;
    styles[10] = L.center;
    return { cells: r.cells, styles: styles };
  });
  if (!rows.length) rows.push({ cells: ["(no b-roll yet)"].concat(fill(t.head.length - 1, "")), styles: fill(t.head.length, L.dim) });
  return {
    name: "B-roll",
    head: t.head,
    headStyles: fill(t.head.length, L.head),
    /*      Scene Shot Status Flagged Location Props Cuts Assigned Note Description Start */
    cols: [7, 32, 10, 9, 18, 26, 30, 16, 40, 40, 11],
    rows: rows
  };
}

function titleOf() { return (S.state && S.state.title) || "Untitled Script"; }

/* File ▸ Export ▸ Spreadsheet ▸ Excel: the whole script, a sheet per part. */
export function buildScriptXlsx() {
  var styles = styleSheet();
  var L = looks(styles);
  var t = scriptTable();
  var sheets = [scriptSheet(L, t), commentsSheet(L, t), breakdownSheet(L, false), brollSheet(L, false)].filter(Boolean);
  return buildWorkbook(sheets, titleOf(), styles);
}

/* … ▸ Breakdown ▸ Excel: every tagged item. */
export function buildBreakdownXlsx() {
  var styles = styleSheet();
  return buildWorkbook([breakdownSheet(looks(styles), true)], titleOf() + " - breakdown", styles);
}

/* … ▸ B-roll shot list ▸ Excel: every shot, in script order. */
export function buildBrollXlsx() {
  var styles = styleSheet();
  return buildWorkbook([brollSheet(looks(styles), true)], titleOf() + " - b-roll shot list", styles);
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
