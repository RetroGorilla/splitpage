export interface TrueTypeFont {
  readonly bytes: Uint8Array;
  readonly unitsPerEm: number;
  readonly numGlyphs: number;
  readonly bbox: readonly [number, number, number, number];
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  readonly glyphFor: (codePoint: number) => number;
  readonly advance: (gid: number) => number;
  readonly tables: ReadonlyMap<string, { offset: number; length: number }>;
}

const COMPOSITE_WORDS = 0x0001;
const COMPOSITE_SCALE = 0x0008;
const COMPOSITE_MORE = 0x0020;
const COMPOSITE_XY_SCALE = 0x0040;
const COMPOSITE_2X2 = 0x0080;

function reader(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    u16: (at: number) => dv.getUint16(at),
    i16: (at: number) => dv.getInt16(at),
    u32: (at: number) => dv.getUint32(at)
  };
}

function readCmap(bytes: Uint8Array, offset: number): Map<number, number> {
  const r = reader(bytes);
  const count = r.u16(offset + 2);
  let best = -1, bestRank = 0;
  for (let i = 0; i < count; i++) {
    const rec = offset + 4 + i * 8;
    const platform = r.u16(rec), encoding = r.u16(rec + 2), sub = offset + r.u32(rec + 4);
    const format = r.u16(sub);
    const rank = format === 12 && (platform === 3 && encoding === 10 || platform === 0) ? 3
      : format === 4 && (platform === 3 && encoding === 1 || platform === 0) ? 2 : 0;
    if (rank > bestRank) { best = sub; bestRank = rank; }
  }
  const map = new Map<number, number>();
  if (best < 0) return map;
  if (bestRank === 3) {
    const groups = r.u32(best + 12);
    for (let g = 0; g < groups; g++) {
      const at = best + 16 + g * 12;
      const start = r.u32(at), end = r.u32(at + 4), gid = r.u32(at + 8);
      for (let cp = start; cp <= end; cp++) map.set(cp, gid + cp - start);
    }
    return map;
  }
  const segs = r.u16(best + 6) / 2;
  const ends = best + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
  for (let s = 0; s < segs; s++) {
    const end = r.u16(ends + s * 2), start = r.u16(starts + s * 2), delta = r.i16(deltas + s * 2);
    const rangeAt = ranges + s * 2, range = r.u16(rangeAt);
    for (let cp = start; cp <= end && cp !== 0xFFFF; cp++) {
      let gid: number;
      if (range === 0) gid = (cp + delta) & 0xFFFF;
      else {
        gid = r.u16(rangeAt + range + (cp - start) * 2);
        if (gid !== 0) gid = (gid + delta) & 0xFFFF;
      }
      if (gid !== 0) map.set(cp, gid);
    }
  }
  return map;
}

export function parseTrueType(bytes: Uint8Array): TrueTypeFont {
  const r = reader(bytes);
  const tag = r.u32(0);
  if (tag !== 0x00010000 && tag !== 0x74727565) throw new Error("not a TrueType font");
  const tables = new Map<string, { offset: number; length: number }>();
  const count = r.u16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const name = String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
    tables.set(name, { offset: r.u32(at + 8), length: r.u32(at + 12) });
  }
  function table(name: string): number {
    const t = tables.get(name);
    if (!t) throw new Error("font has no " + name + " table");
    return t.offset;
  }
  const head = table("head"), hhea = table("hhea"), maxp = table("maxp"), hmtx = table("hmtx");
  table("loca");
  table("glyf");
  const unitsPerEm = r.u16(head + 18);
  const numGlyphs = r.u16(maxp + 4);
  const metrics = r.u16(hhea + 34);
  const ascent = r.i16(hhea + 4), descent = r.i16(hhea + 6);
  const os2 = tables.get("OS/2");
  const capHeight = os2 && r.u16(os2.offset) >= 2 ? r.i16(os2.offset + 88) : ascent;
  const cmapTable = tables.get("cmap");
  const cmap = cmapTable ? readCmap(bytes, cmapTable.offset) : new Map<number, number>();
  return {
    bytes: bytes,
    unitsPerEm: unitsPerEm,
    numGlyphs: numGlyphs,
    bbox: [r.i16(head + 36), r.i16(head + 38), r.i16(head + 40), r.i16(head + 42)],
    ascent: ascent,
    descent: descent,
    capHeight: capHeight,
    glyphFor: (cp) => cmap.get(cp) ?? 0,
    advance: (gid) => r.u16(hmtx + Math.min(gid, metrics - 1) * 4),
    tables: tables
  };
}

function glyphRange(font: TrueTypeFont, gid: number): [number, number] {
  const r = reader(font.bytes);
  const head = required(font.tables.get("head")).offset;
  const loca = required(font.tables.get("loca")).offset;
  const glyf = required(font.tables.get("glyf")).offset;
  const long = r.i16(head + 50) === 1;
  const start = long ? r.u32(loca + gid * 4) : r.u16(loca + gid * 2) * 2;
  const end = long ? r.u32(loca + gid * 4 + 4) : r.u16(loca + gid * 2 + 2) * 2;
  return [glyf + start, glyf + end];
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing font table");
  return value;
}

function components(font: TrueTypeFont, gid: number): number[] {
  const [start, end] = glyphRange(font, gid);
  if (end - start < 10) return [];
  const r = reader(font.bytes);
  if (r.i16(start) >= 0) return [];
  const out: number[] = [];
  let at = start + 10, flags = COMPOSITE_MORE;
  while (flags & COMPOSITE_MORE && at + 4 <= end) {
    flags = r.u16(at);
    out.push(r.u16(at + 2));
    at += 4 + (flags & COMPOSITE_WORDS ? 4 : 2);
    if (flags & COMPOSITE_SCALE) at += 2;
    else if (flags & COMPOSITE_XY_SCALE) at += 4;
    else if (flags & COMPOSITE_2X2) at += 8;
  }
  return out;
}

export function glyphClosure(font: TrueTypeFont, gids: Iterable<number>): Set<number> {
  const keep = new Set<number>();
  const todo = [0].concat(Array.from(gids));
  while (todo.length) {
    const gid = required(todo.pop());
    if (keep.has(gid) || gid >= font.numGlyphs) continue;
    keep.add(gid);
    components(font, gid).forEach((c) => { if (!keep.has(c)) todo.push(c); });
  }
  return keep;
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    sum = (sum + (((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0;
  }
  return sum;
}

function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array((bytes.length + 3) & ~3);
  out.set(bytes);
  return out;
}

export function subsetTrueType(font: TrueTypeFont, gids: Iterable<number>): Uint8Array<ArrayBuffer> {
  const keep = glyphClosure(font, gids);
  const count = Math.max(...keep) + 1;
  const r = reader(font.bytes);
  const slices: Uint8Array[] = [];
  const loca = new Uint8Array((count + 1) * 4);
  const locaView = new DataView(loca.buffer);
  let glyfLength = 0;
  for (let gid = 0; gid < count; gid++) {
    locaView.setUint32(gid * 4, glyfLength);
    if (!keep.has(gid)) continue;
    const [start, end] = glyphRange(font, gid);
    const data = padded(font.bytes.subarray(start, end));
    slices.push(data);
    glyfLength += data.length;
  }
  locaView.setUint32(count * 4, glyfLength);
  const glyf = new Uint8Array(glyfLength);
  let at = 0;
  slices.forEach((s) => { glyf.set(s, at); at += s.length; });

  const hmtx = new Uint8Array(count * 4);
  const hmtxView = new DataView(hmtx.buffer);
  const hmtxAt = required(font.tables.get("hmtx")).offset, metrics = r.u16(required(font.tables.get("hhea")).offset + 34);
  for (let gid = 0; gid < count; gid++) {
    hmtxView.setUint16(gid * 4, font.advance(gid));
    const lsb = gid < metrics ? r.i16(hmtxAt + gid * 4 + 2) : r.i16(hmtxAt + metrics * 4 + (gid - metrics) * 2);
    hmtxView.setInt16(gid * 4 + 2, lsb);
  }

  function copy(name: string): Uint8Array {
    const t = required(font.tables.get(name));
    return font.bytes.slice(t.offset, t.offset + t.length);
  }
  const head = copy("head");
  const headView = new DataView(head.buffer);
  headView.setUint32(8, 0);
  headView.setInt16(50, 1);
  const hhea = copy("hhea");
  new DataView(hhea.buffer).setUint16(34, count);
  const maxp = copy("maxp");
  new DataView(maxp.buffer).setUint16(4, count);

  const out = new Map<string, Uint8Array>([["glyf", glyf], ["head", head], ["hhea", hhea], ["hmtx", hmtx], ["loca", loca], ["maxp", maxp]]);
  ["cvt ", "fpgm", "prep"].forEach((name) => { if (font.tables.has(name)) out.set(name, copy(name)); });
  const names = Array.from(out.keys()).sort();
  const dirLength = 12 + names.length * 16;
  let total = dirLength;
  names.forEach((n) => { total += padded(required(out.get(n))).length; });
  const file = new Uint8Array(total);
  const fv = new DataView(file.buffer);
  let pow = 1, log = 0;
  while (pow * 2 <= names.length) { pow *= 2; log++; }
  fv.setUint32(0, 0x00010000);
  fv.setUint16(4, names.length);
  fv.setUint16(6, pow * 16);
  fv.setUint16(8, log);
  fv.setUint16(10, names.length * 16 - pow * 16);
  let offset = dirLength, headAt = 0;
  names.forEach((n, i) => {
    const data = required(out.get(n));
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) file[rec + k] = n.charCodeAt(k);
    fv.setUint32(rec + 4, checksum(padded(data)));
    fv.setUint32(rec + 8, offset);
    fv.setUint32(rec + 12, data.length);
    if (n === "head") headAt = offset;
    file.set(data, offset);
    offset += padded(data).length;
  });
  fv.setUint32(headAt + 8, (0xB1B0AFBA - checksum(file)) >>> 0);
  return file;
}
