import { normalizeBrollProps } from "../core/document/broll.ts";
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../js/02-state.js";
import { withPageHead } from "../js/02b-doc-id.js";
import { plainName, plainText, safeHref, safeId, safeImageSrc, sanitizeHtml } from "../js/04-richtext.js";
import { directionShortcut, importDirections } from "../js/04c-doc-model.js";
import { normalizePersonColors } from "../core/document/person-colors.ts";
import { normalizeSceneLength, normalizeTargetLength } from "../core/document/timing.ts";
import { migrateGallery, normalizeMarks, normalizePictureName, normalizeVideoLink, normalizeVideoLinks } from "../adapters/storage/02d-gallery.js";
import { assertGolden, goldenNames, mintedId, updatingGoldens } from "./golden-helpers.mjs";

const SUMMARY_OVER = 24;

function runsOf(s) {
  const out = [];
  for (const ch of s.split("")) {
    const last = out[out.length - 1];
    if (last && last[0] === ch) last[1]++;
    else out.push([ch, 1]);
  }
  return out;
}

function repr(v) {
  if (v === undefined) return "<undefined>";
  if (typeof v === "number" && !Number.isFinite(v)) return "<" + String(v) + ">";
  if (Object.is(v, -0)) return "<-0>";
  if (typeof v === "function") return "<function>";
  if (typeof v === "string") {
    const runs = v.length > 64 ? runsOf(v) : null;
    return runs && runs.length <= 16 ? { length: v.length, runs } : v;
  }
  if (Array.isArray(v)) {
    if (v.length > SUMMARY_OVER) return { items: v.length, first: repr(v[0]), last: repr(v[v.length - 1]) };
    return v.map(repr);
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length > SUMMARY_OVER) {
      const lastKey = keys[keys.length - 1];
      return { keys: keys.length, first: [keys[0], repr(v[keys[0]])], last: [lastKey, repr(v[lastKey])] };
    }
    return Object.fromEntries(keys.map((k) => [k, repr(v[k])]));
  }
  return v;
}

function table(rows, fn) {
  return rows.map(([label, input]) => {
    let output;
    try {
      output = repr(fn(input));
    } catch (e) {
      output = { threw: String(e && e.name) };
    }
    return { case: label, input: repr(input), output };
  });
}

const x = (n, ch = "x") => ch.repeat(n);
const doc = (over) => migrateRows(Object.assign({ schema: 2, title: "T", rows: [] }, over));
const ownProto = (value) => JSON.parse('{"__proto__":' + JSON.stringify(value) + "}");
const BLUE = "#80BDFB";
const UNKNOWN = "a1".repeat(32);

const TABLES = {};

TABLES["people-name"] = () => table([
  ["59 characters", x(59)],
  ["60 characters, the limit", x(60)],
  ["61 characters", x(61)],
  ["60 characters inside spaces: trimmed before the cut", " " + x(60) + " "],
  ["61 characters, the last two a space and a letter", x(59) + " y"],
  ["markup is stripped before the cut", "<b>" + x(60) + "</b>"],
  ["an astral character across the cut", x(59) + "😀"],
  ["controls are stripped, tab and newline kept", "a\u0001b\tc\nd"],
  ["spaces only: dropped", "   "],
  ["markup only: dropped", "<b></b>"],
  ["a number", 42],
  ["null: dropped", null],
  ["missing: dropped", undefined]
], (name) => {
  const s = doc({ people: [{ id: "p1", name }] });
  return s.people.length ? s.people[0].name : null;
});

TABLES["migrate-fields"] = () => {
  const rows = [];
  const add = (field, cases, fn) => table(cases, fn).forEach((r) => rows.push(Object.assign({ field }, r)));
  const tag = (t) => doc({ productionTags: [Object.assign({ cat: "prop", name: "Kettle" }, t)] }).productionTags[0];
  const shot = (b) => doc({ brollShots: [Object.assign({ id: "b1", name: "Shot" }, b)] }).brollShots[0];
  const comment = (c) => doc({ comments: [Object.assign({ id: "c1", rowId: "r1" }, c)] }).comments[0];
  add("title", [["299", x(299)], ["300, the limit", x(300)], ["301", x(301)], ["not trimmed", "  T  "],
    ["markup stripped first", "<b>" + x(300) + "</b>"], ["a number", 42], ["null", null]], (title) => doc({ title }).title);
  add("productionTags name", [["79", x(79)], ["80, the limit", x(80)], ["81", x(81)], ["80 inside spaces", " " + x(80) + " "],
    ["spaces only: the tag is dropped", "   "]], (name) => { const t = tag({ name }); return t ? t.name : null; });
  add("productionTags notes", [["1999", x(1999)], ["2000, the limit", x(2000)], ["2001", x(2001)], ["not trimmed", "  n  "]],
    (notes) => tag({ notes }).notes);
  add("brollShots name", [["199", x(199)], ["200, the limit", x(200)], ["201", x(201)], ["200 inside spaces", " " + x(200) + " "],
    ["spaces only: the shot is dropped", "   "]], (name) => { const b = shot({ name }); return b ? b.name : null; });
  for (const key of ["desc", "notes", "audioRef"]) {
    add("brollShots " + key, [["1999", x(1999)], ["2000, the limit", x(2000)], ["2001", x(2001)], ["not trimmed", "  d  "]],
      (v) => shot({ [key]: v })[key]);
  }
  add("brollShots location", [["79", x(79)], ["80, the limit", x(80)], ["81", x(81)], ["80 inside spaces", " " + x(80) + " "]],
    (location) => shot({ location }).location);
  add("comment resolvedBy", [["79", x(79)], ["80, the limit", x(80)], ["81", x(81)], ["spaces only", "   "]],
    (resolvedBy) => { const c = comment({ resolved: true, resolvedBy, resolvedAt: "2026-01-01" }); return [c.resolvedBy, c.resolvedAt]; });
  add("comment assignee", [["79", x(79)], ["80, the limit", x(80)], ["81", x(81)], ["80 inside spaces", " " + x(80) + " "], ["null", null]],
    (assignee) => comment({ assignee }).assignee);
  add("comment author", [["80, the limit", x(80)], ["81", x(81)], ["spaces only", "   "]], (author) => comment({ author }).author);
  add("comment quotedText", [["no limit", x(5000)], ["markup and controls", "<i>q</i>\u0001"]], (quotedText) => comment({ quotedText }).quotedText);
  add("row updatedBy", [["empty", ""], ["spaces only", "   "], ["markup only", "<b></b>"], ["81", x(81)], ["null", null]],
    (updatedBy) => doc({ rows: [{ id: "r1", updatedBy }] }).rows[0].updatedBy);
  add("wordsPerMinute", [["59", 59], ["59.5", 59.5], ["60", 60], ["60.4", 60.4], ["399.6", 399.6], ["400", 400], ["400.4", 400.4],
    ["400.5", 400.5], ["401", 401], ["a numeric string", "175"], ["an exponent string", "1e2"], ["empty string", ""], ["null", null],
    ["missing", undefined], ["true", true], ["NaN", NaN], ["Infinity", Infinity]], (wordsPerMinute) => doc({ wordsPerMinute }).wordsPerMinute);
  add("rev", [["0", 0], ["a numeric string", "3"], ["NaN", NaN], ["-1", -1], ["1.5", 1.5], ["missing", undefined]], (rev) => doc({ rev }).rev);
  return rows;
};

const C0_AND_DEL = [];
for (let c = 0; c <= 0x1f; c++) C0_AND_DEL.push(c);
C0_AND_DEL.push(0x7f);
const hex = (c) => "U+" + c.toString(16).toUpperCase().padStart(4, "0");

TABLES["plain-text"] = () => table([
  ...C0_AND_DEL.map((c) => [hex(c), "a" + String.fromCharCode(c) + "b"]),
  ...[0x85, 0xa0, 0x200b, 0x200c, 0x200d, 0x2028, 0x2029, 0x2060, 0xfeff, 0xfffc].map((c) => [hex(c) + " is kept", "a" + String.fromCharCode(c) + "b"]),
  ["a tag", "<b>x</b>"],
  ["a lone <", "a<b"],
  ["< and > around text", "a < b > c"],
  ["empty brackets", "<>x"],
  ["doubled brackets", "<<b>>x"],
  ["a lone >", "a>b"],
  ["a comment", "<!-- c -->x"],
  ["a script's text is kept", "<script>alert(1)</script>"],
  ["a tag across a newline", "<a\nhref='x'>y</a>"],
  ["entities are left alone", "&lt;b&gt; &amp;"],
  ["controls inside a tag", "\u0000<b>\u0001</b>"],
  ["null", null],
  ["undefined", undefined],
  ["0", 0],
  ["false", false],
  ["NaN", NaN],
  ["an array", [1, "<b>2</b>"]],
  ["an object", { a: 1 }]
], plainText);

TABLES["plain-name"] = () => table([
  ["79 characters", x(79)],
  ["80 characters, the limit", x(80)],
  ["81 characters", x(81)],
  ["80 inside spaces: trimmed before the cut", " " + x(80) + " "],
  ["an astral character across the cut", x(79) + "😀"],
  ["markup stripped first", "<b>" + x(81) + "</b>"],
  ["empty", ""],
  ["spaces only", "   "],
  ["markup only", "<b></b>"],
  ["controls only", "\u0001\u0002"],
  ["0", 0],
  ["false", false],
  ["null", null],
  ["undefined", undefined],
  ["the fallback itself", "Anonymous"]
], plainName);

TABLES["safe-id"] = () => {
  const started = Date.now();
  const rows = table([
    ["letters and digits", ["c1", "c"]],
    ["hyphen and underscore are kept", ["c-1_x", "c"]],
    ["a dot, a space, a quote and a slash go", ["c.1 \"2/3", "c"]],
    ["non-ASCII letters go", ["é1😀", "c"]],
    ["a control character goes", ["\u0000c1", "c"]],
    ["no length limit", [x(300, "a"), "c"]],
    ["__proto__ survives", ["__proto__", "c"]],
    ["constructor survives", ["constructor", "c"]],
    ["a lone hyphen survives", ["-", "c"]],
    ["the number 0", [0, "c"]],
    ["false", [false, "c"]],
    ["empty: minted with the prefix", ["", "c"]],
    ["only dropped characters: minted", ["!!!", "bs"]],
    ["null: minted", [null, "rp"]],
    ["undefined: minted", [undefined, "p"]],
    ["no prefix: minted with r", ["", undefined]]
  ], ([id, prefix]) => safeId(id, prefix));
  const ended = Date.now();
  for (const r of rows) {
    const prefix = r.input[1] === "<undefined>" ? "r" : r.input[1];
    if (mintedId(r.output, prefix, started, ended)) r.output = "{minted:" + prefix + "}";
  }
  return rows;
};

TABLES["safe-href"] = () => table([
  ["https", "https://e.x/a?b=1"],
  ["http", "http://e.x/"],
  ["upper-case scheme", "HTTPS://E.X/"],
  ["the scheme alone", "https://"],
  ["one slash", "http:/e.x"],
  ["no slashes", "https:e.x"],
  ["spaces around are trimmed", "  https://e.x/  "],
  ["a tab and a newline around are trimmed", "\t\nhttps://e.x/\n"],
  ["NBSP around is trimmed", " https://e.x/"],
  ["a zero-width space before is not", "​https://e.x/"],
  ["mailto", "mailto:a@e.x"],
  ["mailto after spaces", "  mailto:a@e.x"],
  ["MAILTO in capitals", "MAILTO:a@e.x"],
  ["javascript", "javascript:alert(1)"],
  ["JavaScript with a NUL inside", "java\u0000script:alert(1)"],
  ["javascript after spaces", "  javascript:alert(1)"],
  ["vbscript", "vbscript:x"],
  ["data", "data:text/html,x"],
  ["DATA in capitals after a space", " DATA:x"],
  ["ftp", "ftp://e.x/"],
  ["protocol-relative", "//e.x/"],
  ["a path", "/x"],
  ["a fragment", "#x"],
  ["empty", ""],
  ["null", null],
  ["undefined", undefined],
  ["a number", 5],
  ["an object", { toString: () => "https://e.x/" }]
], safeHref);

TABLES["safe-image-src"] = () => table([
  ["png", "data:image/png;base64,AAAA"],
  ["jpeg", "data:image/jpeg;base64,AAAA"],
  ["jpg", "data:image/jpg;base64,AAAA"],
  ["gif", "data:image/gif;base64,AAAA"],
  ["webp", "data:image/webp;base64,AAAA"],
  ["svg+xml", "data:image/svg+xml;base64,AAAA"],
  ["bmp", "data:image/bmp;base64,AAAA"],
  ["an upper-case type", "data:image/PNG;base64,AAAA"],
  ["an upper-case scheme", "DATA:image/png;base64,AAAA"],
  ["a space before", " data:image/png;base64,AAAA"],
  ["a newline after", "data:image/png;base64,AAAA\n"],
  ["a space inside the payload", "data:image/png;base64,AA AA"],
  ["NBSP inside the payload", "data:image/png;base64,AA AA"],
  ["padding anywhere", "data:image/png;base64,A=A="],
  ["base64url characters", "data:image/png;base64,AA-_"],
  ["a percent escape", "data:image/png;base64,AAAA%3D"],
  ["an empty payload", "data:image/png;base64,"],
  ["not base64", "data:image/png,AAAA"],
  ["a parameter before base64", "data:image/png;charset=utf-8;base64,AAAA"],
  ["a remote URL", "https://e.x/a.png"],
  ["null", null],
  ["undefined", undefined],
  ["a number", 5],
  ["an object that prints as a data URL", { toString: () => "data:image/png;base64,AAAA" }]
], safeImageSrc);

TABLES["image-dim-attr"] = () => {
  const sized = (w, h, mime) => {
    const attr = (k, v) => (v === undefined ? "" : " " + k + '="' + v + '"');
    const html = sanitizeHtml('<img data-blob="' + UNKNOWN + '"' + attr("data-w", w) + attr("data-h", h) + attr("data-mime", mime) + ">");
    const img = new DOMParser().parseFromString(html, "text/html").querySelector("img");
    if (!img) return null;
    return Object.fromEntries([...img.attributes].filter((a) => a.name !== "class" && a.name !== "data-blob").map((a) => [a.name, a.value]));
  };
  const widths = ["1", "9", "10", "999999", "1000000", "1048575", "1048576", "1048577", "9999999", "10000000", "0", "01", "-1", "+1",
    "1.0", "1e3", " 1", "1 ", "", "abc", "٣"];
  return [
    ...table(widths.map((w) => ["width " + JSON.stringify(w), w]), (w) => sized(w, "2", "image/png")),
    ...table([["height 1048576", "1048576"], ["height 1048577", "1048577"], ["height 0", "0"], ["no height", undefined]],
      (h) => sized("2", h, "image/png")),
    ...table(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "IMAGE/PNG", "image/jpg", undefined]
      .map((m) => ["mime " + String(m), m]), (m) => sized("2", "3", m))
  ];
};

TABLES["direction-max"] = () => {
  const run = (text, marks) => ({ text, marks: marks || {} });
  const at = ([cell, pos]) => directionShortcut(cell, pos === undefined ? cell.reduce((n, r) => n + (r.atom ? 1 : r.text.length), 0) : pos);
  const typed = (text) => [[run(text)]];
  return [
    ...table([
      ["199 characters inside", typed("((" + x(199, "a") + "))")],
      ["200 characters inside, the limit", typed("((" + x(200, "a") + "))")],
      ["201 characters inside", typed("((" + x(201, "a") + "))")],
      ["one character", typed("((a))")],
      ["shorter than five", typed("(())")],
      ["spaces only inside", typed("((   ))")],
      ["spaces around the words", typed("((  a b  ))")],
      ["text before and after", [[run("say ((beat)) now")], 12]],
      ["not right after the closing brackets", [[run("say ((beat)) now")], 13]],
      ["no opening brackets", typed("say beat))")],
      ["a bracket inside", typed("((a(b))")],
      ["a newline inside", typed("((a\nb))")],
      ["three opening brackets", typed("(((a))")],
      ["already a direction inside", [[run("(("), run("a", { dir: true }), run("))")]]],
      ["a b-roll key inside", [[run("((a "), { atom: "broll", id: "k1", text: "B-roll:", marks: {} }, run(" b))")]]],
      ["a tag on the inner words", [[run("(("), run("mug", { tag: "t:prop:Mug" }), run("))")]]],
      ["a tag on a bracket", [[run("((", { tag: "t:prop:Mug" }), run("mug))")]]],
      ["the last of two", typed("((a)) ((b))")]
    ], at),
    ...table([
      ["200 characters, typed as text", [run("((" + x(200, "a") + "))")]],
      ["201 characters, typed as text", [run("((" + x(201, "a") + "))")]],
      ["two in one cell", [run("x ((a)) y ((b))")]],
      ["brackets already marked as a direction", [run("say "), run("(beat)", { dir: true }), run(" now")]],
      ["two brackets marked as a direction", [run("()", { dir: true })]],
      ["nested brackets", [run("(((a)))")]]
    ], importDirections)
  ];
};

TABLES["person-colors"] = () => {
  const many = (n, lead) => {
    const out = lead === "__proto__" ? ownProto(BLUE) : {};
    if (lead === "prototype") out.prototype = BLUE;
    for (let i = 0; i < n; i++) out["p" + String(i).padStart(3, "0")] = BLUE;
    return out;
  };
  return table([
    ["null", null],
    ["a string", "Sam"],
    ["an array", [["Sam", BLUE]]],
    ["empty", {}],
    ["one name", { Sam: "#80bdfb" }],
    ["a colour with spaces, in lower case", { Sam: "  #80bdfb " }],
    ["a colour outside the palette", { Sam: "#000000" }],
    ["a colour that is not a string", { Sam: 5 }],
    ["controls and DEL are stripped from a name", { "\u0000Sam\u001f\u007f": BLUE }],
    ["C1 controls are not", { "Sam\u0085": BLUE }],
    ["a name of controls only", { "\u0001\u0002": BLUE }],
    ["79 characters", { [x(79)]: BLUE }],
    ["80 characters, the limit", { [x(80)]: BLUE }],
    ["81 characters", { [x(81)]: BLUE }],
    ["80 inside spaces", { [" " + x(80) + " "]: BLUE }],
    ["an astral character across the cut", { [x(79) + "😀"]: BLUE }],
    ["the same name in other case and spacing: the first wins", { Sam: BLUE, SAM: "#F9B64F", " sam ": "#CBA1FA" }],
    ["__proto__ alone", ownProto(BLUE)],
    ["__proto__ beside a name", Object.assign(ownProto(BLUE), { Sam: BLUE })],
    ["constructor", { constructor: BLUE }],
    ["prototype", { prototype: BLUE }],
    ["guarded names after trimming", { " constructor ": BLUE, "\u0000prototype": BLUE }],
    ["guarded names in other case are names", { Constructor: BLUE, __PROTO__: BLUE, PROTOTYPE: BLUE }],
    ["names of Object.prototype methods", { toString: BLUE, hasOwnProperty: BLUE }],
    ["199 names", many(199)],
    ["200 names, the limit", many(200)],
    ["201 names", many(201)],
    ["__proto__ and then 200 names", many(200, "__proto__")],
    ["prototype and then 200 names", many(200, "prototype")],
    ["an invalid colour and then 200 names", Object.assign({ Bad: "#000000" }, many(200))]
  ], normalizePersonColors);
};

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Old</title><meta name="description" content="old"></head><body><p>x</p></body></html>';

TABLES["with-page-head"] = () => table([
  ["a title", [PAGE, { title: "New" }]],
  ["a title's whitespace collapsed and trimmed", [PAGE, { title: " New \n\t title  " }]],
  ["NBSP and a line separator count as whitespace", [PAGE, { title: " New title " }]],
  ["a title escaped", [PAGE, { title: "<b>&\"'" }]],
  ["replacement patterns are literal", [PAGE, { title: "$&$1$$" }]],
  ["an empty title changes nothing", [PAGE, { title: "" }]],
  ["a title of spaces empties it", [PAGE, { title: "   " }]],
  ["a number", [PAGE, { title: 0 }]],
  ["a description replaces the old one", [PAGE, { description: " A  new\ndescription " }]],
  ["a description escaped", [PAGE, { description: "\"quoted\" & <b>" }]],
  ["both", [PAGE, { title: "T", description: "D" }]],
  ["a description inserted after the title", ["<html><head><title>Old</title></head></html>", { description: "D" }]],
  ["no title, no description: nothing inserted", ["<html><head></head></html>", { description: "D" }]],
  ["a description meta of another shape gets a second one", ["<html><head><title>Old</title><meta content='x' name='description'></head></html>", { description: "D" }]],
  ["a title in capitals", ["<html><HEAD><TITLE>Old</TITLE></HEAD></html>", { title: "New" }]],
  ["two titles: the first", ["<head><title>A</title><title>B</title></head>", { title: "New" }]],
  ["a title holding markup is not matched", ["<head><title>A<b>b</b></title></head>", { title: "New" }]],
  ["a title after the head is left alone", ["<head></head><body><title>A</title></body>", { title: "New" }]],
  ["no head", ["<title>Old</title>", { title: "New" }]],
  ["an empty head object", [PAGE, {}]]
], ([html, head]) => withPageHead(html, head));

TABLES["lengths"] = () => [
  ...table([["-0.1", -0.1], ["-0", -0], ["0", 0], ["0.4", 0.4], ["0.5", 0.5], ["86399.5", 86399.5], ["86400", 86400],
    ["86400.4: checked before rounding", 86400.4], ["86401", 86401], ["NaN", NaN], ["Infinity", Infinity], ["a numeric string", "5"],
    ["null", null], ["true", true]], (v) => ({ sceneLength: normalizeSceneLength(v) })),
  ...table([["0.4", 0.4], ["0.5: rounded up to one", 0.5], ["1", 1], ["86400", 86400], ["86400.4: checked after rounding", 86400.4],
    ["86400.5", 86400.5], ["86401", 86401], ["-1", -1], ["a numeric string", "5"], ["NaN", NaN], ["Infinity", Infinity]],
  (v) => ({ targetLength: normalizeTargetLength(v) }))
];

TABLES["gallery"] = () => {
  const sha = (i) => i.toString(16).padStart(64, "0");
  const ref = (i) => ({ sha256: sha(i), width: 2, height: 2, mime: "image/png" });
  const pen = (n) => ({ kind: "pen", color: "#e5383b", width: 0.01, points: Array.from({ length: n }, (_, i) => (i % 10) / 10) });
  const textMark = (text, extra) => Object.assign({ kind: "text", color: "#111111", size: 0.05, x: 0.5, y: 0.5, text }, extra);
  const gallery = ([withMain, n]) => {
    const r = { id: "r1", imageRef: withMain ? ref(9999) : null, moreImages: Array.from({ length: n }, (_, i) => ({ imageRef: ref(i + 1) })) };
    migrateGallery(r);
    return { first: r.imageRef ? r.imageRef.sha256.replace(/^0+/, "") : null, more: (r.moreImages || []).length };
  };
  const link = (href) => normalizeVideoLink({ href });
  return [
    ...table([["199", x(199)], ["200, the limit", x(200)], ["201", x(201)], ["200 inside spaces", " " + x(200) + " "],
      ["controls become spaces", "a\u0001\u0002b\nc"], ["markup stripped", "<b>n</b>.png"], ["not a string", 5]],
    (v) => ({ pictureName: normalizePictureName(v) })),
    ...table([["2048 characters, the limit", "https://e.x/" + x(2048 - 12)], ["2049 characters", "https://e.x/" + x(2049 - 12)],
      ["mailto is not a video link", "mailto:a@e.x"], ["javascript", "javascript:x"], ["upper-case scheme", "HTTPS://E.X/v"]],
    (href) => ({ videoLink: link(href) })),
    ...table([["file name 200", { name: x(200) }], ["file name 201", { name: x(201) }], ["file name of controls", { name: "\u0001" }],
      ["size rounded down", { name: "a.mp4", size: 10.9 }], ["negative size", { name: "a.mp4", size: -1 }], ["size as a string", { name: "a.mp4", size: "5" }],
      ["duration 0", { href: "https://e.x/", duration: 0 }], ["duration 0.05", { href: "https://e.x/", duration: 0.05 }],
      ["duration just under 1e7", { href: "https://e.x/", duration: 9999999.96 }], ["duration 1e7", { href: "https://e.x/", duration: 1e7 }],
      ["poster must be true", { href: "https://e.x/", poster: "true" }], ["href and name: href wins", { href: "https://e.x/", name: "a.mp4" }],
      ["neither", { size: 5 }]], (l) => ({ videoLink: normalizeVideoLink(l) })),
    ...table([["20 links, the limit", 20], ["21 links", 21]],
      (n) => ({ videoLinks: normalizeVideoLinks(Array.from({ length: n }, (_, i) => ({ href: "https://e.x/" + i }))).length })),
    ...table([["a duplicate and a second poster", [{ href: "https://e.x/a", poster: true }, { href: "https://e.x/a" }, { href: "https://e.x/b", poster: true }]]],
      (list) => ({ videoLinks: normalizeVideoLinks(list) })),
    ...table([["499 marks", 499], ["500 marks, the limit", 500], ["501 marks", 501]], (n) => ({ marks: normalizeMarks(Array.from({ length: n }, () => pen(2))).length })),
    ...table([["3999 point numbers", 3999], ["4000 point numbers, the limit", 4000], ["4002 point numbers", 4002], ["one point", 2], ["an odd count", 5]],
      (n) => { const m = normalizeMarks([pen(n)])[0]; return { points: m ? m.points.length : null }; }),
    ...table([["width below the floor", { width: 0.0001 }], ["width above the ceiling", { width: 0.25 }], ["a colour in capitals", { color: "#E5383B" }],
      ["a colour outside the palette", { color: "#123456" }], ["a point outside the picture", { points: [-1, 2, 0.5, 0.5] }], ["a point that is not a number", { points: [0, "1", 0, 0] }]],
    (over) => ({ marks: normalizeMarks([Object.assign(pen(4), over)]) })),
    ...table([["text 500, the limit", textMark(x(500))], ["text 501", textMark(x(501))], ["text of spaces", textMark("   ")],
      ["text with controls and CRLF", textMark("a\r\nb\u0001\u0002c\u007f")], ["size above the ceiling", textMark("t", { size: 0.5 })],
      ["text that is not a string", textMark(5)]], (m) => ({ marks: normalizeMarks([m]) })),
    ...table([["59 more pictures beside the first", [true, 59]], ["60, the limit", [true, 60]], ["61", [true, 61]],
      ["62 with no first picture: one moves up", [false, 62]]], (v) => ({ gallery: gallery(v) }))
  ];
};

TABLES["broll-props"] = () => {
  const registry = [
    { id: "t_mug", cat: "prop", name: "Red mug" },
    { id: "t_tripod", cat: "gear", name: "Tripod" },
    { id: "t_lamp", cat: "prop", name: "lamp" },
    { id: "t_lamp2", cat: "prop", name: "LAMP" },
    { cat: "prop", name: "No id" },
    { id: "t_noname", cat: "prop", name: "" }
  ];
  const props = (n) => Array.from({ length: n }, (_, i) => ({ name: "Prop " + i }));
  return table([
    ["39 props", props(39)],
    ["40 props, the limit", props(40)],
    ["41 props", props(41)],
    ["a name of 80", [{ name: x(80) }]],
    ["a name of 81", [{ name: x(81) }]],
    ["a name of 81 inside spaces", [{ name: " " + x(81) + " " }]],
    ["a number as a name", [{ name: 42 }]],
    ["a boolean as a name", [{ name: true }]],
    ["a string entry", ["Red mug"]],
    ["markup in a name", [{ name: "<b>Rope</b>" }]],
    ["a known prop by name, in other case", [{ name: "red MUG" }]],
    ["the first of two props that share a name", [{ name: "Lamp" }]],
    ["a known name outside the prop category", [{ name: "tripod" }]],
    ["a known id takes the registry's name", [{ id: "t_mug", name: "old name" }]],
    ["an unknown id with its own name", [{ id: "t_gone", name: "Gone" }]],
    ["an unknown id with no name", [{ id: "t_gone" }]],
    ["an id that is not a tag id", [{ id: "x_1", name: "Rope" }]],
    ["a tag id of 16 characters", [{ id: "t_" + x(16, "a"), name: "A" }]],
    ["a tag id of 17 characters", [{ id: "t_" + x(17, "a"), name: "A" }]],
    ["a tag id with a counter", [{ id: "t_a-123456", name: "A" }, { id: "t_a-1234567", name: "B" }]],
    ["duplicates by id and by name", [{ name: "Rope" }, { name: " rope " }, { id: "t_mug" }, { name: "Red mug" }]],
    ["null, an array and an empty name", [null, [], { name: "" }]],
    ["not a list", "Rope"]
  ], (list) => normalizeBrollProps(list, registry));
};

test("the fixture set is exactly the tables", () => {
  if (updatingGoldens("normalisers")) return;
  assert.deepEqual(goldenNames("normalisers-"), Object.keys(TABLES).map((k) => "normalisers-" + k).sort());
});

for (const [name, build] of Object.entries(TABLES)) {
  test("normalisers golden: " + name, () => {
    assertGolden("normalisers-" + name, build());
  });
}
