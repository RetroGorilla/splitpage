import { normalizeImageRef } from "../../shared/blob-policy.js";
import { normalizeDocId } from "../../shared/doc-id-policy.js";
import { BROLL_STATUS_IDS } from "../../src/core/document/broll.ts";
import { SCHEMA_VERSION } from "../../src/core/document/fields.ts";
import { TAG_CATEGORY_IDS, TAG_STATUS_IDS } from "../../src/core/document/tags.ts";
import { ROW_STATUS_IDS } from "../../src/core/document/timing.ts";
import { pngDataUrl } from "../core/migrate-ports.ts";

export type Random = () => number;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Bag = Record<string, unknown>;

export function seeded(seed: number): Random {
  let a = (Math.imul(seed >>> 0, 0x9e3779b1) ^ 0x2545f491) >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(r: Random, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)] as T;
}

export function chance(r: Random, p: number): boolean {
  return r() < p;
}

export function upTo(r: Random, most: number): number {
  return Math.floor(r() * (most + 1));
}

export const CAPS: readonly number[] = [60, 80, 200];

const ch = String.fromCharCode;

const PNG = pngDataUrl(4, 4, 7);
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const WORDS = [
  "Wide", "close", "Mara", "mends", "nets", "harbour", "#kettle", "@Sam", "B-roll:", "VO:", ch(0xe9), ch(0xa0),
  ch(0xd83c, 0xdfac), ch(0xd83c), "**bold**", "*em*", "~~gone~~", "<u>u</u>", "[link](https://example.com)", ch(1), "\t", ""
];

const HTML = [
  "",
  "Every morning.",
  "  padded  ",
  "<b>bold</b> and <i>italic</i>",
  "line<br>break",
  "two\nlines",
  "<p>para</p><p>graph</p>",
  '<a href="https://example.com/x">link</a>',
  '<a href="javascript:alert(1)">bad</a>',
  "<script>alert(1)</script>after",
  '<img src="' + PNG + '">',
  '<img class="comment-img" data-blob="' + SHA_A + '">',
  '<a class="video-embed-card" href="https://youtu.be/abc">card</a>',
  '<span class="comment-anchor" data-comment-id="c1">said</span> it',
  '<span data-tag="prop:kettle" class="tag">kettle</span>',
  "Put the #kettle on",
  "<mark>marked</mark>",
  "&amp; &lt;tag&gt; &nbsp;",
  '<b><a href="https://a.example"><a href="https://b.example">nested</a></a></b>'
];

const STRINGS = [
  "", " ", "x", "__proto__", "constructor", "toString", "r1", "c1", "p1", "bs1", "todo", "ready", "shot", "bogus",
  "prop", "location", "needed", "unshot", "list", "script", "conflict", "anchor", "title", "visualText", "audioText",
  "visualImage", "2026-10-07T09:00:00.000Z", "d" + "a".repeat(32), "d" + "A".repeat(32), PNG,
  "data:image/svg+xml;base64,AAAA", "#80BDFB", "red", "Sam", "<b>Sam</b>"
];

const NUMBERS = [0, 1, -1, 1.5, 59, 60, 90, 150, 400, 401, 86400, 86401, 1e21, -0.5];

const ROW_IDS = ["r1", "r2", "r3", "r 4", "__proto__", "constructor", "", "r1"];
const COMMENT_IDS = ["c1", "c2", "c3", "__proto__", ""];
const PERSON_IDS = ["p1", "p2", "toString", ""];
const SHOT_IDS = ["bs1", "bs2", "constructor", ""];

function longText(r: Random): string {
  if (chance(r, 0.3)) return "n".repeat(pick(r, CAPS) - 1) + " " + pick(r, ["x", "yz", "  w"]);
  const target = pick(r, CAPS) + upTo(r, 30) - 10;
  let out = "";
  while (out.length <= target) out += (out ? " " : "") + pick(r, ["Wide", "close", "nets", "a", "harbour", "Mara"]);
  return out;
}

function phrase(r: Random): string {
  const n = 1 + upTo(r, 4);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(pick(r, WORDS));
  return words.join(chance(r, 0.8) ? " " : "");
}

export function text(r: Random): string {
  const roll = r();
  if (roll < 0.35) return pick(r, HTML);
  if (roll < 0.65) return phrase(r);
  if (roll < 0.8) return longText(r);
  return pick(r, STRINGS);
}

function junk(r: Random, depth: number): Json {
  const roll = r();
  if (roll < 0.3) return pick(r, STRINGS);
  if (roll < 0.45) return pick(r, NUMBERS);
  if (roll < 0.55) return chance(r, 0.5);
  if (roll < 0.65 || depth <= 0) return null;
  if (roll < 0.82) {
    const out: Json[] = [];
    for (let n = upTo(r, 3); n > 0; n--) out.push(junk(r, depth - 1));
    return out;
  }
  const out: { [key: string]: Json } = {};
  for (let n = upTo(r, 3); n > 0; n--) own(out, pick(r, STRINGS), junk(r, depth - 1));
  return out;
}

function own(into: { [key: string]: Json }, key: string, value: Json): void {
  Object.defineProperty(into, key, { value: value, enumerable: true, writable: true, configurable: true });
}

function or(r: Random, good: () => Json, p = 0.85): Json {
  return chance(r, p) ? good() : junk(r, 2);
}

function put(r: Random, into: { [key: string]: Json }, key: string, value: () => Json, p = 0.8): void {
  if (chance(r, p)) into[key] = or(r, value);
}

function list(r: Random, item: () => Json, most: number): Json {
  if (chance(r, 0.08)) return junk(r, 2);
  const out: Json[] = [];
  for (let n = upTo(r, most); n > 0; n--) out.push(chance(r, 0.9) ? item() : junk(r, 1));
  return out;
}

function imageRef(r: Random): Json {
  return {
    sha256: pick(r, [SHA_A, SHA_B, "not-a-sha"]),
    width: pick(r, [4, 10, 0, -1, 1.5]),
    height: pick(r, [4, 10, 3]),
    mime: pick(r, ["image/png", "image/jpeg", "text/html"])
  };
}

function videoLink(r: Random): Json {
  const link: { [key: string]: Json } = { href: pick(r, ["https://youtu.be/abc", "https://vimeo.com/1", "javascript:x", "ftp://x"]) };
  if (chance(r, 0.4)) link.poster = chance(r, 0.7);
  return link;
}

function galleryItem(r: Random): Json {
  const it: { [key: string]: Json } = {};
  put(r, it, "imageRef", () => imageRef(r), 0.6);
  put(r, it, "visualImage", () => PNG, 0.15);
  put(r, it, "name", () => text(r), 0.5);
  put(r, it, "links", () => list(r, () => videoLink(r), 2), 0.4);
  put(r, it, "annotation", () => ({ imageRef: imageRef(r), marks: list(r, () => junk(r, 1), 2) }), 0.2);
  return it;
}

function row(r: Random): Json {
  const out: { [key: string]: Json } = {};
  put(r, out, "id", () => pick(r, ROW_IDS), 0.9);
  put(r, out, "visualText", () => text(r));
  put(r, out, "audioText", () => text(r));
  put(r, out, "status", () => pick(r, ["todo", "ready", "shot", "bogus", ""]), 0.6);
  put(r, out, "lengthSeconds", () => pick(r, NUMBERS), 0.3);
  put(r, out, "imageRef", () => imageRef(r), 0.2);
  put(r, out, "visualImage", () => pick(r, [PNG, "data:image/svg+xml;base64,AAAA"]), 0.1);
  put(r, out, "imageName", () => text(r), 0.15);
  put(r, out, "imageLinks", () => list(r, () => videoLink(r), 2), 0.15);
  put(r, out, "moreImages", () => list(r, () => galleryItem(r), 3), 0.15);
  put(r, out, "updatedAt", () => pick(r, STRINGS), 0.4);
  put(r, out, "updatedBy", () => text(r), 0.4);
  if (chance(r, 0.1)) own(out, pick(r, STRINGS), junk(r, 2));
  return out;
}

function reply(r: Random): Json {
  const out: { [key: string]: Json } = {};
  put(r, out, "id", () => pick(r, COMMENT_IDS), 0.8);
  put(r, out, "body", () => text(r));
  put(r, out, "author", () => text(r), 0.6);
  put(r, out, "createdAt", () => pick(r, STRINGS), 0.4);
  return out;
}

function comment(r: Random): Json {
  const out: { [key: string]: Json } = {};
  put(r, out, "id", () => pick(r, COMMENT_IDS), 0.9);
  put(r, out, "rowId", () => pick(r, ROW_IDS), 0.8);
  put(r, out, "field", () => pick(r, ["audioText", "visualText", "visualImage", "title", "bogus"]), 0.7);
  put(r, out, "anchorId", () => pick(r, COMMENT_IDS), 0.3);
  put(r, out, "body", () => text(r));
  put(r, out, "quotedText", () => text(r), 0.3);
  put(r, out, "replies", () => list(r, () => reply(r), 2), 0.5);
  put(r, out, "resolved", () => chance(r, 0.5), 0.5);
  put(r, out, "resolvedBy", () => text(r), 0.3);
  put(r, out, "resolvedAt", () => pick(r, STRINGS), 0.3);
  put(r, out, "author", () => text(r), 0.5);
  put(r, out, "kind", () => pick(r, ["anchor", "conflict", "bogus"]), 0.4);
  put(r, out, "imageValue", () => imageRef(r), 0.1);
  put(r, out, "assignee", () => text(r), 0.2);
  put(r, out, "createdAt", () => pick(r, STRINGS), 0.3);
  return out;
}

function person(r: Random): Json {
  const out: { [key: string]: Json } = {};
  put(r, out, "id", () => pick(r, PERSON_IDS), 0.85);
  put(r, out, "name", () => text(r), 0.9);
  return out;
}

function tag(r: Random): Json {
  const out: { [key: string]: Json } = {};
  put(r, out, "cat", () => pick(r, ["prop", "location", "cast", "sound", "bogus"]), 0.85);
  put(r, out, "name", () => text(r), 0.9);
  put(r, out, "status", () => pick(r, ["needed", "have", "bogus"]), 0.5);
  put(r, out, "owner", () => pick(r, PERSON_IDS), 0.3);
  put(r, out, "notes", () => text(r), 0.3);
  put(r, out, "id", () => pick(r, ["t1", "t2", "__proto__"]), 0.3);
  return out;
}

function shot(r: Random): Json {
  const out: { [key: string]: Json } = {};
  put(r, out, "id", () => pick(r, SHOT_IDS), 0.85);
  put(r, out, "name", () => text(r), 0.9);
  put(r, out, "desc", () => text(r), 0.4);
  put(r, out, "status", () => pick(r, ["unshot", "shot", "bogus"]), 0.5);
  put(r, out, "reshoot", () => chance(r, 0.5), 0.3);
  put(r, out, "notes", () => text(r), 0.3);
  put(r, out, "audioRef", () => text(r), 0.3);
  put(r, out, "location", () => text(r), 0.3);
  put(r, out, "owner", () => pick(r, PERSON_IDS), 0.3);
  put(r, out, "origin", () => pick(r, ["list", "script", "bogus"]), 0.4);
  put(r, out, "props", () => list(r, () => (chance(r, 0.5) ? text(r) : { id: pick(r, ["t1", "x"]), name: text(r) }), 2), 0.4);
  return out;
}

function personColors(r: Random): Json {
  const out: { [key: string]: Json } = {};
  for (let n = upTo(r, 3); n > 0; n--) own(out, pick(r, ["Sam", "Ann", "__proto__", ""]), pick(r, ["#80BDFB", "red", "#000000", ""]));
  return out;
}

function documentOf(r: Random): { [key: string]: Json } {
  const doc: { [key: string]: Json } = {};
  put(r, doc, "title", () => text(r), 0.85);
  put(r, doc, "docId", () => pick(r, ["d" + "1".repeat(32), "d" + "2".repeat(32), "d" + "A".repeat(32), "doc-a"]), 0.7);
  put(r, doc, "schema", () => pick(r, [1, 2, 3, "2"]), 0.6);
  put(r, doc, "rows", () => list(r, () => row(r), 4), 0.92);
  put(r, doc, "comments", () => list(r, () => comment(r), 3), 0.6);
  put(r, doc, "people", () => list(r, () => person(r), 3), 0.5);
  put(r, doc, "productionTags", () => list(r, () => tag(r), 3), 0.5);
  put(r, doc, "brollShots", () => list(r, () => shot(r), 3), 0.4);
  put(r, doc, "wordsPerMinute", () => pick(r, NUMBERS), 0.3);
  put(r, doc, "rev", () => pick(r, NUMBERS), 0.4);
  put(r, doc, "lastEditedBy", () => text(r), 0.2);
  put(r, doc, "lastEditedAt", () => pick(r, STRINGS), 0.2);
  put(r, doc, "personColors", () => personColors(r), 0.2);
  put(r, doc, "targetSeconds", () => pick(r, NUMBERS), 0.2);
  if (chance(r, 0.1)) own(doc, pick(r, STRINGS), junk(r, 2));
  return doc;
}

export function rawDocument(r: Random): unknown {
  return JSON.parse(JSON.stringify(rawValue(r)));
}

function rawValue(r: Random): Json {
  if (chance(r, 0.04)) {
    return pick(r, [
      () => null,
      () => pick(r, NUMBERS),
      () => pick(r, STRINGS),
      () => true,
      () => [],
      () => [row(r), row(r)],
      () => [documentOf(r)]
    ])();
  }
  return documentOf(r);
}

export interface Spoiled {
  readonly label: string;
  readonly spoil: (doc: { [key: string]: Json }) => void;
  readonly bothSides: boolean;
}

export const TABLE_304: readonly Spoiled[] = [
  { label: "theirs.productionTags = {}", spoil: function (d) { d.productionTags = {}; }, bothSides: false },
  { label: "theirs.rows = {}", spoil: function (d) { d.rows = {}; }, bothSides: false },
  { label: 'theirs.people = "x"', spoil: function (d) { d.people = "x"; }, bothSides: false },
  { label: 'rows: ["x"] on unmigrated mine and theirs', spoil: function (d) { d.rows = ["x"]; }, bothSides: true },
  { label: 'comments: ["x"] on unmigrated mine and theirs', spoil: function (d) { d.comments = ["x"]; }, bothSides: true },
  { label: "rows: [null] on unmigrated mine and theirs", spoil: function (d) { d.rows = [null]; }, bothSides: true }
];

export function table304Document(title: string): { [key: string]: Json } {
  return {
    title: title,
    docId: "d" + "3".repeat(32),
    schema: SCHEMA_VERSION,
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Every morning.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Mara mends nets.", status: "ready" }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", body: "Tighter", replies: [] }],
    people: [{ id: "p1", name: "Sam" }],
    productionTags: [{ cat: "prop", name: "kettle" }],
    brollShots: [{ id: "bs1", name: "Nets drying" }]
  };
}

function isBag(v: unknown): v is Bag {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function oneOf(v: unknown, ids: readonly string[]): boolean {
  return typeof v === "string" && ids.indexOf(v) !== -1;
}

function items(doc: Bag, key: string, out: string[], check: (item: Bag, at: string) => void): void {
  const v = doc[key];
  if (!Array.isArray(v)) { out.push(key + " is not a list"); return; }
  v.forEach(function (item: unknown, i: number) {
    const at = key + "[" + i + "]";
    if (Array.isArray(item)) { out.push(at + ARRAY); return; }
    if (!isBag(item)) { out.push(at + " is not an object"); return; }
    check(item, at);
  });
}

const ARRAY = " is an array";

function need(out: string[], ok: boolean, what: string): void {
  if (!ok) out.push(what);
}

function safeId(v: unknown): boolean {
  return typeof v === "string" && SAFE_ID.test(v);
}

export function documentProblems(doc: unknown): string[] {
  if (!isBag(doc)) return [Array.isArray(doc) ? "the document" + ARRAY : "the document is not an object"];
  const out: string[] = [];
  need(out, typeof doc.title === "string", "title");
  need(out, typeof doc.docId === "string" && normalizeDocId(doc.docId) === doc.docId, "docId");
  need(out, typeof doc.rev === "number" && isFinite(doc.rev), "rev");
  need(out, doc.schema === SCHEMA_VERSION, "schema");
  need(out, typeof doc.wordsPerMinute === "number" && doc.wordsPerMinute >= 60 && doc.wordsPerMinute <= 400, "wordsPerMinute");
  items(doc, "rows", out, function (row, at) {
    need(out, safeId(row.id), at + ".id");
    need(out, oneOf(row.status, ROW_STATUS_IDS), at + ".status");
    need(out, typeof row.visualText === "string", at + ".visualText");
    need(out, typeof row.audioText === "string", at + ".audioText");
    need(out, row.imageRef === null || JSON.stringify(normalizeImageRef(row.imageRef)) === JSON.stringify(row.imageRef), at + ".imageRef");
    need(out, !("lengthSeconds" in row) || (typeof row.lengthSeconds === "number" && Number.isInteger(row.lengthSeconds) && row.lengthSeconds >= 0), at + ".lengthSeconds");
  });
  items(doc, "comments", out, function (c, at) {
    need(out, safeId(c.id), at + ".id");
    need(out, oneOf(c.kind, ["anchor", "conflict"]), at + ".kind");
    need(out, oneOf(c.field, ["audioText", "visualText", "visualImage", "title"]), at + ".field");
    need(out, c.field === "title" ? c.rowId === null : safeId(c.rowId), at + ".rowId");
    need(out, typeof c.body === "string", at + ".body");
    need(out, typeof c.resolved === "boolean", at + ".resolved");
    items(c, "replies", out, function (rep, repAt) {
      need(out, safeId(rep.id), at + "." + repAt + ".id");
      need(out, typeof rep.body === "string", at + "." + repAt + ".body");
    });
  });
  items(doc, "people", out, function (p, at) {
    need(out, safeId(p.id), at + ".id");
    need(out, typeof p.name === "string" && p.name.length > 0, at + ".name");
  });
  items(doc, "productionTags", out, function (t, at) {
    need(out, oneOf(t.cat, TAG_CATEGORY_IDS), at + ".cat");
    need(out, oneOf(t.status, TAG_STATUS_IDS), at + ".status");
    need(out, typeof t.name === "string" && t.name.length > 0, at + ".name");
    need(out, typeof t.id === "string" && t.id.length > 0, at + ".id");
  });
  items(doc, "brollShots", out, function (b, at) {
    need(out, safeId(b.id), at + ".id");
    need(out, typeof b.name === "string" && b.name.length > 0, at + ".name");
    need(out, oneOf(b.status, BROLL_STATUS_IDS), at + ".status");
    need(out, Array.isArray(b.props), at + ".props");
  });
  return out;
}

export type FixedPoint =
  | { readonly kind: "fixed" }
  | { readonly kind: "trimmed at a cap"; readonly paths: readonly string[] }
  | { readonly kind: "changed"; readonly paths: readonly string[] };

function compare(a: unknown, b: unknown, at: string, changed: string[], trimmed: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (typeof a === "string" && typeof b === "string") {
    if (b === a.trimEnd() && CAPS.indexOf(a.length) !== -1) trimmed.push(at);
    else changed.push(at + " " + JSON.stringify(a).slice(0, 120) + " became " + JSON.stringify(b).slice(0, 120));
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach(function (x: unknown, i: number) { compare(x, b[i], at + "[" + i + "]", changed, trimmed); });
    return;
  }
  if (isBag(a) && isBag(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (JSON.stringify(ka) !== JSON.stringify(kb)) { changed.push(at + " keys " + JSON.stringify(ka) + " became " + JSON.stringify(kb)); return; }
    ka.forEach(function (k) { compare(a[k], b[k], at + "." + k, changed, trimmed); });
    return;
  }
  changed.push(at);
}

export function fixedPointOf(doc: unknown, migrate: (raw: unknown) => unknown): FixedPoint {
  const text = JSON.stringify(doc);
  const again: unknown = JSON.parse(JSON.stringify(migrate(JSON.parse(text))));
  const once: unknown = JSON.parse(text);
  const changed: string[] = [], trimmed: string[] = [];
  compare(once, again, "", changed, trimmed);
  if (changed.length) return { kind: "changed", paths: changed };
  if (trimmed.length) return { kind: "trimmed at a cap", paths: trimmed };
  return { kind: "fixed" };
}

export const KNOWN_TRIM_AT_CAP = "migrateRows cuts a name at its cap after trimming it, so a space can end it";
export const KNOWN_ARRAY_AS_OBJECT = "migrateRows takes an array for an object: as the document, or as a scene, comment, reply, person, tag or shot";

export const KNOWN_PRIMITIVE_THROW = "migrateRows throws a TypeError on an object whose toString or valueOf is not a function";

export const KNOWN_REPLY_TIME_THROW = "mergeStates throws a TypeError sorting the replies of a comment both sides hold when a reply's createdAt is not a string, which migrateRows keeps";

export function knownThrow(error: unknown): string | null {
  if (!(error instanceof TypeError)) return null;
  if (error.message === "Cannot convert object to primitive value") return KNOWN_PRIMITIVE_THROW;
  if (error.message === '(x.createdAt || "").localeCompare is not a function') return KNOWN_REPLY_TIME_THROW;
  return null;
}

export interface Verdict {
  readonly problems: readonly string[];
  readonly known: readonly string[];
}

export function judge(doc: unknown, migrate: (raw: unknown) => unknown, allowed: (path: string) => string | null = function () { return null; }): Verdict {
  const known: string[] = [];
  const all = documentProblems(doc);
  let problems = all.filter(function (p) { return !p.endsWith(ARRAY); });
  if (problems.length < all.length) known.push(KNOWN_ARRAY_AS_OBJECT);
  const fixed = fixedPointOf(doc, migrate);
  if (fixed.kind === "changed") {
    const unexplained = fixed.paths.filter(function (p) {
      const why = allowed(p);
      if (why && known.indexOf(why) === -1) known.push(why);
      return !why;
    });
    if (unexplained.length) problems = problems.concat(["not a migrateRows fixed point: " + unexplained.slice(0, 6).join(", ")]);
  }
  if (fixed.kind === "trimmed at a cap") known.push(KNOWN_TRIM_AT_CAP);
  return { problems: problems, known: known };
}
