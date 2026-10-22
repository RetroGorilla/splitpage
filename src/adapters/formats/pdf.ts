import type { ExportAssets, ExportPicture } from "../../application/export/assets.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import type { ExportRun } from "./export-kit.ts";
import type { BreakdownRow, CommentBody, CommentEntry, BodyPiece, SceneFacts } from "./export-projections.ts";
import { morePictureRefs, rowVideoLinks, videoLinkText } from "../storage/02d-gallery.js";
import {
  PRINT_COLORS,
  STATUS_PRINT,
  TAG_STATUS_PRINT,
  breakdownGroups,
  exportComments,
  exportDateText,
  exportDay,
  exportFacts,
  exportRuns,
  exportSummaryParts
} from "./export-kit.ts";
import { capturedPicture, capturedRowPicture } from "./export-assets.ts";
import { brollShotListForPrint, commentEntries, sceneFacts } from "./export-projections.ts";
import { jpegSize, safeAspect } from "./docx.ts";
import { concatBytes, latin1Bytes } from "./bytes.ts";
import { tagPrintColor } from "./print-colors.ts";
import { videoHostLabel } from "./video-host.ts";
import { unitSafePrefix } from "../../core/document/text-policy.ts";
import { TAG_STATUSES, tagCategory } from "../../core/production/looks.ts";

interface PdfRun {
  text: string;
  b?: boolean | undefined;
  i?: boolean | undefined;
  u?: boolean | undefined;
  s?: boolean | undefined;
  mark?: boolean | undefined;
  dir?: boolean | undefined;
  cue?: boolean | undefined;
  href?: string | null | undefined;
  tag?: ExportRun["tag"];
  cmt?: string[] | undefined;
  broll?: string | boolean | undefined;
  markers?: number[] | undefined;
  color?: string | undefined;
}
interface PdfPiece extends PdfRun { width: number; markerWidth?: number }
interface PdfLink { x: number; y: number; w: number; h: number; uri: string }
interface PdfImage { name: string; w: number; h: number; bytes: Uint8Array }
interface PdfPage { ops: string[]; images?: string[]; links?: PdfLink[]; size?: readonly [number, number]; margin?: number }
interface PdfOutline { title: string; page: number; y?: number }
interface PdfSpec {
  size: readonly [number, number];
  pages: PdfPage[];
  images?: PdfImage[];
  info?: { title?: string; date?: Date };
  outline?: PdfOutline[];
}
interface Jpeg { bytes: Uint8Array; size: { w: number; h: number } }
type RowJpegs = (Jpeg | null)[] & { more?: Jpeg[][] };
type CommentJpegs = Record<string, Jpeg | null>;
interface DrawPicture { name: string; w: number; h: number }
type CommentItem = { pic: DrawPicture; x: number; line?: never } | { line: PdfPiece[]; x: number; pic?: never };
type ThreadItem = { pic: DrawPicture; x: number; line?: never } | { line: PdfPiece[]; x: number; block: number; badge?: number; pic?: never };
interface Gutter { nw: number; stacked: boolean; drop: number; h: number }
interface ListSheet {
  pages: string[][];
  readonly ops: string[];
  y: number;
  body: boolean;
  PW: number;
  PH: number;
  M: number;
  newPage: () => void;
  text: (str: string, x: number, y: number, font: string, size: number, hex?: string | null) => void;
  push: (ops: string[]) => void;
  bare: () => string[][];
  finish: (title: string) => string[][];
}
interface PackingRow {
  name: PdfPiece[][];
  under: { line: PdfPiece[]; boldHex?: string }[];
  status: { id: string; label: string };
  owner: PdfPiece[][];
  scenes: PdfPiece[][];
  orphaned: boolean;
  height: number;
}
type ShotData = ReturnType<typeof brollShotListForPrint>;
type ShotGroup = ShotData["groups"][number];
type Shot = ShotGroup["items"][number];
interface ShotLine { line: PdfPiece[]; size: number; hex: string; boldHex: string; lead: number }
type ShotColumn = "done" | "scene" | "shot" | "location" | "props" | "owner" | "flag" | "notes";
interface ShotRow { r: Shot; cells: Partial<Record<ShotColumn, ShotLine[]>>; height: number }

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing PDF value");
  return value;
}

const HELV_W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELVB_W = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const WINANSI_MAP: Record<string, number> = { "—": 151, "–": 150, "‘": 145, "’": 146, "“": 147, "”": 148, "…": 133, "•": 149, " ": 32 };

function pdfEncodeChar(ch: string): number {
  const mapped = WINANSI_MAP[ch];
  if (mapped !== undefined) return mapped;
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 255) return code;
  return 63;
}

const HELV_HIGH: Record<number, number> = { 133: 1000, 145: 222, 146: 222, 147: 333, 148: 333, 149: 350, 150: 556, 151: 1000, 183: 278 };
const HELVB_HIGH: Record<number, number> = { 133: 1000, 145: 278, 146: 278, 147: 500, 148: 500, 149: 350, 150: 556, 151: 1000, 183: 278 };

function pdfCharWidth(ch: string, bold?: boolean): number {
  const code = pdfEncodeChar(ch);
  if (code >= 32 && code <= 126) return required((bold ? HELVB_W : HELV_W)[code - 32]);
  const high = (bold ? HELVB_HIGH : HELV_HIGH)[code];
  if (high !== undefined) return high;
  return bold ? 611 : 556;
}

export function pdfTextWidth(text: string, bold: boolean | undefined, size: number): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) w += pdfCharWidth(text.charAt(i), bold);
  return w * size / 1000;
}

export function pdfEscapeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = pdfEncodeChar(s.charAt(i));
    const ch = String.fromCharCode(code);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else out += ch;
  }
  return out;
}

export function pdfRgb(hex: string): string {
  return [0, 2, 4].map(function (i) { return (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3); }).join(" ");
}

export function pdfCirclePath(cx: number, cy: number, r: number): string {
  const k = r * 0.5523;
  function p(x: number, y: number): string { return x.toFixed(2) + " " + y.toFixed(2); }
  return p(cx + r, cy) + " m " +
    p(cx + r, cy + k) + " " + p(cx + k, cy + r) + " " + p(cx, cy + r) + " c " +
    p(cx - k, cy + r) + " " + p(cx - r, cy + k) + " " + p(cx - r, cy) + " c " +
    p(cx - r, cy - k) + " " + p(cx - k, cy - r) + " " + p(cx, cy - r) + " c " +
    p(cx + k, cy - r) + " " + p(cx + r, cy - k) + " " + p(cx + r, cy) + " c h";
}

function n2(v: number): string { return (+v).toFixed(2); }

export function pdfTextOp(str: string, x: number, y: number, font: string, size: number, hex?: string | null): string {
  const op = "BT /" + font + " " + size + " Tf 1 0 0 1 " + n2(x) + " " + n2(y) +
    " Tm (" + pdfEscapeText(str) + ") Tj ET";
  return hex ? "q " + pdfRgb(hex) + " rg " + op + " Q" : op;
}

export function pdfRoundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = r * 0.5523;
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

export function pdfRuleOp(x1: number, y: number, x2: number, hex: string, width?: number): string {
  return "q " + pdfRgb(hex) + " RG " + (width || 0.5) + " w " + n2(x1) + " " + n2(y) + " m " + n2(x2) + " " + n2(y) + " l S Q";
}

export function pdfLampOp(kind: string, cx: number, cy: number, r: number, hex: string): string {
  const c = pdfRgb(hex);
  if (kind === "fill") return "q " + c + " rg " + pdfCirclePath(cx, cy, r) + " f Q";
  if (kind === "outline") return "q " + c + " RG 0.9 w " + pdfCirclePath(cx, cy, r - 0.45) + " S Q";
  if (kind === "ring") {
    return "q " + c + " RG 0.7 w " + pdfCirclePath(cx, cy, r - 0.35) + " S " + c + " rg " +
      pdfCirclePath(cx, cy, r * 0.32) + " f Q";
  }
  if (kind === "half") {
    const k = r * 0.5523;
    return "q " + c + " RG 0.9 w " + pdfCirclePath(cx, cy, r - 0.45) + " S " + c + " rg " +
      n2(cx) + " " + n2(cy + r) + " m " +
      n2(cx - k) + " " + n2(cy + r) + " " + n2(cx - r) + " " + n2(cy + k) + " " + n2(cx - r) + " " + n2(cy) + " c " +
      n2(cx - r) + " " + n2(cy - k) + " " + n2(cx - k) + " " + n2(cy - r) + " " + n2(cx) + " " + n2(cy - r) + " c h f Q";
  }
  return "q " + c + " rg " + pdfCirclePath(cx, cy, r) + " f 1 1 1 RG " + n2(r * 0.32) + " w 1 J 1 j " +
    n2(cx - r * 0.45) + " " + n2(cy + r * 0.02) + " m " + n2(cx - r * 0.1) + " " + n2(cy - r * 0.34) + " l " +
    n2(cx + r * 0.48) + " " + n2(cy + r * 0.36) + " l S Q";
}

export function pdfCheckboxOp(x: number, y: number, size: number, ticked: boolean, boxHex?: string, tickHex?: string): string {
  let op = "q " + pdfRgb(boxHex || "64635E") + " RG 0.9 w " + pdfRoundRectPath(x, y, size, size, size * 0.18) + " S Q";
  if (ticked) {
    op += " q " + pdfRgb(tickHex || "00717F") + " RG " + n2(size * 0.16) + " w 1 J 1 j " +
      n2(x + size * 0.2) + " " + n2(y + size * 0.5) + " m " + n2(x + size * 0.43) + " " + n2(y + size * 0.24) + " l " +
      n2(x + size * 0.84) + " " + n2(y + size * 0.82) + " l S Q";
  }
  return op;
}

export function pdfFooterOps(title: string, pageNo: number, pageCount: number, PW: number, M: number, y: number, hex?: string, ruleHex?: string): string[] {
  const size = 7.5;
  const right = "Page " + pageNo + " of " + pageCount;
  const room = PW - 2 * M - pdfTextWidth(right, false, size) - 24;
  let t = String(title || "");
  if (pdfTextWidth(t, false, size) > room) {
    while (t.length > 1 && pdfTextWidth(t + "…", false, size) > room) t = unitSafePrefix(t, t.length - 1);
    t = t.replace(/\s+$/, "") + "…";
  }
  return [
    pdfRuleOp(M, y + 11, PW - M, ruleHex || "DCDAD4", 0.5),
    pdfTextOp(t, M, y, "F1", size, hex || "64635E"),
    pdfTextOp(right, PW - M - pdfTextWidth(right, false, size), y, "F1", size, hex || "64635E")
  ];
}

function pdfInfoString(s: string): string {
  s = String(s || "");
  if (/^[\x20-\x7e]*$/.test(s)) return "(" + s.replace(/([()\\])/g, "\\$1") + ")";
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += ("000" + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
  return "<" + hex + ">";
}

function pdfDate(d: Date): string {
  function p(v: number): string { return (v < 10 ? "0" : "") + v; }
  return "D:" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

export function assemblePdf(spec: PdfSpec): Uint8Array<ArrayBuffer> {
  const PW = spec.size[0], PH = spec.size[1];
  const pages = spec.pages, images = spec.images || [];
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  function put(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? latin1Bytes(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  }
  function startObj(num: number): void { offsets[num] = length; put(num + " 0 obj\n"); }

  const numPages = pages.length;
  const OBJ_CATALOG = 1, OBJ_PAGES = 2, OBJ_F1 = 3, OBJ_F2 = 4, OBJ_F3 = 5, OBJ_F4 = 6, OBJ_INFO = 7;
  const firstPageObj = 8;
  const contentObjBase = firstPageObj + numPages;
  const imageObjBase = contentObjBase + numPages;
  let next = imageObjBase + images.length;
  const annotObjs = pages.map(function (pg) {
    return (pg.links || []).map(function () { return next++; });
  });
  const outline = (spec.outline || []).filter(function (o) { return o && o.page >= 0 && o.page < numPages; });
  const outlineRoot = outline.length ? next++ : 0;
  const outlineItems = outline.map(function () { return next++; });
  const totalObjs = next - 1;

  put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  startObj(OBJ_CATALOG);
  put("<< /Type /Catalog /Pages " + OBJ_PAGES + " 0 R /ViewerPreferences << /DisplayDocTitle true >>" +
    (outlineRoot ? " /Outlines " + outlineRoot + " 0 R /PageMode /UseOutlines" : "") + " >>\nendobj\n");

  startObj(OBJ_PAGES);
  const kids: string[] = [];
  for (let i = 0; i < numPages; i++) kids.push((firstPageObj + i) + " 0 R");
  put("<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + numPages + " >>\nendobj\n");

  ([[OBJ_F1, "Helvetica"], [OBJ_F2, "Helvetica-Bold"],
   [OBJ_F3, "Helvetica-Oblique"], [OBJ_F4, "Helvetica-BoldOblique"]] as const).forEach(function (f) {
    startObj(f[0]);
    put("<< /Type /Font /Subtype /Type1 /BaseFont /" + f[1] + " /Encoding /WinAnsiEncoding >>\nendobj\n");
  });

  const info = spec.info || {};
  startObj(OBJ_INFO);
  put("<< " + (info.title ? "/Title " + pdfInfoString(info.title) + " " : "") +
    "/Creator (Splitpage) /Producer (Splitpage) /CreationDate (" + pdfDate(info.date || new Date(1980, 0, 1)) + ") >>\nendobj\n");

  pages.forEach(function (pg, idx) {
    startObj(firstPageObj + idx);
    let xobj = "";
    if (pg.images && pg.images.length) {
      xobj = " /XObject << " + pg.images.map(function (name) {
        const oi = images.findIndex(function (im) { return im.name === name; });
        return "/" + name + " " + (imageObjBase + oi) + " 0 R";
      }).join(" ") + " >>";
    }
    const annots = required(annotObjs[idx]).length ? " /Annots [" + required(annotObjs[idx]).map(function (o) { return o + " 0 R"; }).join(" ") + "]" : "";
    const box = pg.size || [PW, PH];
    put("<< /Type /Page /Parent " + OBJ_PAGES + " 0 R /MediaBox [0 0 " + box[0] + " " + box[1] + "]" +
      " /Resources << /Font << /F1 " + OBJ_F1 + " 0 R /F2 " + OBJ_F2 + " 0 R" +
      " /F3 " + OBJ_F3 + " 0 R /F4 " + OBJ_F4 + " 0 R >>" + xobj + " >>" + annots +
      " /Contents " + (contentObjBase + idx) + " 0 R >>\nendobj\n");
  });

  pages.forEach(function (pg, idx) {
    const stream = pg.ops.join("\n");
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
      startObj(required(required(annotObjs[idx])[k]));
      put("<< /Type /Annot /Subtype /Link /Rect [" + [l.x, l.y, l.x + l.w, l.y + l.h].map(n2).join(" ") + "]" +
        " /Border [0 0 0] /A << /S /URI /URI " + pdfInfoString(l.uri) + " >> >>\nendobj\n");
    });
  });

  if (outlineRoot) {
    startObj(outlineRoot);
    put("<< /Type /Outlines /First " + outlineItems[0] + " 0 R /Last " + outlineItems[outlineItems.length - 1] +
      " 0 R /Count " + outlineItems.length + " >>\nendobj\n");
    outline.forEach(function (o, k) {
      startObj(required(outlineItems[k]));
      put("<< /Title " + pdfInfoString(o.title) + " /Parent " + outlineRoot + " 0 R" +
        (k > 0 ? " /Prev " + outlineItems[k - 1] + " 0 R" : "") +
        (k < outline.length - 1 ? " /Next " + outlineItems[k + 1] + " 0 R" : "") +
        " /Dest [" + (firstPageObj + o.page) + " 0 R /XYZ 0 " + n2(o.y == null ? PH : o.y) + " 0] >>\nendobj\n");
    });
  }

  const xrefAt = length;
  let xref = "xref\n0 " + (totalObjs + 1) + "\n0000000000 65535 f \n";
  for (let o = 1; o <= totalObjs; o++) {
    const off = offsets[o] || 0;
    xref += ("0000000000" + off).slice(-10) + " 00000 n \n";
  }
  put(xref);
  put("trailer\n<< /Size " + (totalObjs + 1) + " /Root " + OBJ_CATALOG + " 0 R /Info " + OBJ_INFO + " 0 R >>\nstartxref\n" + xrefAt + "\n%%EOF\n");

  return concatBytes(chunks);
}

const CUE_SCALE = 0.85;

export function pdfWrapRuns(runs: readonly PdfRun[], maxWidth: number, size: number, opts?: { markerWidth: (markers: number[]) => number }): PdfPiece[][] {
  const lines: PdfPiece[][] = [];
  let line: PdfPiece[] = [];
  let lineWidth = 0;
  const markerWidth = opts && opts.markerWidth;

  function pushLine() { lines.push(line); line = []; lineWidth = 0; }

  runs.forEach(function (run) {
    if (run.dir) run = Object.assign({}, run, { i: true });
    const sz = run.cue ? size * CUE_SCALE : size;
    const seg = function (text: string, width: number): PdfPiece {
      const s: PdfPiece = { text: text, b: run.b, i: run.i, u: run.u, s: run.s, mark: run.mark, width: width };
      if (run.dir) s.dir = true;
      if (run.cue) s.cue = true;
      if (run.href) s.href = run.href;
      if (run.tag) s.tag = run.tag;
      if (run.cmt) s.cmt = run.cmt;
      if (run.broll) s.broll = run.broll;
      return s;
    };
    const tail: { word: PdfPiece | null } = { word: null };
    if (run.text === "\n") { pushLine(); return; }
    const words = run.text.split(/(\s+)/);
    words.forEach(function (word) {
      if (!word) return;
      const isSpace = /^\s+$/.test(word);
      if (isSpace && !line.length) return;
      const w = pdfTextWidth(word, run.b, sz);
      if (!isSpace && lineWidth + w > maxWidth && line.length) pushLine();
      if (!isSpace && w > maxWidth) {
        let chunk = "";
        for (let i = 0; i < word.length; i++) {
          if (pdfTextWidth(chunk + word[i], run.b, sz) > maxWidth && chunk) {
            line.push(seg(chunk, pdfTextWidth(chunk, run.b, sz)));
            pushLine();
            chunk = "";
          }
          chunk += word[i];
        }
        if (chunk) {
          const cw = pdfTextWidth(chunk, run.b, sz);
          tail.word = seg(chunk, cw);
          line.push(tail.word);
          lineWidth += cw;
        }
        return;
      }
      const piece = seg(word, w);
      if (!isSpace) tail.word = piece;
      line.push(piece);
      lineWidth += w;
    });
    if (run.markers && tail.word) {
      const extra = markerWidth ? markerWidth(run.markers) : 0;
      tail.word.markers = run.markers;
      tail.word.markerWidth = extra;
      const at = line.indexOf(tail.word);
      if (at !== -1) {
        lineWidth += extra;
        if (lineWidth > maxWidth && at > 0) {
          const moved = line.splice(at);
          lineWidth = line.reduce(function (n, x) { return n + x.width; }, 0);
          while (line.length && /^\s+$/.test(required(line[line.length - 1]).text)) lineWidth -= required(line.pop()).width;
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

const PDF_IMAGE_MAX_PX = 2000;

function pdfJpegOf(pic: ExportPicture | null): Promise<Jpeg | null> {
  if (!pic) return Promise.resolve(null);
  if (pic.mime === "image/jpeg") return Promise.resolve({ bytes: pic.bytes, size: jpegSize(pic.bytes) });
  return new Promise<Jpeg | null>(function (resolve) {
    let url: string;
    try { url = URL.createObjectURL(new Blob([new Uint8Array(pic.bytes)], { type: pic.mime || "" })); } catch (e) { resolve(null); return; }
    const img = new Image();
    function done(v: Jpeg | null): void {
      try { URL.revokeObjectURL(url); } catch (e) {}
      resolve(v);
    }
    img.onload = function () {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, PDF_IMAGE_MAX_PX / Math.max(w, h, 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) { done(null); return; }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          if (!blob) { done(null); return; }
          blob.arrayBuffer().then(function (ab) {
            const bytes = new Uint8Array(ab);
            done({ bytes: bytes, size: jpegSize(bytes) });
          }, function () { done(null); });
        }, "image/jpeg", 0.9);
      } catch (e) { done(null); }
    };
    img.onerror = function () { done(null); };
    img.src = url;
  });
}

export function pdfImagesFor(doc: ExportDocument, assets?: ExportAssets | null): Promise<RowJpegs> {
  const rows = doc.scenes;
  const first: Promise<RowJpegs> = Promise.all(rows.map(function (row) {
    return pdfJpegOf(capturedRowPicture(assets, row)).then(null, function () { return null; });
  }));
  const more = Promise.all(rows.map(function (row) {
    return Promise.all(morePictureRefs(row).map(function (ref) {
      return pdfJpegOf(capturedPicture(assets, ref)).then(null, function () { return null; });
    })).then(function (list) { return list.filter((jpeg): jpeg is Jpeg => jpeg !== null); });
  }));
  return Promise.all([first, more]).then(function (both) {
    both[0].more = both[1];
    return both[0];
  });
}

function commentPic(assets: ExportAssets | null | undefined, sha: string): ExportPicture | null {
  const held = assets ? assets.picture(sha) : null;
  return held && held.mime ? { bytes: held.bytes, mime: held.mime } : null;
}

function commentImageShas(entries: readonly CommentEntry[]): string[] {
  const out: string[] = [], seen: Record<string, boolean> = {};
  function add(pieces: readonly BodyPiece[] | undefined): void {
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

export function pdfCommentImagesFor(doc: ExportDocument, assets?: ExportAssets | null): Promise<CommentJpegs> {
  const shas = commentImageShas(commentEntries(doc, { pieces: true }));
  return Promise.all(shas.map(function (sha) {
    return pdfJpegOf(commentPic(assets, sha)).then(null, function () { return null; });
  })).then(function (list) {
    const out: CommentJpegs = {};
    shas.forEach(function (sha, i) { out[sha] = list[i] || null; });
    return out;
  });
}

function pdfBubblePath(x: number, y: number, w: number, h: number, r: number, low: number): string {
  const kr = r * 0.5523, kl = low * 0.5523;
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

function pdfFitText(str: string, bold: boolean, size: number, width: number): string {
  str = String(str || "");
  if (pdfTextWidth(str, bold, size) <= width) return str;
  while (str.length > 1 && pdfTextWidth(str + "…", bold, size) > width) str = unitSafePrefix(str, str.length - 1);
  const sp = str.lastIndexOf(" ");
  if (sp > str.length * 0.7) str = str.slice(0, sp);
  return str.replace(/[\s,;:]+$/, "") + "…";
}

function pdfAddress(href: string): string {
  return String(href).replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function pdfCount(n: number, one: string, many?: string): string { return n + " " + (n === 1 ? one : (many || one + "s")); }

export function buildPdf(doc: ExportDocument, jpegs?: RowJpegs | null, commentJpegs?: CommentJpegs | null): Uint8Array<ArrayBuffer> {
  const PW = 612, PH = 792, M = 54;
  const C = PRINT_COLORS;
  const TW = PW - 2 * M;
  const GUT = 46, VW = 184, GAP = 14, RW = 32;
  const VX = M + GUT, AX = VX + VW + GAP, AW = PW - M - RW - AX;
  const VS = 9, VL = 12.5, AS = 10, AL = 14;
  const SIZE = 9.5, LEAD = 13;
  const ROW_GAP = 10, TOPB = 10, TAIL = 14, PIC_GAP = 8, EMPTY = 4;
  const HEADS_H = 13 + ROW_GAP;
  const ROW_TOP = PH - M - HEADS_H;
  const PAGE_ROOM = ROW_TOP - M;
  const FOOT_Y = 28;
  const READ_R = PW - M - 3.5;
  const CUE = tagPrintColor("sound") || "AB413E";
  const HIGHLIGHT = "FCE38A";

  const facts = exportFacts(doc);
  const scenes = sceneFacts(doc);
  const nums = doc.commentNumbers;
  const title = facts.title;

  const pages: PdfPage[] = [];
  let ops: string[] = [];
  const images: PdfImage[] = [];
  let pageImages: string[] = [];
  let pageLinks: PdfLink[] = [];
  const outline = [{ title: "Script", page: 0, y: PH }];
  let y = 0;

  function newPage() {
    if (ops.length) pages.push({ ops: ops, images: pageImages, links: pageLinks });
    ops = [pdfRgb(C.text) + " rg"];
    pageImages = [];
    pageLinks = [];
    y = PH - M;
  }

  function fontFor(seg: PdfRun): string {
    if (seg.b && seg.i) return "F4";
    if (seg.b) return "F2";
    if (seg.i) return "F3";
    return "F1";
  }

  function text(str: string, x: number, yy: number, font: string, size: number, hex?: string | null): void { ops.push(pdfTextOp(str, x, yy, font, size, hex)); }
  function fill(hex: string, path: string): void { ops.push("q " + pdfRgb(hex) + " rg " + path + " f Q"); }
  function stroke(hex: string, width: number, path: string): void { ops.push("q " + pdfRgb(hex) + " RG " + width + " w " + path + " S Q"); }
  function bar(x: number, yy: number, w: number, h: number, hex: string): void {
    ops.push("q " + pdfRgb(hex) + " rg " + x.toFixed(2) + " " + yy.toFixed(2) + " " +
      w.toFixed(2) + " " + h.toFixed(2) + " re f Q");
  }

  const MK_SIZE = 6, MK_PAD = 2, MK_H = 7.8, MK_GAP = 1.5;
  function markerW(n: number): number { return Math.max(8, pdfTextWidth(String(n), false, MK_SIZE) + 2 * MK_PAD); }
  function markersWidth(markers: readonly number[]): number {
    return markers.reduce(function (w, n) { return w + MK_GAP + markerW(n); }, 0);
  }
  const WRAP = { markerWidth: markersWidth };

  function cellRuns(html: unknown): PdfRun[] {
    return exportRuns(html, nums).map(function (r) {
      return r.broll ? Object.assign({}, r, { text: "B-roll" }) : r;
    });
  }

  const CHIP_SIZE = 6.5, CHIP_PAD = 2.4;
  function chip(x: number, b: number, room: number): void {
    const tw = pdfTextWidth("B-roll", false, CHIP_SIZE);
    const w = Math.min(room, tw + 2 * CHIP_PAD);
    stroke(C.broll, 0.6, pdfRoundRectPath(x + 0.3, b - 1.9, w - 0.6, 8.4, 1.6));
    text("B-roll", x + (w - tw) / 2, b + 0.3, "F1", CHIP_SIZE, C.broll);
  }

  function segHex(seg: PdfRun): string | null {
    if (seg.color) return seg.color;
    if (seg.href) return C.visual;
    if (seg.tag && seg.tag.color) return seg.tag.color;
    if (seg.dir) return C.faint;
    if (seg.cue) return CUE;
    return null;
  }

  function blank(seg: PdfRun): boolean { return !seg.text.trim(); }
  function marked(line: PdfPiece[], i: number, test: (piece: PdfPiece) => unknown): unknown {
    if (!blank(required(line[i]))) return test(required(line[i]));
    return i > 0 && i < line.length - 1 && test(required(line[i - 1])) && test(required(line[i])) && test(required(line[i + 1]));
  }

  function drawSegs(line: PdfPiece[], x: number, b: number, size: number): void {
    let cx = x;
    let link: PdfLink | null = null;
    line.forEach(function (seg, i) {
      const sp = blank(seg);
      const hex = segHex(seg), ink = hex || C.text;
      if (seg.mark) bar(cx, b - 2.5, seg.width, size + 1, HIGHLIGHT);
      if (!sp) {
        if (seg.broll) chip(cx, b, seg.width);
        else text(seg.text, cx, b, fontFor(seg), seg.cue ? size * CUE_SCALE : size, hex);
      }
      if (marked(line, i, function (s) { return (s.u || s.href) && s.href === seg.href; })) {
        bar(cx, b - 1.7, seg.width, 0.5, ink);
      }
      if (seg.tag && seg.tag.color && marked(line, i, function (s) { return s.tag && s.tag.name === seg.tag?.name; })) {
        bar(cx, b - 2.2, seg.width, 0.6, seg.tag.color);
      }
      if (seg.s && !sp) bar(cx, b + size * 0.28, seg.width, 0.5, ink);
      if (seg.cmt && marked(line, i, function (s) { return !!s.cmt; })) {
        const open = seg.cmt.some(function (id) { return nums[id]; });
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
        const s = String(n), w = markerW(n);
        cx += MK_GAP;
        stroke(C.audio, 0.6, pdfBubblePath(cx + 0.3, b - 1.2, w - 0.6, MK_H, 2, 0.6));
        text(s, cx + (w - pdfTextWidth(s, false, MK_SIZE)) / 2, b + 0.9, "F1", MK_SIZE, C.audio);
        cx += w;
      });
    });
  }

  function drawLines(lines: PdfPiece[][], x: number, startY: number, size?: number, lead?: number): number {
    let yy = startY;
    lines.forEach(function (line) {
      drawSegs(line, x, yy, size || SIZE);
      yy -= lead || LEAD;
    });
    return yy;
  }

  function colHeight(n: number, lead: number): number { return n ? TOPB + (n - 1) * lead + TAIL : EMPTY; }
  function colBottom(c: number, n: number, lead: number): number { return c - colHeight(n, lead); }
  function colFit(c: number, lead: number): number { return Math.max(0, Math.floor((c - TOPB - M) / lead) + 1); }

  function titleBlock() {
    const TS = 20, TLEAD = 24;
    let tl = pdfWrapRuns([{ text: title, b: true }], TW, TS).map(function (l) {
      return l.map(function (s) { return s.text; }).join("").trim();
    });
    if (tl.length > 2) tl = [required(tl[0]), pdfFitText(tl.slice(1).join(" "), true, TS, TW)];
    let b = PH - M - 16;
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

  function rundownStrip(top: number): number {
    const SH = 15, R = 1.5, NS = 6.5;
    const n = scenes.length;
    const total = facts.seconds, target = facts.target ? facts.target.seconds : 0;
    const span = Math.max(total, target);
    if (facts.target) top -= 12;
    const G = n > 1 ? Math.min(1.5, TW * 0.2 / (n - 1)) : 0;
    const avail = TW - G * (n - 1);
    const minW = Math.min(2.5, avail / n);
    const room = Math.max(span > 0 ? avail * total / span : avail, n * minW);
    const secs = scenes.map(function (f) { return f.seconds; });
    const small = secs.map(function () { return false; });
    let k = 0;
    for (let pass = 0; total > 0 && pass <= n; pass++) {
      let fixed = 0, rest = 0;
      secs.forEach(function (s, i) { if (small[i]) fixed += minW; else rest += s; });
      k = rest > 0 ? (room - fixed) / rest : 0;
      let changed = false;
      secs.forEach(function (s, i) {
        if (!small[i] && s * k < minW) { small[i] = true; changed = true; }
      });
      if (!changed) break;
    }
    const widths = secs.map(function (s, i) { return total > 0 ? (small[i] ? minW : s * k) : room / n; });
    const FILL: Record<string, string> = { shot: C.dim, ready: C.audioSoft, todo: C.surface2 };
    const INK: Record<string, string> = { shot: "FFFFFF", ready: C.audio, todo: C.dim };
    const bottom = top - SH;
    let x = M;
    let at = 0;
    let tx: number | null = null;
    scenes.forEach(function (f, i) {
      const w = required(widths[i]), id = FILL[f.status.id] ? f.status.id : "todo", r = Math.min(R, w / 2);
      fill(required(FILL[id]), pdfRoundRectPath(x, bottom, w, SH, r));
      if (id === "ready") stroke(C.audio, 0.6, pdfRoundRectPath(x + 0.3, bottom + 0.3, w - 0.6, SH - 0.6, r));
      if (w >= pdfTextWidth(f.number, false, NS) + 5) text(f.number, x + 2.5, bottom + 5.2, "F1", NS, required(INK[id]));
      if (facts.target && tx === null && target >= at && target < at + f.seconds) {
        tx = x + w * (target - at) / f.seconds;
      }
      at += f.seconds;
      x += w + G;
    });
    if (facts.target) {
      if (tx === null) tx = M + TW;
      stroke(C.text, 0.8, n2(tx) + " " + n2(top + 9) + " m " + n2(tx) + " " + n2(bottom - 2.5) + " l");
      const label = "Target " + facts.target.text, lw = pdfTextWidth(label, false, 7);
      text(label, tx - 3 - lw < M ? tx + 3 : tx - 3 - lw, top + 3, "F1", 7, C.dim);
    }
    const lb = bottom - 13;
    let lx = M;
    ([["shot", "Shot"], ["ready", "Ready"], ["todo", "To do"]] as const).forEach(function (p) {
      const sp = STATUS_PRINT[p[0]], s = p[1] + " " + facts.status[p[0]];
      ops.push(pdfLampOp(sp.lamp, lx + 3, lb + 2.6, 3, sp.color));
      text(s, lx + 9, lb, "F1", 7.5, C.dim);
      lx += 9 + pdfTextWidth(s, false, 7.5) + 12;
    });
    return lb - 20;
  }

  function drawHeads() {
    const b = y - 8;
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

  const NUM_SIZE = 12, TC_SIZE = 7, ST_SIZE = 7.5, READ_SIZE = 8.5;
  function gutterOf(f: SceneFacts): Gutter {
    const nw = pdfTextWidth(f.number, true, NUM_SIZE);
    const stacked = nw + 4 + pdfTextWidth(f.start, false, TC_SIZE) > GUT - 6;
    const drop = stacked ? 22 : 12;
    return { nw: nw, stacked: stacked, drop: drop, h: TOPB + drop + TAIL };
  }

  function drawGutter(f: SceneFacts, g: Gutter, top: number): void {
    const b = top - TOPB;
    text(f.number, M, b, "F2", NUM_SIZE);
    if (g.stacked) text(f.start, M, b - 10, "F1", TC_SIZE, C.faint);
    else text(f.start, M + g.nw + 4, b, "F1", TC_SIZE, C.faint);
    const sb = b - g.drop, sp = STATUS_PRINT[f.status.id] || STATUS_PRINT.todo;
    ops.push(pdfLampOp(sp.lamp, M + 3, sb + 2.6, 3, sp.color));
    text(f.status.label, M + 9, sb, "F1", ST_SIZE, C.dim);
    const rw = pdfTextWidth(f.read, false, READ_SIZE);
    text(f.read, READ_R - rw, b, "F1", READ_SIZE, C.dim);
    if (f.readSet) stroke(C.borderStrong, 0.6, pdfRoundRectPath(READ_R - rw - 3.5, b - 3, rw + 7, 11.5, 2));
  }

  function drawGutterCont(f: SceneFacts, top: number): void {
    const b = top - TOPB;
    text(f.number, M, b, "F2", NUM_SIZE, C.faint);
    text("cont.", M + pdfTextWidth(f.number, true, NUM_SIZE) + 4, b, "F1", TC_SIZE, C.faint);
  }

  newPage();
  titleBlock();
  if (scenes.length) drawHeads();

  doc.scenes.forEach(function (row, idx) {
    const f = required(scenes[idx]);
    const g = gutterOf(f);
    let vLines: PdfPiece[][] = [];
    rowVideoLinks(row).forEach(function (l) {
      const runs: PdfRun[] = l.href ? [{ text: pdfAddress(l.href), href: l.href }] : [{ text: videoLinkText(l) }];
      const label = l.href ? videoHostLabel(l) + " " : "";
      if (label && pdfTextWidth(label + required(runs[0]).text, false, VS) <= VW) runs.unshift({ text: label });
      pdfWrapRuns(runs, VW, VS).forEach(function (line) {
        line.forEach(function (seg) { if (!seg.href) seg.color = C.faint; });
        vLines.push(line);
      });
    });
    vLines = vLines.concat(pdfWrapRuns(cellRuns(row.visualText), VW, VS, WRAP));
    const aLines = pdfWrapRuns(cellRuns(row.audioText), AW, AS, WRAP);

    let imgH = 0;
    let imgRef: DrawPicture | null = null;
    let jpeg = jpegs ? jpegs[idx] : null;
    if (!jpegs) {
      const pic = capturedRowPicture(null, row);
      if (pic && pic.mime === "image/jpeg") jpeg = { bytes: pic.bytes, size: jpegSize(pic.bytes) };
    }
    if (jpeg) {
      try {
        const bytes = jpeg.bytes;
        const dim = safeAspect(jpeg.size);
        const name = "Im" + (images.length + 1);
        images.push({ bytes: bytes, w: dim.w, h: dim.h, name: name });
        let natW = VW, natH = VW * dim.ratio;
        let maxH = PAGE_ROOM;
        if (!vLines.length && colHeight(aLines.length, AL) <= PAGE_ROOM) maxH = PAGE_ROOM - PIC_GAP - EMPTY;
        if (natH > maxH) { natW = natW * (maxH / natH); natH = maxH; }
        imgRef = { name: name, w: natW, h: natH };
        imgH = imgRef.h + PIC_GAP;
      } catch (e) { }
    }

    const moreJpegs = jpegs && jpegs.more ? (jpegs.more[idx] || []) : [];
    const STRIP_GAP = 6, STRIP_N = 3;
    const thumbW = (VW - STRIP_GAP * (STRIP_N - 1)) / STRIP_N;
    const stripLines: { h: number; items: (DrawPicture & { x: number })[] }[] = [];
    moreJpegs.forEach(function (mj, k) {
      try {
        const mdim = safeAspect(mj.size);
        const mname = "Im" + (images.length + 1);
        images.push({ bytes: mj.bytes, w: mdim.w, h: mdim.h, name: mname });
        const th = Math.min(thumbW * mdim.ratio, thumbW * 1.5);
        const tw = th / mdim.ratio;
        if (k % STRIP_N === 0) stripLines.push({ h: 0, items: [] });
        const line = required(stripLines[stripLines.length - 1]);
        line.items.push({ name: mname, w: tw, h: th, x: (k % STRIP_N) * (thumbW + STRIP_GAP) });
        line.h = Math.max(line.h, th);
      } catch (e) { }
    });
    stripLines.forEach(function (line) { imgH += line.h + STRIP_GAP; });

    let stay = idx === 0;
    if (stay && imgRef) {
      const room1 = y - M - (imgH - imgRef.h) - (vLines.length ? 0 : EMPTY);
      if (imgRef.h > room1) {
        if (room1 < 72) stay = false;
        else {
          imgH -= imgRef.h - room1;
          imgRef.w *= room1 / imgRef.h;
          imgRef.h = room1;
        }
      }
    }

    const need = Math.max(imgH + colHeight(vLines.length, VL), colHeight(aLines.length, AL), g.h);
    if (y - need < M && y < ROW_TOP - 0.01 && !stay) scriptPage();

    const top = y;
    drawGutter(f, g, top);

    let vy = top;
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

    let vRest = vLines, aRest = aLines;
    let vCursor = vy, aCursor = top;
    let drewPic = vy !== top;
    let onFirst = true;
    let guard = 0;
    while ((vRest.length || aRest.length) && guard++ < 400) {
      let vTake = vRest.slice(0, colFit(vCursor, VL)), aTake = aRest.slice(0, colFit(aCursor, AL));
      if (vTake.length === vRest.length && aTake.length === aRest.length) {
        const vLow = colBottom(vCursor, vTake.length, VL), aLow = colBottom(aCursor, aTake.length, AL);
        if (Math.min(vLow, aLow) < M - 1e-6) {
          if (vTake.length && (vLow <= aLow || !aTake.length)) vTake = vTake.slice(0, -1);
          else if (aTake.length) aTake = aTake.slice(0, -1);
        }
      }
      if (vTake.length) drawLines(vTake, VX, vCursor - TOPB, VS, VL);
      if (aTake.length) drawLines(aTake, AX, aCursor - TOPB, AS, AL);
      const vEnd = colBottom(vCursor, vTake.length, VL), aEnd = colBottom(aCursor, aTake.length, AL);
      vRest = vRest.slice(vTake.length);
      aRest = aRest.slice(aTake.length);
      if (!vRest.length && !aRest.length) {
        y = Math.min(vEnd, aEnd);
        if (onFirst) y = Math.min(y, top - g.h);
        break;
      }
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

  function section(name: string, summary: string): void {
    newPage();
    outline.push({ title: name, page: pages.length, y: PH });
    text(name, M, y - 16, "F2", 16);
    text(summary, M, y - 33, "F1", 8.5, C.dim);
    y -= 52;
  }
  function sectionGoesOn(name: string): void {
    newPage();
    text(name + " (continued)", M, y - 10, "F2", 10, C.dim);
    y -= 26;
  }

  function linesToRuns(str: string | undefined): PdfRun[] {
    return String(str || "").split(/\r\n|\r|\n/).reduce<PdfRun[]>(function (runs, line, i) {
      if (i > 0) runs.push({ text: "\n" });
      if (line) runs.push({ text: line });
      return runs;
    }, []);
  }
  function tint(lines: PdfPiece[][], hex: string): PdfPiece[][] {
    lines.forEach(function (l) { l.forEach(function (s) { if (!s.broll) s.color = hex; }); });
    return lines;
  }

  const groups = breakdownGroups(doc);
  if (groups.length) {
    let bdItems: BreakdownRow[] = [];
    groups.forEach(function (gr) { bdItems = bdItems.concat(gr.items); });
    section("Production breakdown", [pdfCount(bdItems.length, "item")].concat(TAG_STATUSES.map(function (st) {
      const n = bdItems.filter(function (r) { return r.status === st.id; }).length;
      return n ? n + " " + st.label.toLowerCase() : "";
    }).filter(Boolean)).join(" · "));

    const IW = 186, SX = M + 194, CX = SX + 86, OX = CX + 118;
    const CW = OX - CX - 8, OW = PW - M - OX, BL = 12.5;
    const bdHeads = function () {
      const b = y - 8;
      text("Item", M, b, "F2", 8, C.dim);
      text("Status", SX, b, "F2", 8, C.dim);
      text("Scenes", CX, b, "F2", 8, C.dim);
      text("Assigned to", OX, b, "F2", 8, C.dim);
      ops.push(pdfRuleOp(M, y - 13, PW - M, C.borderStrong, 0.6));
      y -= 13;
    };
    const bdItem = function (r: BreakdownRow) {
      const it = {
        main: 0, h: 0,
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
    const bdGroupHead = function (gr: ReturnType<typeof breakdownGroups>[number]) {
      const b = y - 18;
      fill(gr.color || C.faint, pdfCirclePath(M + 3.2, b + 3.3, 3.2));
      text(gr.label, M + 11, b, "F2", 10);
      text(String(gr.items.length), M + 11 + pdfTextWidth(gr.label, true, 10) + 6, b, "F1", 8.5, C.faint);
      y = b - 6;
    };
    bdHeads();
    groups.forEach(function (gr) {
      const list = gr.items.map(bdItem);
      if (y - 24 - required(list[0]).h < M) { sectionGoesOn("Production breakdown"); bdHeads(); }
      bdGroupHead(gr);
      list.forEach(function (it) {
        if (y - it.h < M) { sectionGoesOn("Production breakdown"); bdHeads(); bdGroupHead(gr); }
        const r = it.r, b = y - 16;
        drawLines(it.name, M, b, SIZE, BL);
        const sp = r.status === "sourcing" || r.status === "have" || r.status === "returned" ? TAG_STATUS_PRINT[r.status] : TAG_STATUS_PRINT.needed;
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

  const shotData = brollShotListForPrint(doc, { filter: "all", group: "scene" });
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

  const comments = exportComments(doc, { pieces: true });
  if (comments.length) {
    const openN = comments.filter(function (c) { return !c.resolved; }).length;
    section("Comments", [openN + " open"].concat(comments.length > openN ? [(comments.length - openN) + " resolved"] : []).join(" · "));
    const FULLW = TW;
    const CI = 20, RI = CI + 14;
    const badge = function (n: number, x: number, b: number) {
      const s = String(n), tw = pdfTextWidth(s, true, 7), w = Math.max(13, tw + 7);
      fill(C.audio, pdfBubblePath(x, b - 2.8, w, 11, 2.6, 0.8));
      text(s, x + (w - tw) / 2, b, "F2", 7, "FFFFFF");
    };

    const CIMG_MAXW = 0.6, CIMG_MAXH = 260, CIMG_ABOVE = 3, CIMG_BELOW = 7;
    const commentImageNames: Record<string, string> = {};

    function commentJpeg(sha: string): Jpeg | null {
      return commentJpegs ? commentJpegs[sha] || null : null;
    }

    function commentPicItem(sha: string, x: number): CommentItem {
      const colW = PW - M - x;
      const jpeg = commentJpeg(sha);
      if (jpeg) {
        try {
          const dim = safeAspect(jpeg.size);
          let name = commentImageNames[sha];
          if (!name) {
            name = "Im" + (images.length + 1);
            images.push({ bytes: jpeg.bytes, w: dim.w, h: dim.h, name: name });
            commentImageNames[sha] = name;
          }
          const scale = Math.min(0.75, colW * CIMG_MAXW / dim.w, CIMG_MAXH / dim.h);
          return { pic: { name: name, w: dim.w * scale, h: dim.h * scale }, x: x };
        } catch (e) { }
      }
      return { line: required(pdfWrapRuns([{ text: "[image unavailable]", i: true }], colW, SIZE)[0]), x: x };
    }

    function commentBodyItems(entry: CommentBody, x: number): CommentItem[] {
      const colW = PW - M - x;
      const pieces = entry.pieces || [];
      const hasPic = pieces.some(function (p) { return p.image; });
      if (!hasPic) {
        return pdfWrapRuns(linesToRuns(entry.body || "(empty)"), colW, SIZE)
          .map(function (l) { return { line: l, x: x }; });
      }
      const items: CommentItem[] = [];
      pieces.forEach(function (p) {
        if (p.image) { items.push(commentPicItem(p.image, x)); return; }
        pdfWrapRuns(linesToRuns(p.text), colW, SIZE).forEach(function (l) { items.push({ line: l, x: x }); });
      });
      return items;
    }

    function drawCommentPic(pic: DrawPicture, x: number): void {
      const top = y - CIMG_ABOVE;
      if (pageImages.indexOf(pic.name) === -1) pageImages.push(pic.name);
      ops.push("q " + pic.w.toFixed(2) + " 0 0 " + pic.h.toFixed(2) + " " +
        x.toFixed(2) + " " + (top - pic.h).toFixed(2) + " cm /" + pic.name + " Do Q");
      y = top - pic.h - CIMG_BELOW;
    }

    comments.forEach(function (c) {
      const meta = [c.author + (c.when ? " · " + c.when : "")];
      if (c.assignee) meta.push("Assigned to " + c.assignee);
      if (c.resolved) meta.push("Resolved" + (c.resolvedBy ? " by " + c.resolvedBy : ""));
      const headerLines = pdfWrapRuns([{ text: c.where, b: true }, { text: "   " + meta.join(" · ") }], FULLW - CI, SIZE);
      headerLines.forEach(function (l) { l.forEach(function (s) { if (!s.b) s.color = C.faint; }); });
      const quoteLines = c.quoted ? tint(pdfWrapRuns(linesToRuns("“" + c.quoted + "”").map(function (run) {
        return Object.assign(run, { i: true });
      }), FULLW - CI, SIZE), C.dim) : [];
      const bodyItems = commentBodyItems(c, M + CI);
      const replyBlocks = c.replies.map(function (rp) {
        const hl = pdfWrapRuns([{ text: rp.author, b: true }, ...(rp.when ? [{ text: "   " + rp.when }] : [])], FULLW - RI, SIZE);
        hl.forEach(function (l) { l.forEach(function (s) { if (!s.b) s.color = C.faint; }); });
        return { headerLines: hl, bodyItems: commentBodyItems(rp, M + RI) };
      });

      const threadLines: ThreadItem[] = [];
      let block = 0;
      function addBlock(items: PdfPiece[][] | CommentItem[], x?: number): void {
        block++;
        items.forEach(function (it) {
          if (Array.isArray(it)) threadLines.push({ line: it, x: required(x), block: block });
          else if (it.pic) threadLines.push(it);
          else threadLines.push({ line: it.line, x: it.x, block: block });
        });
      }
      addBlock(headerLines, M + CI);
      const firstLine = threadLines[0];
      if (c.number && firstLine && !firstLine.pic) firstLine.badge = c.number;
      addBlock(quoteLines, M + CI);
      addBlock(bodyItems);
      replyBlocks.forEach(function (rb) {
        addBlock(rb.headerLines, M + RI);
        addBlock(rb.bodyItems);
      });

      function ensureCommentRoom(need?: number): boolean {
        if (y - (need || LEAD) < M) {
          sectionGoesOn("Comments");
          return true;
        }
        return false;
      }

      let prevBlock = 0;
      ensureCommentRoom();
      threadLines.forEach(function (b) {
        if (b.pic) {
          ensureCommentRoom(CIMG_ABOVE + b.pic.h);
          drawCommentPic(b.pic, b.x);
          prevBlock = 0;
          return;
        }
        let follows = b.block === prevBlock;
        if (ensureCommentRoom(follows ? LEAD - SIZE : LEAD)) follows = false;
        const base = follows ? y : y - SIZE;
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

  return assemblePdf({ size: [PW, PH], pages: pages, images: images, info: { title: title, date: exportDay(doc) },
    outline: outline.length > 1 ? outline : [] });
}

const LIST_PW = 612, LIST_PH = 792, LIST_M = 54;
const LIST_FOOT_Y = 30;

function listSheet(size?: readonly [number, number, number]): ListSheet {
  let activeOps: string[] | null = null;
  const sheet: ListSheet = {
    pages: [],
    get ops() { return required(activeOps ?? undefined); },
    y: 0, body: false,
    PW: size ? size[0] : LIST_PW,
    PH: size ? size[1] : LIST_PH,
    M: size ? size[2] : LIST_M,
    newPage, text, push, bare, finish
  };
  function newPage() {
    if (activeOps) sheet.pages.push(activeOps);
    activeOps = [];
    sheet.y = sheet.PH - sheet.M;
    sheet.body = false;
  }
  function text(str: string, x: number, y: number, font: string, size: number, hex?: string | null) {
    sheet.ops.push(pdfTextOp(str, x, y, font, size, hex));
  }
  function push(ops: string[]) { sheet.ops.push(...ops); }
  function bare() {
    if (activeOps) sheet.pages.push(activeOps);
    activeOps = null;
    return sheet.pages;
  }
  function finish(footTitle: string) {
    sheet.bare();
    const n = sheet.pages.length;
    sheet.pages.forEach(function (ops, i) {
      Array.prototype.push.apply(ops, pdfFooterOps(footTitle, i + 1, n, sheet.PW, sheet.M, LIST_FOOT_Y,
        PRINT_COLORS.faint, PRINT_COLORS.border));
    });
    return sheet.pages;
  }
  sheet.newPage();
  return sheet;
}

function listClean(s: unknown): string {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

function listWrap(runs: readonly PdfRun[], width: number, size: number): PdfPiece[][] {
  return pdfWrapRuns(runs, width, size).map(function (line) {
    const out: PdfPiece[] = [];
    line.forEach(function (seg) {
      const last = out[out.length - 1];
      if (last && last.b === !!seg.b && last.i === !!seg.i) { last.text += seg.text; last.width += seg.width; }
      else out.push({ text: seg.text, b: !!seg.b, i: !!seg.i, width: seg.width });
    });
    return out;
  });
}

function listLineOps(line: PdfPiece[], x: number, y: number, size: number, hex: string, boldHex?: string): string[] {
  const ops: string[] = [];
  let cx = x;
  line.forEach(function (piece) {
    const str = piece.text.replace(/\s+$/, "");
    const font = piece.b ? (piece.i ? "F4" : "F2") : (piece.i ? "F3" : "F1");
    if (str) ops.push(pdfTextOp(str, cx, y, font, size, piece.b ? boldHex || hex : hex));
    cx += piece.width;
  });
  return ops;
}

function listHead(sheet: ListSheet, kicker: string, heading: string, dotHex: string | null, meta: string[]): void {
  const C = PRINT_COLORS, M = sheet.M, W = sheet.PW - 2 * sheet.M;
  let y = sheet.y - 7;
  sheet.text(kicker, M, y, "F1", 9, C.faint);
  const hx = dotHex ? M + 16 : M;
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

export function buildPackingListPdf(doc: ExportDocument, catId: string): Uint8Array<ArrayBuffer> {
  const C = PRINT_COLORS, M = LIST_M, W = LIST_PW - 2 * LIST_M;
  const cat = tagCategory(catId);
  const title = doc.title || "Untitled Script";
  const heading = cat ? cat.plural : catId;
  const docTitle = title + " — " + heading + " packing list";
  const group = breakdownGroups(doc).filter(function (g) { return g.catId === catId; })[0];
  const items = (group ? group.items : []).slice()
    .sort(function (a, b) { return a.name.localeCompare(b.name); });

  const sheet = listSheet();
  const meta = [title + " · " + exportDateText(exportDay(doc))];
  if (items.length) meta.push(packingSummary(items));
  listHead(sheet, "Packing list", heading, cat ? tagPrintColor(cat.id) : null, meta);

  if (!items.length) {
    sheet.text("Nothing tagged " + (cat ? cat.label : catId) + " yet.", M, sheet.y + 4, "F1", 11, C.dim);
    return assembleTextPdf(doc, sheet.finish(docTitle), LIST_PW, LIST_PH, docTitle);
  }

  const ky = sheet.y - 4;
  const KEY_X = M + 40, KEY_W = 46, KEY_GAP = 2, KEY_H = 9;
  sheet.ops.push(pdfTextOp("Status", M, ky, "F1", 8.5, C.dim));
  sheet.ops.push(packingPillOp(null, KEY_X, ky - 1, { seg: KEY_W, gap: KEY_GAP, h: KEY_H }));
  TAG_STATUSES.forEach(function (st, i) {
    const cx = KEY_X + i * (KEY_W + KEY_GAP) + KEY_W / 2;
    sheet.ops.push(pdfTextOp(st.label, cx - pdfTextWidth(st.label, false, 7.5) / 2, ky - 12, "F1", 7.5, C.dim));
  });
  sheet.ops.push(pdfTextOp("Fill in each step as it happens", KEY_X + 4 * KEY_W + 3 * KEY_GAP + 12, ky, "F3", 8, C.faint));
  sheet.y = ky - 26;

  const BOX = 11, OUT_X = M + 1.4, BACK_X = M + 29.4;
  const ITEM_X = M + 58, ITEM_W = 188;
  const STATUS_X = M + 256;
  const OWNER_X = M + 338, OWNER_W = 100;
  const SCENES_X = M + 448, SCENES_W = W - 448;
  const TOP = 16, NAME_LEAD = 13.5, UNDER_GAP = 13, UNDER_LEAD = 11.5, COL_LEAD = 12.5, TAIL = 8;

  function columnHeads(continued: boolean): void {
    let y = sheet.y;
    if (continued) { sheet.text(heading + " (continued)", M, y - 7, "F1", 9, C.faint); y -= 24; }
    y -= 8;
    ([["Out", M], ["Back", M + 25.4], ["Item", ITEM_X], ["Status", STATUS_X], ["Owner", OWNER_X], ["Scenes", SCENES_X]] as const)
      .forEach(function (h) { sheet.text(h[0], h[1], y, "F1", 8.5, C.dim); });
    sheet.ops.push(pdfRuleOp(M, y - 6, M + W, C.borderStrong, 0.75));
    sheet.y = y - 6;
  }

  function rowOf(item: BreakdownRow): PackingRow {
    const orphaned = item.inScript === "no";
    const under: PackingRow["under"] = [];
    if (listClean(item.notes)) {
      listWrap([{ text: listClean(item.notes) }], ITEM_W, 9).forEach(function (l) { under.push({ line: l }); });
    }
    if (item.broll.length) {
      listWrap([{ text: "B-roll: ", b: true }, { text: item.broll.map(listClean).join(", ") }], ITEM_W, 9)
        .forEach(function (l) { under.push({ line: l, boldHex: C.broll }); });
    }
    const r: PackingRow = {
      height: 0,
      name: listWrap([{ text: listClean(item.name), b: true }], ITEM_W, 11),
      under: under,
      status: { id: item.status, label: item.statusLabel },
      owner: item.owner ? listWrap([{ text: listClean(item.owner) }], OWNER_W, 10) : [],
      scenes: listWrap([{ text: orphaned ? "Not in script" : item.scenes.join(", ") }], SCENES_W, 9.5),
      orphaned: orphaned
    };
    let depth = (r.name.length - 1) * NAME_LEAD;
    if (under.length) depth += UNDER_GAP + (under.length - 1) * UNDER_LEAD;
    r.height = TOP + Math.max(depth, (Math.max(1, r.owner.length, r.scenes.length) - 1) * COL_LEAD) + TAIL;
    return r;
  }

  function drawRow(r: PackingRow): void {
    const base = sheet.y - TOP;
    let low = base;
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

  const SIGN_GAP = 40, SIGN_LEAD = 30;
  if (sheet.y - SIGN_GAP - SIGN_LEAD - 6 < M) {
    sheet.newPage();
    sheet.text(heading + " (continued)", M, sheet.y - 7, "F1", 9, C.faint);
    sheet.y -= 10;
  }
  let sy = sheet.y - SIGN_GAP;
  ["Packed by", "Returned by"].forEach(function (label) {
    sheet.text(label, M, sy, "F1", 10, C.dim);
    sheet.ops.push(pdfRuleOp(M + 62, sy - 2, M + 300, C.borderStrong, 0.75));
    sheet.text("Date", M + 318, sy, "F1", 10, C.dim);
    sheet.ops.push(pdfRuleOp(M + 344, sy - 2, M + W, C.borderStrong, 0.75));
    sy -= SIGN_LEAD;
  });

  return assembleTextPdf(doc, sheet.finish(docTitle), LIST_PW, LIST_PH, docTitle);
}

function pillFill(id: string): string {
  const C = PRINT_COLORS;
  const colors: Record<string, string> = { needed: C.audio, sourcing: C.audio, have: C.dim, returned: C.faint };
  return colors[id] || C.audio;
}

function pillSegmentPath(x: number, y: number, w: number, h: number, roundLeft: boolean, roundRight: boolean): string {
  const r = h / 2, k = r * 0.5523;
  function p(a: number, b: number): string { return a.toFixed(2) + " " + b.toFixed(2); }
  let out = p(x + (roundLeft ? r : 0), y) + " m " + p(x + w - (roundRight ? r : 0), y) + " l ";
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

function packingPillOp(id: string | null, x: number, y: number, size: { seg: number; gap: number; h: number }): string {
  const level = id === null ? -1 : Math.max(0, TAG_STATUSES.findIndex(function (st) { return st.id === id; }));
  const fill = level === -1 ? "" : pdfRgb(pillFill(required(TAG_STATUSES[level]).id));
  const edge = pdfRgb(PRINT_COLORS.faint);
  return TAG_STATUSES.map(function (st, i) {
    const path = pillSegmentPath(x + i * (size.seg + size.gap), y, size.seg, size.h, i === 0, i === TAG_STATUSES.length - 1);
    return i <= level
      ? "q " + fill + " rg " + path + " f Q"
      : "q " + edge + " RG 0.6 w " + path + " S Q";
  }).join(" ");
}

function packingSummary(items: readonly BreakdownRow[]): string {
  const n: Record<string, number> = {}, label: Record<string, string> = {};
  items.forEach(function (e) {
    n[e.status] = (n[e.status] || 0) + 1;
    label[e.status] = e.statusLabel.toLowerCase();
  });
  const out = [items.length + (items.length === 1 ? " item" : " items")];
  ["have", "sourcing", "needed", "returned"].forEach(function (id) {
    if (n[id]) out.push(n[id] + " " + label[id]);
  });
  return out.join(" · ");
}

function assembleTextPdf(doc: ExportDocument, pages: string[][], PW: number, PH: number, title: string): Uint8Array<ArrayBuffer> {
  return assemblePdf({
    size: [PW, PH],
    pages: pages.map(function (ops) { return { ops: ops }; }),
    info: { title: title, date: exportDay(doc) }
  });
}

const FLAG_PRINT = "C4302A";

function shotCutsOpening(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = unitSafePrefix(text, max);
  const space = cut.lastIndexOf(" ");
  if (space > max / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.–—-]+$/, "") + "…";
}

const SHOT_PW = 792, SHOT_PH = 612, SHOT_M = 36, SHOT_BOTTOM = 54;

export function buildShotListPdf(doc: ExportDocument, data: ShotData): Uint8Array<ArrayBuffer> {
  const C = PRINT_COLORS, M = SHOT_M;
  const docTitle = data.title + " — B-roll shot list";
  const sheet = listSheet([SHOT_PW, SHOT_PH, SHOT_M]);
  listHead(sheet, "B-roll shot list", data.title, null, [data.summary + " · " + data.scope + " · " + exportDateText(exportDay(doc))]);
  if (!data.groups.length) sheet.text("No shots to list.", M, sheet.y + 4, "F1", 11, C.dim);
  else drawShotTable(sheet, data, "B-roll shot list");
  return assembleTextPdf(doc, sheet.finish(docTitle), SHOT_PW, SHOT_PH, docTitle);
}

export function shotListAppendixPages(data: ShotData): string[][] {
  const C = PRINT_COLORS, M = SHOT_M;
  const sheet = listSheet([SHOT_PW, SHOT_PH, SHOT_M]);
  sheet.text("B-roll shot list", M, sheet.y - 16, "F2", 16, C.text);
  sheet.text(data.summary + " · " + data.scope, M, sheet.y - 33, "F1", 8.5, C.dim);
  sheet.y -= 46;
  drawShotTable(sheet, data, "B-roll shot list");
  return sheet.bare();
}

function drawShotTable(sheet: ListSheet, data: ShotData, name: string): void {
  const C = PRINT_COLORS, M = sheet.M, W = sheet.PW - 2 * sheet.M;
  const COLS: Record<ShotColumn, { x: number; w: number }> = {
    done: { x: 0, w: 16 }, scene: { x: 22, w: 40 }, shot: { x: 66, w: 184 },
    location: { x: 258, w: 72 }, props: { x: 338, w: 102 }, owner: { x: 448, w: 58 },
    flag: { x: 514, w: 80 }, notes: { x: 602, w: W - 602 }
  };
  const HEADS: [ShotColumn, string][] = [["done", "Done"], ["scene", "Scene"], ["shot", "B-roll shot"], ["location", "Location"],
    ["props", "Props"], ["owner", "Assigned"], ["flag", "Flagged"], ["notes", "Notes"]];
  const TOP = 12, TAIL = 8, MIN_ROW = 34, WRITE_LEAD = 11;

  function heads(continued: boolean): void {
    if (continued) { sheet.text(name + " (continued)", M, sheet.y - 7, "F1", 9, C.faint); sheet.y -= 20; }
    const b = sheet.y - 10;
    HEADS.forEach(function (h) { sheet.text(h[1], M + COLS[h[0]].x, b, "F1", 7.5, C.dim); });
    sheet.y = b - 5;
    sheet.ops.push(pdfRuleOp(M, sheet.y, M + W, C.borderStrong, 0.75));
  }

  function col(runs: readonly PdfRun[], w: number, size: number, hex: string, lead: number, boldHex?: string): ShotLine[] {
    return listWrap(runs, w, size).map(function (line) {
      return { line: line, size: size, hex: hex, boldHex: boldHex || hex, lead: lead };
    });
  }
  function depth(lines: ShotLine[]): number {
    return lines.reduce(function (n, l, i) { return n + (i ? l.lead : 0); }, 0);
  }

  function rowOf(r: Shot, showScene: boolean, g: ShotGroup): ShotRow {
    const cells: ShotRow["cells"] = {};
    const nameHex = r.shot ? C.faint : C.text;
    if (showScene && r.scene) {
      cells.scene = col([{ text: r.scene, b: true }], COLS.scene.w, 9.5, C.text, 0)
        .concat(r.start ? col([{ text: r.start }], COLS.scene.w, 7.5, C.faint, 10) : []);
    }
    let shot = col([{ text: listClean(r.name), b: true }], COLS.shot.w, 9.5, nameHex, 11.5);
    String(r.desc || "").split("\n").forEach(function (para) {
      if (listClean(para)) shot = shot.concat(col([{ text: listClean(para) }], COLS.shot.w, 8, r.shot ? C.faint : C.dim, 10));
    });
    if (r.cuts) shot = shot.concat(col([{ text: "“" + shotCutsOpening(listClean(r.cuts), 84) + "”", i: true }], COLS.shot.w, 7.5, C.faint, 9.5));
    cells.shot = shot;
    if (r.location && g.kind !== "location") cells.location = col([{ text: listClean(r.location) }], COLS.location.w, 8.5, C.dim, 10.5);
    const props = r.propsWithStatus || r.props;
    if (props.length) {
      cells.props = [];
      props.forEach(function (p) { cells.props = required(cells.props).concat(col([{ text: listClean(p) }], COLS.props.w, 8.5, C.dim, 10.5)); });
    }
    if (r.owner && g.kind !== "person") cells.owner = col([{ text: listClean(r.owner) }], COLS.owner.w, 8.5, C.dim, 10.5);
    const note = listClean(r.note);
    if (r.flagged) {
      cells.flag = col([{ text: "Flagged", b: true }], COLS.flag.w, 8.5, FLAG_PRINT, 0)
        .concat(note ? col([{ text: note }], COLS.flag.w, 8, C.dim, 10) : []);
    } else if (note) {
      cells.notes = col([{ text: note }], COLS.notes.w, 8, C.dim, 10);
    }
    let tallest = 0;
    Object.values(cells).forEach(function (lines) { if (lines) tallest = Math.max(tallest, depth(lines)); });
    return { r: r, cells: cells, height: Math.max(MIN_ROW, TOP + tallest + TAIL) };
  }

  function drawRow(row: ShotRow): void {
    const top = sheet.y, base = top - TOP, bottom = top - row.height;
    sheet.ops.push(pdfCheckboxOp(M + COLS.done.x + 1, base - 1.2, 9, row.r.shot, C.faint, C.broll));
    let notesLow = base + WRITE_LEAD - 2;
    HEADS.forEach(function ([k]) {
      const lines = row.cells[k];
      if (!lines) return;
      let y = base;
      lines.forEach(function (l, i) {
        y -= i ? l.lead : 0;
        sheet.push(listLineOps(l.line, M + COLS[k].x, y, l.size, l.hex, l.boldHex));
      });
      if (k === "notes") notesLow = y;
    });
    for (let wy = notesLow - WRITE_LEAD + 1; wy > bottom + 4; wy -= WRITE_LEAD) {
      sheet.ops.push(pdfRuleOp(M + COLS.notes.x, wy, M + W, C.borderStrong, 0.5));
    }
    sheet.y = bottom;
    sheet.body = true;
  }

  function band(g: ShotGroup, continued: boolean): void {
    const b = sheet.y - 14;
    let x = M;
    if (g.kind === "location" && !g.none) {
      sheet.ops.push(listPinOp(M + 3.5, b + 4.6, 2.8, tagPrintColor("location") || C.faint));
      x = M + 11;
    }
    sheet.push(listLineOps(required(listWrap([{ text: listClean(g.label), b: true }], W - 120, 9.5)[0]), x, b, 9.5, C.text, C.text));
    const right = continued ? "(continued)" : g.done + "/" + g.total + " shot";
    const allShot = !continued && g.total && g.done === g.total;
    sheet.text(right, M + W - pdfTextWidth(right, false, 8.5), b, "F1", 8.5, allShot ? C.broll : C.faint);
    sheet.y = b - 6;
    sheet.ops.push(pdfRuleOp(M, sheet.y, M + W, C.borderStrong, 0.6));
  }

  heads(false);
  data.groups.forEach(function (g, gi) {
    const byScene = g.kind === "scene";
    const rows = g.items.map(function (r, i) { return rowOf(r, !byScene || i === 0, g); });
    const bandH = byScene ? 0 : 20;
    if (sheet.y - bandH - (rows.length ? required(rows[0]).height : 0) < SHOT_BOTTOM && sheet.body) { sheet.newPage(); heads(true); }
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

function listPinOp(cx: number, cy: number, r: number, hex: string): string {
  return "q " + pdfRgb(hex) + " rg " + pdfCirclePath(cx, cy, r) + " f " +
    n2(cx - r * 0.88) + " " + n2(cy - r * 0.476) + " m " + n2(cx) + " " + n2(cy - r * 2.1) + " l " +
    n2(cx + r * 0.88) + " " + n2(cy - r * 0.476) + " l h f 1 1 1 rg " + pdfCirclePath(cx, cy, r * 0.4) + " f Q";
}

export function __init() {}
