import { NOTO_SANS_REGULAR } from "./pdf-fonts/noto-sans-regular.ts";
import { NOTO_SANS_BOLD } from "./pdf-fonts/noto-sans-bold.ts";
import { NOTO_EMOJI } from "./pdf-fonts/noto-emoji.ts";
import { parseTrueType, subsetTrueType } from "./truetype.ts";
import type { TrueTypeFont } from "./truetype.ts";

export interface PdfUnicodeFont {
  readonly resource: string;
  readonly name: string;
  readonly font: TrueTypeFont;
  readonly width: (gid: number) => number;
}

export interface PdfFontSet {
  readonly regular: PdfUnicodeFont;
  readonly bold: PdfUnicodeFont;
  readonly emoji: PdfUnicodeFont;
}

export type PdfObjectBody = readonly (string | Uint8Array)[];

let loading: Promise<PdfFontSet | null> | null = null;

function base64Bytes(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function pdfUnicodeFont(resource: string, name: string, bytes: Uint8Array): PdfUnicodeFont {
  const font = parseTrueType(bytes);
  return {
    resource: resource,
    name: name,
    font: font,
    width: (gid) => Math.round(font.advance(gid) * 1000 / font.unitsPerEm)
  };
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(c) { c.enqueue(bytes); c.close(); } });
  return new Uint8Array(await new Response(source.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}

async function unpack(resource: string, name: string, data: string): Promise<PdfUnicodeFont> {
  return pdfUnicodeFont(resource, name, await inflate(base64Bytes(data)));
}

export function loadPdfFonts(): Promise<PdfFontSet | null> {
  if (!loading) {
    loading = Promise.all([
      unpack("U1", "NotoSans-Regular", NOTO_SANS_REGULAR),
      unpack("U2", "NotoSans-Bold", NOTO_SANS_BOLD),
      unpack("U3", "NotoEmoji-Regular", NOTO_EMOJI)
    ]).then(
      (fonts) => ({ regular: fonts[0], bold: fonts[1], emoji: fonts[2] }),
      () => null
    );
  }
  return loading;
}

function hex4(n: number): string {
  return ("000" + n.toString(16).toUpperCase()).slice(-4);
}

function utf16Hex(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += hex4(text.charCodeAt(i));
  return out;
}

function subsetTag(gids: readonly number[]): string {
  let h = 0x811c9dc5;
  gids.forEach((g) => { h ^= g; h = Math.imul(h, 0x01000193); });
  let tag = "";
  for (let i = 0; i < 6; i++) { tag += String.fromCharCode(65 + (h >>> 0) % 26); h = Math.floor((h >>> 0) / 26); }
  return tag;
}

function toUnicodeCmap(used: ReadonlyMap<number, string>): string {
  const entries = Array.from(used.entries()).sort((a, b) => a[0] - b[0]);
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    blocks.push(part.length + " beginbfchar\n" + part.map((e) => "<" + hex4(e[0]) + "> <" + utf16Hex(e[1]) + ">").join("\n") + "\nendbfchar");
  }
  return "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    blocks.join("\n") +
    "\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
}

export function unicodeFontObjects(f: PdfUnicodeFont, used: ReadonlyMap<number, string>, base: number): PdfObjectBody[] {
  const gids = Array.from(used.keys()).sort((a, b) => a - b);
  const baseFont = subsetTag(gids) + "+" + f.name;
  const scale = (v: number) => Math.round(v * 1000 / f.font.unitsPerEm);
  const file = subsetTrueType(f.font, gids);
  const cmap = toUnicodeCmap(used);
  const widths = gids.map((g) => g + " [" + f.width(g) + "]").join(" ");
  const descriptor = "<< /Type /FontDescriptor /FontName /" + baseFont + " /Flags 4 /FontBBox [" +
    f.font.bbox.map(scale).join(" ") + "] /ItalicAngle 0 /Ascent " + scale(f.font.ascent) +
    " /Descent " + scale(f.font.descent) + " /CapHeight " + scale(f.font.capHeight) +
    " /StemV 80 /FontFile2 " + (base + 3) + " 0 R >>\nendobj\n";
  return [
    ["<< /Type /Font /Subtype /Type0 /BaseFont /" + baseFont + " /Encoding /Identity-H /DescendantFonts [" +
      (base + 1) + " 0 R] /ToUnicode " + (base + 4) + " 0 R >>\nendobj\n"],
    ["<< /Type /Font /Subtype /CIDFontType2 /BaseFont /" + baseFont +
      " /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor " + (base + 2) +
      " 0 R /DW 1000 /W [" + widths + "] /CIDToGIDMap /Identity >>\nendobj\n"],
    [descriptor],
    ["<< /Length " + file.length + " /Length1 " + file.length + " >>\nstream\n", file, "\nendstream\nendobj\n"],
    ["<< /Length " + cmap.length + " >>\nstream\n" + cmap + "\nendstream\nendobj\n"]
  ];
}
