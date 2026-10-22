import type { ExportServices } from "../../application/export/services.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import { exportServices } from "../../application/export/services.ts";
import type { ScriptTable } from "./csv.ts";
import type { TableCell } from "./export-projections.ts";
import { PRINT_COLORS, STATUS_PRINT, TAG_STATUS_PRINT, exportDay } from "./export-kit.ts";
import { breakdownTable, brollTable } from "./export-projections.ts";
import { scriptTable } from "./csv.ts";
import { strBytes } from "./bytes.ts";
import { tagPrintColor } from "./print-colors.ts";
import { xmlEscape } from "./xml.ts";
import { zipWrite } from "./zip.ts";
import { unitSafePrefix } from "../../core/document/text-policy.ts";

interface StyleOptions {
  bold?: boolean;
  italic?: boolean;
  color?: string | null;
  fill?: string | null;
  wrap?: boolean;
  align?: string;
  valign?: string;
  border?: string;
}
interface Styles {
  id: (options?: StyleOptions | null) => number;
  xml: () => string;
}
interface Strings {
  id: (text: string) => number;
  xml: () => string;
}
export interface WorkbookSheet {
  name: string;
  head: TableCell[];
  headStyles: number[];
  cols: number[];
  rows: { cells: TableCell[]; styles: number[]; total?: boolean }[];
  filterRows?: number;
}
type Looks = ReturnType<typeof looks>;
function requiredSheet(sheet: WorkbookSheet | null): WorkbookSheet {
  if (!sheet) throw new Error("Missing standalone workbook sheet");
  return sheet;
}


const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAX_CELL = 32767;

function pad2(n: number): string { return (n < 10 ? "0" : "") + n; }

export function colName(n: number): string {
  let s = "";
  n += 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function styleSheet(): Styles {
  const fonts = ['<font><sz val="11"/><color rgb="FF' + PRINT_COLORS.text + '"/><name val="Calibri"/><family val="2"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const seen: Record<string, number> = { "": 0 };
  function indexOf(list: string[], xml: string): number {
    let i = list.indexOf(xml);
    if (i === -1) { list.push(xml); i = list.length - 1; }
    return i;
  }
  function side(tag: string, color: string): string {
    return color ? "<" + tag + ' style="thin"><color rgb="FF' + color + '"/></' + tag + ">" : "<" + tag + "/>";
  }
  return {
    id: function (o) {
      o = o || {};
      const key = JSON.stringify([o.bold, o.italic, o.color, o.fill, o.wrap, o.align, o.valign, o.border]);
      const known = seen[key];
      if (known !== undefined) return known;
      const font = indexOf(fonts, '<font>' + (o.bold ? "<b/>" : "") + (o.italic ? "<i/>" : "") + '<sz val="11"/>' +
        '<color rgb="FF' + (o.color || PRINT_COLORS.text) + '"/><name val="Calibri"/><family val="2"/></font>');
      const fill = o.fill
        ? indexOf(fills, '<fill><patternFill patternType="solid"><fgColor rgb="FF' + o.fill + '"/><bgColor indexed="64"/></patternFill></fill>')
        : 0;
      const b = o.border === "head" ? "<border><left/><right/><top/>" + side("bottom", PRINT_COLORS.borderStrong) + "<diagonal/></border>"
        : o.border === "total" ? "<border><left/><right/>" + side("top", PRINT_COLORS.borderStrong) + "<bottom/><diagonal/></border>"
        : o.border === "rule" ? "<border><left/><right/><top/>" + side("bottom", PRINT_COLORS.border) + "<diagonal/></border>"
        : (borders[0] ?? "");
      const border = indexOf(borders, b);
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

function stringTable(): Strings {
  const list: string[] = [];
  const at = new Map<string, number>();
  let count = 0;
  return {
    id: function (s) {
      count++;
      const known = at.get(s);
      if (known !== undefined) return known;
      const id = list.length;
      at.set(s, id);
      list.push(s);
      return id;
    },
    xml: function () {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="' + NS + '" count="' + count + '" uniqueCount="' + list.length + '">' +
        list.map(function (s) {
          const keep = /^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : "";
          return "<si><t" + keep + ">" + xmlEscape(s) + "</t></si>";
        }).join("") + "</sst>";
    }
  };
}

function cellText(v: unknown): string {
  const s = String(v == null ? "" : v).replace(/\r\n?/g, "\n");
  return s.length > MAX_CELL ? unitSafePrefix(s, MAX_CELL - 1) + "…" : s;
}

function sheetXml(sheet: WorkbookSheet, index: number, strings: Strings): string {
  const ncol = sheet.cols.length;
  const last = colName(ncol - 1);
  const nrows = sheet.rows.length + 1;
  const out: string[] = [];
  const row = function (r: number, cells: readonly TableCell[], xfs: readonly number[]) {
    const cs = cells.map(function (v, c) {
      const ref = colName(c) + r;
      const s = xfs[c] ? ' s="' + xfs[c] + '"' : "";
      if (typeof v === "number" && isFinite(v)) return '<c r="' + ref + '"' + s + "><v>" + v + "</v></c>";
      const text = cellText(v);
      if (text === "") return '<c r="' + ref + '"' + s + "/>";
      return '<c r="' + ref + '"' + s + ' t="s"><v>' + strings.id(text) + "</v></c>";
    });
    return '<row r="' + r + '">' + cs.join("") + "</row>";
  };
  out.push(row(1, sheet.head, sheet.headStyles));
  sheet.rows.forEach(function (r, i) { out.push(row(i + 2, r.cells, r.styles)); });
  const filterTo = sheet.filterRows ? sheet.filterRows + 1 : nrows;
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

function sheetRef(name: string): string { return "'" + name.replace(/'/g, "''") + "'"; }

export function buildWorkbook(doc: ExportDocument, sheets: readonly WorkbookSheet[], title: string, styles: Styles): Uint8Array {
  const strings = stringTable();
  const parts = sheets.map(function (sh, i) { return sheetXml(sh, i, strings); });
  const names: string[] = [];
  sheets.forEach(function (sh, i) {
    const last = colName(sh.cols.length - 1);
    const to = (sh.filterRows || sh.rows.length) + 1;
    names.push('<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">' +
      xmlEscape(sheetRef(sh.name) + "!$A$1:$" + last + "$" + to) + "</definedName>");
    names.push('<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">' +
      xmlEscape(sheetRef(sh.name) + "!$1:$1") + "</definedName>");
  });
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="' + NS + '" xmlns:r="' + NS_R + '">' +
    '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
    sheets.map(function (sh, i) {
      return '<sheet name="' + xmlEscape(sh.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    }).join("") + "</sheets><definedNames>" + names.join("") + "</definedNames></workbook>";
  const n = sheets.length;
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map(function (sh, i) {
      return '<Relationship Id="rId' + (i + 1) + '" Type="' + NS_R + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
    }).join("") +
    '<Relationship Id="rId' + (n + 1) + '" Type="' + NS_R + '/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId' + (n + 2) + '" Type="' + NS_R + '/sharedStrings" Target="sharedStrings.xml"/>' +
    "</Relationships>";
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
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
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + NS_R + '/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="' + NS_R + '/extended-properties" Target="docProps/app.xml"/>' +
    "</Relationships>";
  const d = exportDay(doc);
  const day = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T00:00:00Z";
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + xmlEscape(title) + "</dc:title><dc:creator>Splitpage</dc:creator>" +
    "<cp:lastModifiedBy>Splitpage</cp:lastModifiedBy>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + day + "</dcterms:created>" +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + day + "</dcterms:modified>" +
    "</cp:coreProperties>";
  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    "<Application>Splitpage</Application></Properties>";
  const entries = [
    { name: "[Content_Types].xml", data: strBytes(types) },
    { name: "_rels/.rels", data: strBytes(rootRels) },
    { name: "docProps/core.xml", data: strBytes(core) },
    { name: "docProps/app.xml", data: strBytes(app) },
    { name: "xl/workbook.xml", data: strBytes(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: strBytes(wbRels) }
  ];
  parts.forEach(function (xml, i) { entries.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: strBytes(xml) }); });
  entries.push({ name: "xl/styles.xml", data: strBytes(styles.xml()) });
  entries.push({ name: "xl/sharedStrings.xml", data: strBytes(strings.xml()) });
  return zipWrite(entries, d);
}

function looks(styles: Styles) {
  const body = { wrap: true, border: "rule" };
  const o = function (extra: StyleOptions) { return styles.id(Object.assign({}, body, extra)); };
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

function fill<T>(n: number, v: T): T[] { const a: T[] = []; for (let i = 0; i < n; i++) a.push(v); return a; }

function scriptSheet(L: Looks, t: ScriptTable): WorkbookSheet {
  const head = t.head.concat(["Notes"]);
  const headStyles = head.map(function (h) { return h === "Visual" ? L.headVisual : h === "Audio" ? L.headAudio : L.head; });
  const rows: WorkbookSheet["rows"] = t.scenes.map(function (s) {
    const st = Object.entries(STATUS_PRINT).find(([id]) => id === s.status)?.[1] || STATUS_PRINT.todo;
    const styles = fill(head.length, L.body);
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
    cols: [7, 9, 10, 8, 9, 46, 60, 32, 30, 11, 40],
    rows: rows,
    filterRows: t.scenes.length
  };
}

function commentsSheet(L: Looks, t: ScriptTable): WorkbookSheet | null {
  if (!t.comments.length) return null;
  return {
    name: "Comments",
    head: t.commentHead,
    headStyles: fill(t.commentHead.length, L.head),
    cols: [6, 20, 18, 16, 18, 20, 36, 60],
    rows: t.comments.map(function (c) {
      const base = c.reply ? L.reply : c.resolved ? L.dim : L.body;
      const styles = fill(t.commentHead.length, base);
      if (!c.reply) styles[0] = L.with({ bold: true, align: "center", color: c.resolved ? PRINT_COLORS.faint : null });
      return { cells: c.cells, styles: styles };
    })
  };
}

function breakdownSheet(doc: ExportDocument, L: Looks, standalone: boolean, services: ExportServices): WorkbookSheet | null {
  const t = breakdownTable(doc, services);
  if (!t.rows.length && !standalone) return null;
  const rows: WorkbookSheet["rows"] = t.rows.map(function (r) {
    const st = Object.entries(TAG_STATUS_PRINT).find(([id]) => id === r.status)?.[1] || TAG_STATUS_PRINT.needed;
    const styles = fill(t.head.length, L.body);
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
    cols: [13, 28, 11, 16, 10, 16, 9, 44, 30, 12, 22],
    rows: rows
  };
}

const CUTS_CHARS = 90;

function opening(value: unknown): string {
  const s = String(value || "");
  if (s.length <= CUTS_CHARS) return s;
  const cut = unitSafePrefix(s, CUTS_CHARS);
  const sp = cut.lastIndexOf(" ");
  return (sp > CUTS_CHARS / 2 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?—–-]+$/, "") + "…";
}

function brollSheet(doc: ExportDocument, L: Looks, standalone: boolean, services: ExportServices): WorkbookSheet | null {
  const t = brollTable(doc, services);
  if (!t.rows.length && !standalone) return null;
  const rows = t.rows.map(function (r) {
    const cells = r.cells.slice();
    cells[6] = opening(cells[6]);
    const styles = fill(t.head.length, L.body);
    styles[0] = L.with({ bold: true, align: "center" });
    styles[1] = L.bold;
    styles[2] = r.shot ? L.with({ bold: true }) : L.dim;
    styles[3] = r.flagged ? L.with({ bold: true, color: PRINT_COLORS.audio, align: "center" }) : L.center;
    styles[10] = L.center;
    return { cells: cells, styles: styles };
  });
  if (!rows.length) rows.push({ cells: ["(no b-roll yet)"].concat(fill(t.head.length - 1, "")), styles: fill(t.head.length, L.dim) });
  return {
    name: "B-roll",
    head: t.head,
    headStyles: fill(t.head.length, L.head),
    cols: [7, 32, 10, 9, 18, 26, 30, 16, 40, 40, 11],
    rows: rows
  };
}

function titleOf(doc: ExportDocument): string { return doc.title || "Untitled Script"; }

export function buildScriptXlsx(doc: ExportDocument, services: ExportServices = exportServices()): Uint8Array {
  const styles = styleSheet();
  const L = looks(styles);
  const t = scriptTable(doc, services);
  const sheets = [scriptSheet(L, t), commentsSheet(L, t), breakdownSheet(doc, L, false, services), brollSheet(doc, L, false, services)].filter((sheet) => sheet !== null);
  return buildWorkbook(doc, sheets, titleOf(doc), styles);
}

export function buildBreakdownXlsx(doc: ExportDocument, services: ExportServices = exportServices()): Uint8Array {
  const styles = styleSheet();
  return buildWorkbook(doc, [requiredSheet(breakdownSheet(doc, looks(styles), true, services))], titleOf(doc) + " - breakdown", styles);
}

export function buildBrollXlsx(doc: ExportDocument, services: ExportServices = exportServices()): Uint8Array {
  const styles = styleSheet();
  return buildWorkbook(doc, [requiredSheet(brollSheet(doc, looks(styles), true, services))], titleOf(doc) + " - b-roll shot list", styles);
}
