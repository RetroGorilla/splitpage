import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Bytes, sha256Hex } from "../js/02b-doc-id.js";
import { sha256Bytes as coreSha256Bytes, sha256Hex as coreSha256Hex, utf8Bytes } from "../core/document/ids.ts";

const oracle = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s; };
}

function randomUnits(next, length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    const pick = next() % 10;
    if (pick < 3) out += String.fromCharCode(0x20 + (next() % 0x5f));
    else if (pick < 5) out += String.fromCharCode(0xd800 + (next() % 0x800));
    else if (pick < 7) out += String.fromCodePoint(0x10000 + (next() % 0x100000));
    else if (pick < 8) out += String.fromCharCode(next() % 0x80);
    else out += String.fromCharCode(next() % 0x10000);
  }
  return out;
}

function sized(unit, bytes) {
  const per = Buffer.byteLength(unit, "utf8");
  return unit.repeat(Math.floor(bytes / per)) + "x".repeat(bytes % per);
}

const NAMED = [
  ["empty", ""],
  ["ascii", "abc"],
  ["latin and cjk", "héllo → 日本"],
  ["astral", "😀𝒳𝄞"],
  ["emoji sequence", "👩‍👩‍👧 🏳️‍🌈 👍🏽"],
  ["lone high surrogate", "\ud800"],
  ["lone low surrogate", "\udc00"],
  ["high surrogate at the end", "abc\ud83d"],
  ["low surrogate at the start", "\ude00abc"],
  ["reversed pair", "\ude00\ud83d"],
  ["two highs then a low", "\ud83d😀"],
  ["high, ascii, low", "\ud83dx\ude00"],
  ["highest pair", "􏿿"],
  ["lowest pair", "𐀀"],
  ["nul and controls", "\u0000\u0001\u001f\u007f"],
  ["one-byte edge", "\u007f\u0080"],
  ["two-byte edge", "߿ࠀ"],
  ["three-byte edge", "퟿￿"],
  ["bom, replacement character, object replacement, nbsp, zwsp", "﻿�￼ ​"],
  ["crlf", "a\r\nb\rc\nd"],
  ["the frozen doc-id seed shape", "splitpage-file\n{\"title\":\"T\",\"rows\":[]}"],
  ["one MiB of ascii", "x".repeat(1 << 20)],
  ["one MiB of three-byte characters", sized("日", 1 << 20)],
  ["one MiB of astral characters", sized("😀", 1 << 20)],
  ["one MiB of mixed text with lone surrogates", sized("aé日😀𐀀\udfff", 1 << 20)]
];

const BOUNDARIES = [];
for (const unit of ["é", "日", "😀", "\ud800"]) {
  for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120, 128]) BOUNDARIES.push([`${JSON.stringify(unit)} padded to ${n} bytes`, sized(unit, n)]);
}

const FUZZ = [];
{
  const next = lcg(2026);
  for (let i = 0; i < 400; i++) FUZZ.push([`fuzz ${i}`, randomUnits(next, next() % 300)]);
}

const ALL = [...NAMED, ...BOUNDARIES, ...FUZZ];

function withoutTextEncoder(fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
  Object.defineProperty(globalThis, "TextEncoder", { value: undefined, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(globalThis, "TextEncoder", had);
  }
}

test("the oracle: Buffer's UTF-8 is TextEncoder's, lone surrogates becoming U+FFFD", () => {
  for (const [name, s] of ALL) {
    assert.deepEqual(new Uint8Array(Buffer.from(s, "utf8")), new TextEncoder().encode(s), name);
  }
  assert.deepEqual([...Buffer.from("\ud800x\udc00", "utf8")], [0xef, 0xbf, 0xbd, 0x78, 0xef, 0xbf, 0xbd]);
});

test("sha256Hex over TextEncoder's bytes equals node:crypto", () => {
  for (const [name, s] of ALL) assert.equal(sha256Hex(s), oracle(s), name);
});

test("sha256Hex without TextEncoder, over the hand-written UTF-8 encoder, equals node:crypto", () => {
  const got = withoutTextEncoder(() => {
    assert.equal(typeof TextEncoder, "undefined");
    return ALL.map(([name, s]) => [name, sha256Hex(s)]);
  });
  assert.equal(typeof TextEncoder, "function");
  for (const [name, hex] of got) assert.equal(hex, oracle(ALL.find(([n]) => n === name)[1]), name);
});

test("sha256Hex coerces its argument with String()", () => {
  for (const v of [42, null, undefined, true, { toString: () => "obj" }]) assert.equal(sha256Hex(v), oracle(String(v)), String(v));
});

test("sha256Bytes over raw bytes equals node:crypto, a megabyte included", () => {
  const next = lcg(82);
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, (1 << 20) + 3]) {
    const bytes = new Uint8Array(n).map(() => next() & 255);
    assert.equal(sha256Bytes(bytes), createHash("sha256").update(bytes).digest("hex"), "length " + n);
  }
});

test("core's UTF-8 encoder writes exactly TextEncoder's bytes into a Uint8Array", () => {
  for (const [name, s] of ALL) {
    const bytes = utf8Bytes(s);
    assert.ok(bytes instanceof Uint8Array, name);
    assert.deepEqual(bytes, new TextEncoder().encode(s), name);
  }
});

test("core's sha256Hex equals node:crypto, with TextEncoder present and removed", () => {
  for (const [name, s] of ALL) assert.equal(coreSha256Hex(s), oracle(s), name);
  const got = withoutTextEncoder(() => ALL.map(([name, s]) => [name, coreSha256Hex(s)]));
  for (const [name, hex] of got) assert.equal(hex, oracle(ALL.find(([n]) => n === name)[1]), name);
});

test("core's sha256Bytes over raw bytes equals node:crypto", () => {
  const next = lcg(2101);
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, (1 << 20) + 3]) {
    const bytes = new Uint8Array(n).map(() => next() & 255);
    assert.equal(coreSha256Bytes(bytes), createHash("sha256").update(bytes).digest("hex"), "length " + n);
  }
});

test("02b-doc-id.js hands out core's functions, so the app hashes through the manual encoder", () => {
  assert.equal(sha256Hex, coreSha256Hex);
  assert.equal(sha256Bytes, coreSha256Bytes);
});
