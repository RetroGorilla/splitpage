import test from "node:test";
import assert from "node:assert/strict";
import { glyphClosure, parseTrueType, subsetTrueType } from "../../../src/adapters/formats/truetype.ts";

function simpleGlyph(x) {
  const g = new DataView(new ArrayBuffer(20));
  g.setInt16(0, 1);
  g.setInt16(2, x); g.setInt16(4, 0); g.setInt16(6, x); g.setInt16(8, 700);
  g.setUint16(10, 0);
  g.setUint16(12, 0);
  g.setUint8(14, 1);
  g.setInt16(15, x); g.setInt16(17, 700);
  return new Uint8Array(g.buffer);
}

function compositeGlyph(first, second) {
  const g = new DataView(new ArrayBuffer(26));
  g.setInt16(0, -1);
  g.setUint16(10, 0x0001 | 0x0020); g.setUint16(12, first); g.setInt16(14, 0); g.setInt16(16, 0);
  g.setUint16(18, 0x0001); g.setUint16(20, second); g.setInt16(22, 300); g.setInt16(24, 0);
  return new Uint8Array(g.buffer);
}

function cmapFormat4(pairs) {
  const segs = pairs.length + 1;
  const sub = new DataView(new ArrayBuffer(16 + segs * 8));
  sub.setUint16(0, 4); sub.setUint16(2, sub.byteLength); sub.setUint16(6, segs * 2);
  pairs.concat([[0xFFFF, 0]]).forEach(([cp, gid], s) => {
    sub.setUint16(14 + s * 2, cp);
    sub.setUint16(16 + segs * 2 + s * 2, cp);
    sub.setInt16(16 + segs * 4 + s * 2, cp === 0xFFFF ? 1 : (gid - cp) & 0xFFFF);
  });
  const head = new DataView(new ArrayBuffer(12));
  head.setUint16(2, 1); head.setUint16(4, 3); head.setUint16(6, 1); head.setUint32(8, 12);
  return concat([new Uint8Array(head.buffer), new Uint8Array(sub.buffer)]);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  parts.forEach((p) => { out.set(p, at); at += p.length; });
  return out;
}

function tinyFont() {
  const glyphs = [simpleGlyph(10), simpleGlyph(20), simpleGlyph(30), compositeGlyph(1, 2), simpleGlyph(50)];
  const glyf = concat(glyphs);
  const loca = new DataView(new ArrayBuffer((glyphs.length + 1) * 2));
  let off = 0;
  glyphs.forEach((g, i) => { loca.setUint16(i * 2, off / 2); off += g.length; });
  loca.setUint16(glyphs.length * 2, off / 2);
  const head = new DataView(new ArrayBuffer(54));
  head.setUint32(0, 0x00010000); head.setUint32(12, 0x5F0F3CF5); head.setUint16(18, 2048);
  head.setInt16(36, -100); head.setInt16(38, -200); head.setInt16(40, 1900); head.setInt16(42, 1800);
  head.setInt16(50, 0);
  const hhea = new DataView(new ArrayBuffer(36));
  hhea.setUint32(0, 0x00010000); hhea.setInt16(4, 1600); hhea.setInt16(6, -400); hhea.setUint16(34, 3);
  const maxp = new DataView(new ArrayBuffer(6));
  maxp.setUint32(0, 0x00005000); maxp.setUint16(4, glyphs.length);
  const hmtx = new DataView(new ArrayBuffer(3 * 4 + 2 * 2));
  [[500, 10], [1000, 20], [1200, 30]].forEach(([adv, lsb], i) => { hmtx.setUint16(i * 4, adv); hmtx.setInt16(i * 4 + 2, lsb); });
  hmtx.setInt16(12, 40); hmtx.setInt16(14, 50);
  const tables = [
    ["cmap", cmapFormat4([[0x41, 1], [0x42, 2], [0xC5, 3], [0x416, 4]])],
    ["glyf", glyf], ["head", new Uint8Array(head.buffer)], ["hhea", new Uint8Array(hhea.buffer)],
    ["hmtx", new Uint8Array(hmtx.buffer)], ["loca", new Uint8Array(loca.buffer)], ["maxp", new Uint8Array(maxp.buffer)]
  ];
  const dir = new DataView(new ArrayBuffer(12 + tables.length * 16));
  dir.setUint32(0, 0x00010000); dir.setUint16(4, tables.length);
  let at = dir.byteLength;
  const body = [];
  tables.forEach(([tag, data], i) => {
    for (let k = 0; k < 4; k++) dir.setUint8(12 + i * 16 + k, tag.charCodeAt(k));
    dir.setUint32(12 + i * 16 + 8, at); dir.setUint32(12 + i * 16 + 12, data.length);
    const padded = new Uint8Array((data.length + 3) & ~3);
    padded.set(data);
    body.push(padded);
    at += padded.length;
  });
  return { bytes: concat([new Uint8Array(dir.buffer)].concat(body)), glyphs };
}

function tableOf(bytes, tag) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < dv.getUint16(4); i++) {
    const rec = 12 + i * 16;
    if (String.fromCharCode(...bytes.subarray(rec, rec + 4)) === tag) {
      return { offset: dv.getUint32(rec + 8), length: dv.getUint32(rec + 12), sum: dv.getUint32(rec + 4) };
    }
  }
  return null;
}

function sum32(bytes) {
  let s = 0;
  for (let i = 0; i < bytes.length; i += 4) s = (s + (((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0)) >>> 0;
  return s;
}

const padTo4 = (g) => Array.from(g).concat(new Array(((g.length + 3) & ~3) - g.length).fill(0));

function glyphBytes(bytes, gid) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = tableOf(bytes, "head"), loca = tableOf(bytes, "loca"), glyf = tableOf(bytes, "glyf");
  const long = dv.getInt16(head.offset + 50) === 1;
  const start = long ? dv.getUint32(loca.offset + gid * 4) : dv.getUint16(loca.offset + gid * 2) * 2;
  const end = long ? dv.getUint32(loca.offset + gid * 4 + 4) : dv.getUint16(loca.offset + gid * 2 + 2) * 2;
  return Array.from(bytes.subarray(glyf.offset + start, glyf.offset + end));
}

test("the parser reads a format 4 cmap, metrics and the short loca", () => {
  const font = parseTrueType(tinyFont().bytes);
  assert.equal(font.unitsPerEm, 2048);
  assert.equal(font.numGlyphs, 5);
  assert.deepEqual(font.bbox, [-100, -200, 1900, 1800]);
  assert.equal(font.ascent, 1600);
  assert.equal(font.capHeight, 1600, "no OS/2 table: cap height falls back to the ascent");
  assert.deepEqual([0x41, 0x42, 0xC5, 0x416, 0x43].map(font.glyphFor), [1, 2, 3, 4, 0]);
  assert.deepEqual([0, 1, 2, 3, 4].map(font.advance), [500, 1000, 1200, 1200, 1200]);
});

test("the closure of a composite glyph holds its components and .notdef", () => {
  const font = parseTrueType(tinyFont().bytes);
  assert.deepEqual(Array.from(glyphClosure(font, [3])).sort(), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(glyphClosure(font, [4])).sort(), [0, 4]);
  assert.deepEqual(Array.from(glyphClosure(font, [99])).sort(), [0], "ids past the font are dropped");
});

test("a subset keeps glyph ids, keeps used outlines and empties the rest", () => {
  const { bytes, glyphs } = tinyFont();
  const out = subsetTrueType(parseTrueType(bytes), [3]);
  const sub = parseTrueType(out);
  assert.equal(sub.numGlyphs, 4, "cut after the highest glyph used");
  for (const gid of [0, 1, 2, 3]) assert.deepEqual(glyphBytes(out, gid), padTo4(glyphs[gid]), "glyph " + gid);
  assert.deepEqual([0, 1, 2, 3].map(sub.advance), [500, 1000, 1200, 1200]);
  const only = subsetTrueType(parseTrueType(bytes), [2]);
  assert.deepEqual(glyphBytes(only, 1), [], "glyph 1 is not used");
  assert.deepEqual(glyphBytes(only, 2), padTo4(glyphs[2]));
});

test("a subset is a well-formed font file: sorted tables, checksums, no cmap", () => {
  const out = subsetTrueType(parseTrueType(tinyFont().bytes), [1, 4]);
  const dv = new DataView(out.buffer);
  const tags = [];
  for (let i = 0; i < dv.getUint16(4); i++) tags.push(String.fromCharCode(...out.subarray(12 + i * 16, 16 + i * 16)));
  assert.deepEqual(tags, ["glyf", "head", "hhea", "hmtx", "loca", "maxp"]);
  for (const tag of tags) {
    const t = tableOf(out, tag);
    const data = new Uint8Array((t.length + 3) & ~3);
    data.set(out.subarray(t.offset, t.offset + t.length));
    if (tag === "head") data.fill(0, 8, 12);
    assert.equal(sum32(data), t.sum, tag + " checksum");
  }
  assert.equal(sum32(out), 0xB1B0AFBA, "whole-file checksum adjustment");
});
