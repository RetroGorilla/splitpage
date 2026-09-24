import { inertBody, safeHref, sanitizeHtml } from "./04-richtext.js";
import { BROLL_MARKER_RE } from "./08c-broll.js";

/* ================= the structured document model (issue #85) =================

   docs/DOCUMENT-MODEL.md is the design; this file is its §4, step 1 of §10:
   pure functions over one value per cell, with nothing in the app calling
   them yet. Everything here is unit-tested under node (src/test/doc-model.
   test.mjs) and does nothing at evaluation time.

   A CELL is an array of RUNS. A run is text with marks, or the one atom, the
   b-roll key:

     { text: "the red mug", marks: { b: true, tag: "t_8f2a", cmt: ["c12"] } }
     { atom: "broll", id: "bs_41", text: "B-roll:", marks: {} }

   Marks, all optional: b, i, u, s, hl (true); dir (true: a stage direction
   for the performer, #167 — shown, never read aloud); href (a safeHref
   URL); tag (a registry id, at most one per run); cmt (sorted comment
   ids). "\n" in text
   is a line break. A no-break space stays what it is (it is how two typed
   spaces survive white-space: normal) and every reader treats it as a
   space. normalizeCell() puts any cell in its one canonical form, so two
   cells with the same content are the same JSON.

   HTML stays the stored format (design D2). toHtml() writes the sanitiser's
   own markup with its elements nested in one fixed order, so its output is
   a fixed point of sanitizeHtml(); fromHtml() reads anything, through the
   sanitiser first. The two agree character for character and mark for mark:
   fromHtml(toHtml(c)) deep-equals normalizeCell(c).

   Tags are named by registry id in the model and by (category, name) in
   the stored HTML until step 2 gives the registry ids of its own. So
   fromHtml takes opts.tagId(cat, name) and toHtml takes opts.tagOf(id) ->
   {cat, name}; without them a tag's id is "t:" + cat + ":" + name, which
   both sides read back. */

var FORMAT_MARKS = ["hl", "b", "i", "u", "s"];
var OBJ = "\uFFFC";              /* an atom's one character in a projection */

/* ---- tags: registry id <-> (category, name) ---- */

function defaultTagId(cat, name) { return "t:" + cat + ":" + name; }

function defaultTagOf(id) {
  var m = /^t:([a-z]+):([\s\S]+)$/.exec(String(id));
  return m ? { cat: m[1], name: m[2] } : null;
}

/* ---- canonical form ---- */

/* Text a cell may hold: no C0 controls but tab and line feed, no CR, no
   zero-width space (a caret spot in the live DOM, never content), and no
   U+FFFC (the projection's atom character). */
function cleanText(t) {
  /* eslint-disable-next-line no-control-regex -- C0 controls are exactly what cell text must not carry. */
  return String(t == null ? "" : t).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u200B\uFFFC]/g, "");
}

function cleanMarks(marks, forAtom) {
  var out = {};
  if (!marks || typeof marks !== "object") return out;
  FORMAT_MARKS.forEach(function (k) { if (marks[k] === true) out[k] = true; });
  /* a b-roll key is never part of a direction */
  if (!forAtom && marks.dir === true) out.dir = true;
  if (typeof marks.href === "string") {
    var href = safeHref(marks.href);
    if (href) out.href = href;
  }
  if (!forAtom && typeof marks.tag === "string" && marks.tag) out.tag = marks.tag;
  if (Array.isArray(marks.cmt)) {
    var ids = marks.cmt.filter(function (id) { return typeof id === "string" && id; });
    ids = ids.filter(function (id, i) { return ids.indexOf(id) === i; }).sort();
    if (ids.length) out.cmt = ids;
  }
  return out;
}

function sameMarks(a, b) {
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (var i = 0; i < ka.length; i++) {
    var k = ka[i];
    if (k === "cmt") {
      if (!b.cmt || a.cmt.length !== b.cmt.length) return false;
      for (var j = 0; j < a.cmt.length; j++) if (a.cmt[j] !== b.cmt[j]) return false;
    } else if (a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}

function orderedMarks(m) {
  /* One key order, so equal marks are equal JSON too. */
  var out = {};
  ["b", "i", "u", "s", "hl", "dir", "href", "tag", "cmt"].forEach(function (k) { if (m[k] !== undefined) out[k] = m[k]; });
  return out;
}

/* opts.hasTag(id) / opts.hasComment(id), when given, drop marks naming a
   tag or comment that no longer exists. */
export function normalizeCell(cell, opts) {
  opts = opts || {};
  var runs = [];
  (Array.isArray(cell) ? cell : []).forEach(function (r) {
    if (!r || typeof r !== "object") return;
    if (r.atom === "broll") {
      var text = cleanText(r.text).replace(/\n/g, " ").trim();
      var id = String(r.id == null ? "" : r.id).replace(/[^A-Za-z0-9_-]/g, "");
      var am = cleanMarks(r.marks, true);
      if (opts.hasComment && am.cmt) am.cmt = am.cmt.filter(opts.hasComment);
      if (am.cmt && !am.cmt.length) delete am.cmt;
      if (id && BROLL_MARKER_RE.test(text)) {
        runs.push({ atom: "broll", id: id, text: text, marks: orderedMarks(am) });
      } else if (text) {
        runs.push({ text: text, marks: am });
      }
      return;
    }
    var t = cleanText(r.text);
    if (!t) return;
    var m = cleanMarks(r.marks, false);
    if (opts.hasTag && m.tag && !opts.hasTag(m.tag)) delete m.tag;
    if (opts.hasComment && m.cmt) {
      m.cmt = m.cmt.filter(opts.hasComment);
      if (!m.cmt.length) delete m.cmt;
    }
    runs.push({ text: t, marks: m });
  });

  /* A tag is one unit in the editor, so a comment, a link or a direction
     covers all of it or none of it: across each stretch of one tag, cmt
     becomes the union, href the first one found and dir set if any of it
     was. That is also what lets toHtml() nest a tag inside its comments,
     directions and links without ever splitting it. */
  for (var i = 0; i < runs.length;) {
    var tag = runs[i].atom ? null : runs[i].marks.tag;
    if (!tag) { i++; continue; }
    var j = i;
    while (j < runs.length && !runs[j].atom && runs[j].marks.tag === tag) j++;
    if (j - i > 1) {
      var cmt = [], href = null, dir = false;
      for (var k = i; k < j; k++) {
        (runs[k].marks.cmt || []).forEach(function (c) { if (cmt.indexOf(c) === -1) cmt.push(c); });
        if (!href && runs[k].marks.href) href = runs[k].marks.href;
        if (runs[k].marks.dir) dir = true;
      }
      cmt.sort();
      for (k = i; k < j; k++) {
        if (cmt.length) runs[k].marks.cmt = cmt.slice(); else delete runs[k].marks.cmt;
        if (href) runs[k].marks.href = href; else delete runs[k].marks.href;
        if (dir) runs[k].marks.dir = true;
      }
    }
    i = j;
  }

  var out = [];
  runs.forEach(function (r) {
    if (!r.atom) r.marks = orderedMarks(r.marks);
    var last = out[out.length - 1];
    if (!r.atom && last && !last.atom && sameMarks(last.marks, r.marks)) {
      last.text += r.text;
    } else {
      out.push(r);
    }
  });
  return out;
}

/* ---- reading HTML ---- */

/* Any HTML into a canonical cell, through the sanitiser first. Pictures and
   video cards have no place in a script cell (design D7): each one found is
   handed to opts.onMedia({kind:"image", ref} | {kind:"video", href}) and
   left out. */
export function fromHtml(html, opts) {
  opts = opts || {};
  var tagId = opts.tagId || defaultTagId;
  var runs = [];
  var body = inertBody(sanitizeHtml(html == null ? "" : String(html)));
  (function walk(node, marks) {
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) {
        /* white-space: normal — a line feed in a text node shows as a space;
           only <br> breaks a line */
        var t = String(child.nodeValue || "").replace(/[\r\n]+/g, " ");
        if (t) runs.push({ text: t, marks: marks });
        return;
      }
      if (child.nodeType !== 1) return;
      var tag = child.tagName;
      if (tag === "BR") { runs.push({ text: "\n", marks: marks }); return; }
      if (tag === "IMG") {
        if (opts.onMedia) {
          opts.onMedia({ kind: "image", ref: {
            sha256: child.getAttribute("data-blob"),
            width: Number(child.getAttribute("data-w")) || null,
            height: Number(child.getAttribute("data-h")) || null,
            mime: child.getAttribute("data-mime") || null
          } });
        }
        return;
      }
      var cls = child.classList;
      if (tag === "A" && cls && cls.contains("video-embed-card")) {
        if (opts.onMedia) opts.onMedia({ kind: "video", href: child.getAttribute("href") });
        return;
      }
      if (tag === "SPAN" && cls && cls.contains("broll-key")) {
        runs.push({ atom: "broll", id: child.getAttribute("data-broll-id"), text: child.textContent, marks: marks });
        return;
      }
      var next = Object.assign({}, marks);
      if (tag === "STRONG") next.b = true;
      else if (tag === "EM") next.i = true;
      else if (tag === "U") next.u = true;
      else if (tag === "S") next.s = true;
      else if (tag === "MARK") next.hl = true;
      else if (tag === "A") next.href = child.getAttribute("href");
      else if (tag === "SPAN" && cls && cls.contains("tag-anchor")) {
        next.tag = tagId(child.getAttribute("data-tag-cat"), child.getAttribute("data-tag-name"));
      } else if (tag === "SPAN" && cls && cls.contains("cmt-anchor")) {
        next.cmt = (marks.cmt || []).concat([child.getAttribute("data-cmt")]);
      } else if (tag === "SPAN" && cls && cls.contains("stage-dir")) {
        next.dir = true;
      }
      walk(child, next);
    });
  })(body, {});
  return normalizeCell(runs, opts);
}

/* ---- a cached reader, for the readers (§10 step 3) ----

   cellOf(html) is fromHtml(html) with the model's own tag names
   ("t:<cat>:<name>"), cached by the HTML string itself, the contentMemo
   reasoning (07-production-tags.js): a key that is the input cannot go
   stale. Readers that only need words, formatting and category+name —
   exports, word count, the teleprompter, find — read cells through it and
   never parse HTML themselves. The returned cell is SHARED with every other
   caller for the same HTML: read it, never mutate it. Budgeted by
   characters, like contentMemo. */
var CELL_CACHE_BUDGET = 2000000;
var cellCache = new Map();
var cellCacheChars = 0;

export function cellOf(html) {
  var key = html == null ? "" : String(html);
  var hit = cellCache.get(key);
  if (hit !== undefined) return hit;
  var cell = fromHtml(key);
  if (cellCacheChars > CELL_CACHE_BUDGET) { cellCache.clear(); cellCacheChars = 0; }
  cellCache.set(key, cell);
  cellCacheChars += key.length;
  return cell;
}

/* A "t:<cat>:<name>" tag name (what cellOf gives) as {cat, name}, or null
   for a registry id. */
export function tagNameOf(id) {
  return defaultTagOf(id);
}

/* The other way: the tag mark a cell read without registry hooks (cellOf,
   editCell) gives the tag (cat, name) — and that toHtml writes back as a
   span with that category and name. */
export function namedTagId(cat, name) {
  return defaultTagId(cat, name);
}

/* ---- the one nesting, shared by every writer ----

   Elements open outermost first in this order: each comment (by id), the
   stage direction, the link, the tag, then highlight, bold, italic,
   underline, strike. Where two neighbouring runs share a prefix of that
   list the elements stay open across both, so a comment over bold and
   plain text is one span. The order never changes with the content, which
   is what makes the output canonical — and normalizeCell() guarantees no
   comment, direction or link starts or ends inside a tag, so a tag is never
   split. A direction sits just inside the comments so that only a comment
   edge can cut one in two: its brackets are drawn around each span of it
   (app.css), and a link or a format edge inside a direction must not add a
   pair. */
function elementKeys(marks, isAtom) {
  var keys = [];
  (marks.cmt || []).forEach(function (id) { keys.push({ k: "cmt", v: id }); });
  if (marks.dir && !isAtom) keys.push({ k: "dir", v: true });
  if (marks.href) keys.push({ k: "href", v: marks.href });
  if (marks.tag && !isAtom) keys.push({ k: "tag", v: marks.tag });
  FORMAT_MARKS.forEach(function (f) { if (marks[f]) keys.push({ k: f, v: true }); });
  return keys;
}

/* The cell as a tree of {el:{k,v}, kids} / {text} / {br} / {atom} nodes. */
function buildTree(cell, opts) {
  var tagOf = (opts && opts.tagOf) || defaultTagOf;
  var root = { kids: [] };
  var stack = [root];
  var open = [];
  function sync(keys) {
    var n = 0;
    while (n < open.length && n < keys.length && open[n].k === keys[n].k && open[n].v === keys[n].v) n++;
    open.length = n;
    stack.length = n + 1;
    for (var i = n; i < keys.length; i++) {
      var node = { el: keys[i], kids: [] };
      stack[stack.length - 1].kids.push(node);
      stack.push(node);
      open.push(keys[i]);
    }
  }
  normalizeCell(cell).forEach(function (r) {
    var marks = r.marks;
    if (!r.atom && marks.tag && !tagOf(marks.tag)) {
      marks = Object.assign({}, marks);
      delete marks.tag;
    }
    sync(elementKeys(marks, !!r.atom));
    var here = stack[stack.length - 1].kids;
    if (r.atom) { here.push({ atom: r }); return; }
    var parts = r.text.split("\n");
    parts.forEach(function (p, i) {
      if (i > 0) here.push({ br: true });
      if (p) {
        var last = here[here.length - 1];
        if (last && last.text !== undefined) last.text += p; else here.push({ text: p });
      }
    });
  });
  return { root: root, tagOf: tagOf };
}

function escText(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");
}
function escAttr(t) {
  return String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\u00a0/g, "&nbsp;");
}

var FORMAT_TAG = { hl: "mark", b: "strong", i: "em", u: "u", s: "s" };

/* The stored HTML for a cell: exactly the markup sanitizeHtml() writes,
   nested in the fixed order above.

   opts.textHtml(text, esc, where), when given, writes each stretch of text
   instead of esc(text) — a stretch being what one text node of the output
   would hold (never a line break), the b-roll key's word included; `where`
   is {dir: true} for a stretch inside a stage direction, {dir: false}
   otherwise. It is how a reader that wants the cell's own markup around
   something of its own, the teleprompter's per-word spans, gets it without
   parsing HTML. What it returns goes in as it is, so it must escape what
   it writes. */
var OUTSIDE_DIRECTION = { dir: false };
var INSIDE_DIRECTION = { dir: true };

export function toHtml(cell, opts) {
  var t = buildTree(cell, opts);
  var textHtml = opts && opts.textHtml
    ? function (s, where) { return opts.textHtml(s, escText, where); }
    : escText;
  function render(node, where) {
    var out = "";
    node.kids.forEach(function (n) {
      if (n.text !== undefined) { out += textHtml(n.text, where); return; }
      if (n.br) { out += "<br>"; return; }
      if (n.atom) {
        out += '<span class="broll-key" data-broll-id="' + escAttr(n.atom.id) + '" contenteditable="false">' + textHtml(n.atom.text, where) + "</span>";
        return;
      }
      var e = n.el;
      var inner = render(n, e.k === "dir" ? INSIDE_DIRECTION : where);
      if (e.k === "cmt") out += '<span class="cmt-anchor" data-cmt="' + escAttr(e.v) + '">' + inner + "</span>";
      else if (e.k === "dir") out += '<span class="stage-dir">' + inner + "</span>";
      else if (e.k === "href") out += '<a href="' + escAttr(e.v) + '" target="_blank" rel="noopener">' + inner + "</a>";
      else if (e.k === "tag") {
        var info = t.tagOf(e.v);
        out += '<span class="tag-anchor" data-tag-cat="' + escAttr(info.cat) + '" data-tag-name="' + escAttr(info.name) +
          '" contenteditable="false">' + inner + "</span>";
      } else {
        out += "<" + FORMAT_TAG[e.k] + ">" + inner + "</" + FORMAT_TAG[e.k] + ">";
      }
    });
    return out;
  }
  return render(t.root, OUTSIDE_DIRECTION);
}

/* ---- readers (what htmlToPlainText, htmlToMarkdown and htmlToRuns give
   for this cell's HTML, without parsing any) ----

   A stage direction (#167) is written the way a script prints one, in
   brackets: "(beat)". Its brackets are not in the cell \u2014 they are how a
   reader shows where one starts and ends \u2014 so every reader that writes
   text adds them round each stretch of it. */

function isDirRun(r) { return !!(r && !r.atom && r.marks.dir); }

/* opts.directions: "brackets" (the default) writes each direction as
   "(its words)"; "omit" leaves them out, for the words that are said (the
   read-time estimate, a narration export without them) \u2014 one space kept
   where one stood between two words, none before the punctuation that
   followed it ("Pour it (slowly)." is "Pour it."). */
export var OMIT_CLOSES = /^[.,;:!?)\]}"'\u2019\u201d]/;

export function toPlainText(cell, opts) {
  var omit = !!(opts && opts.directions === "omit");
  var runs = normalizeCell(cell);
  var out = "", gap = false;
  runs.forEach(function (r, i) {
    var t = r.text;
    if (isDirRun(r)) {
      if (omit) { gap = true; return; }
      if (!isDirRun(runs[i - 1])) t = "(" + t;
      if (!isDirRun(runs[i + 1])) t += ")";
    }
    if (gap) {
      gap = false;
      if (OMIT_CLOSES.test(t)) out = out.replace(/[ \t\u00a0]+$/, "");
      else if (/[\s\u00a0]$/.test(out)) t = t.replace(/^[ \t\u00a0]+/, "");
      else if (out && !/^[\s\u00a0]/.test(t)) t = " " + t;
    }
    out += t;
  });
  return out.replace(/\u00a0/g, " ").trim();
}

/* The words someone says aloud: the cell's text without its directions \u2014
   what the read-time estimate counts (01-scene-status.js wordCount). */
export function spokenText(cell) {
  return toPlainText(cell, { directions: "omit" });
}

/* ---- Markdown ----

   The same notation htmlToMarkdown() (04-richtext.js) writes — **bold**,
   *italic*, ~~strike~~, <u>underline</u>, <mark>highlight</mark>,
   [text](href), a line break as "\n", tags and comments as their words —
   but laid out for what a Markdown reader will make of it, not copied from
   an element tree. HTML nests however it likes; Markdown's delimiters only
   work where CommonMark's flanking rules let them open and close, and the
   HTML walker wrote "**a **b" (a delimiter after a space closes nothing),
   "**a****b**" (two bold elements side by side) and, over the model's one
   fixed nesting, "*x ****y***" for italic "x " then bold-italic "y". So:

   - Only the marks Markdown shows count: a tag or comment boundary never
     splits emphasis.
   - No mark starts or ends on white space (it moves outside, where it
     looks the same; a delimiter next to a space does nothing, and an
     element alone on a paragraph's first line starts an HTML block), and
     no mark spans a blank line, which ends a Markdown paragraph.
   - Where several marks open at once, the one that runs longest opens
     first (outermost), so a mark is closed and reopened only where two
     really cross; ties put the link, highlight and underline outside.
   - A delimiter that still could not do its job where it stands (inside a
     word next to punctuation, in one run of asterisks with a delimiter
     closing there, or kept from its partner by the rule of 3) is written
     as the HTML element instead — <strong>, <em>, <s> — which every
     Markdown renderer that reads the <u> and <mark> this already writes
     also reads (mdSettle).

   Text is written as it is, as htmlToMarkdown() writes it: an asterisk
   typed into a cell is not escaped. */

var MD_MARKS = ["href", "hl", "u", "b", "i", "s"];      /* ties: outermost first */
var MD_DELIM = { b: "**", i: "*", s: "~~" };
var MD_HTML = { b: "strong", i: "em", s: "s", u: "u", hl: "mark" };
var MD_WS = /[\s\u00a0]/;
var MD_PUNCT = /[\p{P}\p{S}]/u;

function mdChars(cell) {
  var chars = [];
  var runs = normalizeCell(cell);
  runs.forEach(function (r, ri) {
    var m = {};
    MD_MARKS.forEach(function (k) { if (r.marks[k]) m[k] = r.marks[k]; });
    /* a stage direction as the script prints it: "(beat)", in italics —
       the brackets italic and nothing else, so a bold last word does not
       take its closing bracket with it */
    var dir = isDirRun(r);
    if (dir) m.i = true;
    if (dir && !isDirRun(runs[ri - 1])) chars.push({ ch: "(", m: { i: true } });
    Array.from(r.text).forEach(function (ch) { chars.push({ ch: ch, m: Object.assign({}, m) }); });
    if (dir && !isDirRun(runs[ri + 1])) chars.push({ ch: ")", m: { i: true } });
  });
  var n = chars.length, i, j;
  /* a blank line ends a paragraph, and everything open with it */
  for (i = 0; i < n; i++) {
    if (chars[i].ch !== "\n") continue;
    j = i + 1;
    while (j < n && (chars[j].ch === " " || chars[j].ch === "\t")) j++;
    if (j < n && chars[j].ch === "\n") {
      for (var k = i; k <= j; k++) chars[k].m = {};
    }
  }
  /* no mark opens or closes on white space */
  MD_MARKS.forEach(function (key) {
    for (i = 0; i < n;) {
      if (!chars[i].m[key]) { i++; continue; }
      j = i;
      while (j < n && chars[j].m[key]) j++;
      var a = i, z = j - 1;
      while (a <= z && MD_WS.test(chars[a].ch)) delete chars[a++].m[key];
      while (z >= a && MD_WS.test(chars[z].ch)) delete chars[z--].m[key];
      i = j;
    }
  });
  return chars;
}

function sameMdMarks(a, b) {
  for (var i = 0; i < MD_MARKS.length; i++) if ((a[MD_MARKS[i]] || null) !== (b[MD_MARKS[i]] || null)) return false;
  return true;
}

/* The cell as tokens, {open: key, v, pair}, {close: key, v, pair} and
   {text}, the marks properly nested: where a mark ends under one that goes
   on, the one that goes on is closed and opened again. */
function mdTokens(cell) {
  var pieces = [];
  mdChars(cell).forEach(function (c) {
    var last = pieces[pieces.length - 1];
    if (last && sameMdMarks(last.m, c.m)) last.text += c.ch;
    else pieces.push({ text: c.ch, m: c.m });
  });
  /* how far each mark runs on from each piece, in characters */
  for (var p = pieces.length - 1; p >= 0; p--) {
    var next = pieces[p + 1];
    pieces[p].ext = {};
    for (var q = 0; q < MD_MARKS.length; q++) {
      var k = MD_MARKS[q];
      if (!pieces[p].m[k]) continue;
      pieces[p].ext[k] = pieces[p].text.length + (next && next.m[k] === pieces[p].m[k] ? next.ext[k] : 0);
    }
  }
  var tokens = [], stack = [], pairs = 0;
  pieces.forEach(function (piece) {
    var cut = 0;
    while (cut < stack.length && piece.m[stack[cut].k] === stack[cut].v) cut++;
    while (stack.length > cut) tokens.push(mdClose(stack.pop()));
    var open = MD_MARKS.filter(function (k) {
      if (!piece.m[k]) return false;
      for (var s = 0; s < stack.length; s++) if (stack[s].k === k) return false;
      return true;
    });
    open.sort(function (a, b) { return (piece.ext[b] - piece.ext[a]) || (MD_MARKS.indexOf(a) - MD_MARKS.indexOf(b)); });
    open.forEach(function (k) {
      var pair = pairs++;
      tokens.push({ open: k, v: piece.m[k], pair: pair });
      stack.push({ k: k, v: piece.m[k], pair: pair });
    });
    tokens.push({ text: piece.text });
  });
  while (stack.length) tokens.push(mdClose(stack.pop()));
  return tokens;
}

function mdClose(open) {
  return { close: open.k, v: open.v, pair: open.pair };
}

function mdRender(tokens, asHtml) {
  var linkDepth = 0;
  return tokens.map(function (t) {
    if (t.text !== undefined) return linkDepth ? t.text.replace(/([[\]()])/g, "\\$1") : t.text;
    var k = t.open || t.close;
    if (k === "href") {
      if (t.open) { linkDepth++; return "["; }
      linkDepth--;
      return "](" + t.v + ")";
    }
    if (MD_DELIM[k] && !asHtml[t.pair]) return MD_DELIM[k];
    return t.open ? "<" + MD_HTML[k] + ">" : "</" + MD_HTML[k] + ">";
  });
}

/* Whether a delimiter run can open and close where it stands, by
   CommonMark's flanking rules; null is the edge of the cell, which counts
   as white space. */
function mdFlank(prev, next) {
  var wsPrev = prev === null || MD_WS.test(prev), wsNext = next === null || MD_WS.test(next);
  var pPrev = !wsPrev && MD_PUNCT.test(prev), pNext = !wsNext && MD_PUNCT.test(next);
  return { left: !wsNext && (!pNext || wsPrev || pPrev), right: !wsPrev && (!pPrev || wsNext || pNext) };
}

/* The delimiter runs of one rendering: consecutive delimiters of one
   character with nothing between them. A line break is white space in the
   plain export and "<br>" (punctuation) in a table cell, so a run has to
   work both ways. */
function mdRuns(tokens, strs, asHtml) {
  var runOf = [];
  for (var i = 0; i < tokens.length;) {
    var k = tokens[i].open || tokens[i].close;
    if (!MD_DELIM[k] || asHtml[tokens[i].pair]) { i++; continue; }
    var ch = MD_DELIM[k].charAt(0), j = i, len = 0, closes = false;
    while (j < tokens.length) {
      var u = tokens[j], uk = u.open || u.close;
      if (!MD_DELIM[uk] || asHtml[u.pair] || MD_DELIM[uk].charAt(0) !== ch) break;
      len += MD_DELIM[uk].length;
      if (u.close) closes = true;
      j++;
    }
    /* every token writes something, so the neighbours are the tokens
       either side */
    var prev = i > 0 ? /[\s\S]$/u.exec(strs[i - 1])[0] : null;
    var next = j < strs.length ? /^[\s\S]/u.exec(strs[j])[0] : null;
    var asText = mdFlank(prev, next);
    var asBr = mdFlank(prev === "\n" ? ">" : prev, next === "\n" ? "<" : next);
    var run = {
      ch: ch, len: len, closes: closes,
      left: asText.left && asBr.left,
      right: asText.right && asBr.right,
      both: (asText.left && asText.right) || (asBr.left && asBr.right)
    };
    for (var c = i; c < j; c++) runOf[c] = run;
    i = j;
  }
  return runOf;
}

/* CommonMark's "rule of 3": a run that can both open and close does not
   pair with one whose length makes the sum a multiple of 3, unless both
   lengths are. */
function mdRuleOf3(a, b) {
  return (a.both || b.both) && (a.len + b.len) % 3 === 0 && !(a.len % 3 === 0 && b.len % 3 === 0);
}

/* A delimiter that cannot do its job where it stands goes over to HTML:
   one that cannot open or close there, an opener in the same run as a
   closer, an opener that could also close and would pair with a delimiter
   of the same character still open outside it, and a pair the rule of 3
   keeps apart. Switching one changes the runs after it, so they are
   judged again: one switch per round, the first in the cell, until none
   is needed. Every switch is for good, so it always settles. */
function mdSettle(tokens) {
  var asHtml = {};
  for (;;) {
    var strs = mdRender(tokens, asHtml);
    var runOf = mdRuns(tokens, strs, asHtml);
    var openRun = {}, outer = { "*": [], "~": [] };
    /* where it stands first, how it pairs second: a run that is about to
       change must not get a pair switched for its sake */
    var bad = null, badPairing = null;
    for (var i = 0; i < tokens.length && bad === null; i++) {
      var t = tokens[i], run = runOf[i];
      if (!run) continue;
      if (t.open) {
        var out = outer[run.ch][outer[run.ch].length - 1];
        if (!run.left || run.closes) bad = t.pair;
        else if (badPairing === null && run.both && out && !mdRuleOf3(run, out)) badPairing = t.pair;
        openRun[t.pair] = run;
        outer[run.ch].push(run);
      } else {
        outer[run.ch].pop();
        if (!run.right) bad = t.pair;
        else if (badPairing === null && mdRuleOf3(openRun[t.pair], run)) badPairing = t.pair;
      }
    }
    if (bad === null) bad = badPairing;
    if (bad === null) return strs.join("");
    asHtml[bad] = true;
  }
}

export function toMarkdown(cell) {
  return mdSettle(mdTokens(cell)).replace(/\n{3,}/g, "\n\n").trim();
}

/* [{text, b, i, u, s, mark, href}], a line break as its own {text:"\n"}.
   A run inside a stage direction also carries dir: true (and only then \u2014
   a cell with none gives exactly the runs htmlToRuns gives), and each
   direction is bracketed: a "(" run before it and a ")" run after it,
   unformatted but for dir, so a writer that knows nothing of directions
   still prints "(beat)". */
export function toDocxRuns(cell, opts) {
  var t = buildTree(cell, opts);
  var runs = [];
  (function walk(node, fmt) {
    node.kids.forEach(function (n) {
      if (n.text !== undefined || n.atom) {
        var text = (n.atom ? n.atom.text : n.text).replace(/\u00a0/g, " ");
        if (!text) return;
        var run = { text: text, b: fmt.b, i: fmt.i, u: fmt.u, s: fmt.s, mark: fmt.mark, href: fmt.href };
        if (fmt.dir) run.dir = true;
        runs.push(run);
        return;
      }
      if (n.br) { runs.push(fmt.dir ? { text: "\n", dir: true } : { text: "\n" }); return; }
      var k = n.el.k;
      walk(n, {
        b: fmt.b || k === "b", i: fmt.i || k === "i", u: fmt.u || k === "u", s: fmt.s || k === "s",
        mark: fmt.mark || k === "hl", href: k === "href" ? n.el.v : fmt.href, dir: fmt.dir || k === "dir"
      });
    });
  })(t.root, { b: false, i: false, u: false, s: false, mark: false, href: null, dir: false });
  return bracketDirections(runs);
}

function bracketDirections(runs) {
  if (!runs.some(function (r) { return r.dir; })) return runs;
  function bracket(ch) {
    return { text: ch, b: false, i: false, u: false, s: false, mark: false, href: null, dir: true };
  }
  var out = [];
  runs.forEach(function (r, i) {
    var starts = r.dir && !(runs[i - 1] && runs[i - 1].dir);
    var ends = r.dir && !(runs[i + 1] && runs[i + 1].dir);
    if (starts) out.push(bracket("("));
    out.push(r);
    if (ends) out.push(bracket(")"));
  });
  return out;
}

/* ---- positions ----

   A position is an offset into the cell's projection: its text with each
   atom as one U+FFFC. That is the coordinate edits, find, the undo stack
   and caret restore share. */

export function projection(cell) {
  var out = "";
  normalizeCell(cell).forEach(function (r) { out += r.atom ? OBJ : r.text; });
  return out;
}

export function cellLength(cell) {
  return projection(cell).length;
}

/* One entry per position: {ch, marks} or {atom}. */
function explode(cell) {
  var chars = [];
  normalizeCell(cell).forEach(function (r) {
    if (r.atom) { chars.push({ atom: r }); return; }
    for (var i = 0; i < r.text.length; i++) chars.push({ ch: r.text[i], marks: r.marks });
  });
  return chars;
}

function implode(chars, opts) {
  var runs = [];
  chars.forEach(function (c) {
    if (c.atom) { runs.push(c.atom); return; }
    var last = runs[runs.length - 1];
    if (last && !last.atom && last.marks === c.marks) last.text += c.ch;
    else runs.push({ text: c.ch, marks: c.marks });
  });
  return normalizeCell(runs, opts);
}

function clamp(cell, pos) {
  var n = cellLength(cell);
  pos = Math.floor(Number(pos) || 0);
  return pos < 0 ? 0 : (pos > n ? n : pos);
}

/* The marks at a position: those of the character before it, or after it
   at the very start. */
export function marksAt(cell, pos) {
  var chars = explode(cell);
  pos = clamp(cell, pos);
  var c = chars[pos - 1] || chars[pos];
  return c ? Object.assign({}, c.atom ? c.atom.marks : c.marks) : {};
}

/* Typing carries formatting on (bold stays bold) but never a tag, a
   comment or a link: those end where they end. A stage direction is typed
   into only between two of its own characters: at either edge of one,
   what is typed is narration again, so the words after "((beat))" are
   never swallowed into it. Exported for the editor's toolbar state and its
   pending marks (05-render.js): what a character typed at pos would carry. */
export function typingMarks(cell, pos) {
  var m = marksAt(cell, pos);
  delete m.tag;
  delete m.cmt;
  delete m.href;
  if (m.dir && !insideDirection(cell, pos)) delete m.dir;
  return m;
}

function isDirChar(c) { return !!(c && !c.atom && c.marks.dir); }

/* Is pos strictly inside a direction — a character of one on each side? */
export function insideDirection(cell, pos) {
  var chars = explode(cell);
  pos = clamp(cell, pos);
  return isDirChar(chars[pos - 1]) && isDirChar(chars[pos]);
}

export function sliceCell(cell, from, to) {
  var chars = explode(cell);
  from = clamp(cell, from);
  to = to === undefined ? chars.length : clamp(cell, to);
  return implode(chars.slice(from, Math.max(from, to)));
}

export function insertText(cell, pos, text, marks) {
  var chars = explode(cell);
  pos = clamp(cell, pos);
  var m = cleanMarks(marks === undefined ? typingMarks(cell, pos) : marks, false);
  var clean = cleanText(text);
  var ins = [];
  for (var i = 0; i < clean.length; i++) ins.push({ ch: clean[i], marks: m });
  return implode(chars.slice(0, pos).concat(ins, chars.slice(pos)));
}

export function insertBrollKey(cell, pos, id, text, marks) {
  var chars = explode(cell);
  pos = clamp(cell, pos);
  var atom = { atom: "broll", id: id, text: text, marks: marks === undefined ? typingMarks(cell, pos) : marks };
  return implode(chars.slice(0, pos).concat([{ atom: atom }], chars.slice(pos)));
}

export function deleteRange(cell, from, to) {
  var chars = explode(cell);
  from = clamp(cell, from);
  to = clamp(cell, to);
  if (to < from) { var x = from; from = to; to = x; }
  return implode(chars.slice(0, from).concat(chars.slice(to)));
}

/* The replaced range's first character lends its marks to the new text, so
   a word replaced inside a comment or in bold stays inside it. */
export function replaceText(cell, from, to, text) {
  from = clamp(cell, from);
  to = clamp(cell, to);
  if (to < from) { var x = from; from = to; to = x; }
  if (from === to) return insertText(cell, from, text);
  var chars = explode(cell);
  var first = chars[from];
  var marks = first.atom ? typingMarks(cell, from) : first.marks;
  return insertText(deleteRange(cell, from, to), from, text, marks);
}

/* The words from..to become `text` carrying tag `id` — what every typed
   route to a tag does (a closing shortcut, Tab completion, an untagged
   mention taken). The words keep the formatting they had (replaceText), so
   a phrase typed in bold is a bold tag. Returns {cell, end}: end is the
   position just past the tag, where the caret goes. */
export function replaceWithTag(cell, from, to, text, id) {
  var a = clamp(cell, Math.min(from, to)), b = clamp(cell, Math.max(from, to));
  var next = replaceText(cell, a, b, text);
  var end = a + cleanText(text).length;
  return { cell: setMark(next, a, end, "tag", id), end: end };
}

/* The words from..to become a b-roll key (the atom) — what typing
   "B-roll:" does (08c-broll.js maybeCaptureBroll). The key carries no
   marks, even when the words were bold: a key inside <strong> or a comment
   is not one the b-roll list can read (brollLineMarker knows a key only
   where it starts its line at the top of the cell — the shape the
   anchoring pass gives one too), so its line would fall back to matching
   its record by name. Returns {cell, end}: end is the position just past
   the key, where the caret goes. */
export function replaceWithBrollKey(cell, from, to, id, keyText) {
  var a = clamp(cell, Math.min(from, to)), b = clamp(cell, Math.max(from, to));
  return { cell: insertBrollKey(deleteRange(cell, a, b), a, id, keyText, {}), end: a + 1 };
}

/* name is b, i, u, s, hl, dir (value true/false), href (a URL or null)
   or tag (an id or null). Comments have addComment/removeComment. */
export function setMark(cell, from, to, name, value) {
  var chars = explode(cell);
  from = clamp(cell, from);
  to = clamp(cell, to);
  var cache = new Map();
  for (var i = Math.min(from, to); i < Math.max(from, to); i++) {
    var c = chars[i];
    var base = c.atom ? c.atom.marks : c.marks;
    if (c.atom && (name === "tag" || name === "dir")) continue;
    var next = cache.get(base);
    if (!next) {
      next = Object.assign({}, base);
      if (value === false || value === null || value === undefined) delete next[name];
      else next[name] = value;
      cache.set(base, next);
    }
    if (c.atom) chars[i] = { atom: Object.assign({}, c.atom, { marks: next }) };
    else chars[i] = { ch: c.ch, marks: next };
  }
  return implode(chars);
}

/* ---- the editor's formatting edits (design §5: a format and a line
   break are model edits, not execCommand) ---- */

/* Does every character of [from, to) carry mark `name`? Only the
   characters a reader sees as text count: a line break has no look of its
   own to be bold or not, and a b-roll key is not the words being
   formatted — so a selection over two separately bolded lines still reads
   as bold. False for a range holding no such character. */
export function markThroughout(cell, from, to, name) {
  var chars = explode(cell);
  from = clamp(cell, from);
  to = clamp(cell, to);
  var seen = false;
  for (var i = Math.min(from, to); i < Math.max(from, to); i++) {
    var c = chars[i];
    if (c.atom || c.ch === "\n") continue;
    if (!c.marks[name]) return false;
    seen = true;
  }
  return seen;
}

/* A toolbar button or Ctrl+B over a selection: already bold throughout
   comes off, anything less goes on over all of it — so bolding across the
   edge of an existing bold run makes one run, never a checkerboard. */
export function toggleMark(cell, from, to, name) {
  return setMark(cell, from, to, name, !markThroughout(cell, from, to, name));
}

/* ---- stage directions (#167) ----

   A direction for the performer — "(beat)", "(look to camera 2)" — is the
   mark dir on ordinary words of the Audio column: the editor and the
   Writer show it dim and bracketed, the teleprompter shows it in place but
   leaves it out of the words voice follow listens for, and the read-time
   estimate does not count it. The brackets are never in the cell; every
   reader adds them (toPlainText, toMarkdown, toDocxRuns, app.css). */

/* The whole direction at pos — the one holding the character after pos,
   else the one before — as {from, to}, or null. */
export function directionRangeAt(cell, pos) {
  var chars = explode(cell);
  pos = clamp(cell, pos);
  var at = isDirChar(chars[pos]) ? pos : isDirChar(chars[pos - 1]) ? pos - 1 : -1;
  if (at === -1) return null;
  var a = at, b = at + 1;
  while (a > 0 && isDirChar(chars[a - 1])) a--;
  while (b < chars.length && isDirChar(chars[b])) b++;
  return { from: a, to: b };
}

/* The Direction button over a selection: already a direction throughout
   comes off; anything less becomes one, without the spaces at its ends
   (a double-click's trailing space would otherwise print "(beat )"). */
export function toggleDirection(cell, from, to) {
  var r = directionToggleRange(cell, from, to);
  return setMark(cell, r.from, r.to, "dir", !r.off);
}

/* What toggleDirection acts on: {from, to, off} — the range itself when
   it comes off, the range without its end spaces when it goes on (where
   the editor puts the selection afterwards). */
export function directionToggleRange(cell, from, to) {
  from = clamp(cell, from);
  to = clamp(cell, to);
  if (to < from) { var x = from; from = to; to = x; }
  if (markThroughout(cell, from, to, "dir")) return { from: from, to: to, off: true };
  var p = projection(cell);
  while (from < to && /\s/.test(p.charAt(from))) from++;
  while (to > from && /\s/.test(p.charAt(to - 1))) to--;
  return { from: from, to: to, off: false };
}

/* The typed shortcut: "((" words "))". The typing convention, signed off
   by Adam for #167: a DOUBLE pair of round brackets, closed by typing the
   second ")", turns the words between into a direction and the four
   brackets go; one Ctrl+Z (a separate undo entry, like the tag shortcuts)
   gives the literal "((words))" back. Single brackets are ordinary prose
   and never convert. Only in the Audio column (the caller checks).
   Called with pos just after the "))"; returns {cell, end} with end just
   past the direction, or null when the text there is not one: nothing
   between the pairs but spaces, a bracket, a line break or a b-roll key
   inside, more than DIRECTION_MAX characters, a bracket that is part of a
   tag, or words that already are a direction. "(((x))" makes "(" and a
   direction "x"; "((x)))" — what typing ")" after an undo gives — stays. */
var DIRECTION_MAX = 200;

export function directionShortcut(cell, pos) {
  var chars = explode(cell);
  pos = clamp(cell, pos);
  var p = projection(cell);
  if (pos < 5 || p.slice(pos - 2, pos) !== "))") return null;
  var open = p.lastIndexOf("((", pos - 5);
  if (open === -1) return null;
  var inner = p.slice(open + 2, pos - 2);
  if (!inner.trim() || inner.length > DIRECTION_MAX || /[()\n￼]/.test(inner)) return null;
  for (var i = open; i < pos; i++) {
    var c = chars[i];
    if (c.atom || c.marks.dir) return null;
    if (c.marks.tag && (i < open + 2 || i >= pos - 2)) return null;
  }
  var lead = inner.length - inner.replace(/^\s+/, "").length;
  var trail = inner.length - inner.replace(/\s+$/, "").length;
  var next = deleteRange(deleteRange(cell, pos - 2, pos), open, open + 2);
  return { cell: setMark(next, open + lead, pos - 4 - trail, "dir", true), end: pos - 4 };
}

/* Directions in text that came from outside (an import, a Markdown table
   edited by hand): each "((words))" in text that is not already one
   becomes a direction, the way typing it would; and a direction that
   arrives with its brackets round it — a .docx Splitpage wrote, which
   prints them — loses them. For the Audio column only; the caller
   decides. */
export function importDirections(cell) {
  var out = normalizeCell(cell);
  /* brackets the writer printed round a direction */
  var chars = explode(out);
  var drop = [];
  for (var i = 0; i < chars.length;) {
    if (!isDirChar(chars[i])) { i++; continue; }
    var j = i;
    while (j < chars.length && isDirChar(chars[j])) j++;
    if (j - i >= 3 && chars[i].ch === "(" && chars[j - 1].ch === ")" &&
        !chars[i].marks.tag && !chars[j - 1].marks.tag) drop.push(i, j - 1);
    i = j;
  }
  for (var d = drop.length - 1; d >= 0; d--) out = deleteRange(out, drop[d], drop[d] + 1);
  /* "((words))" typed as text — the pattern holds no bracket inside, so
     it finds the same pair the shortcut takes ("(((x))" matches at its
     second bracket) */
  for (var guard = 0; guard < 1000; guard++) {
    var p = projection(out), done = true;
    var re = /\(\([^()\n￼]{1,200}\)\)/g, m;
    while ((m = re.exec(p)) !== null) {
      var got = directionShortcut(out, m.index + m[0].length);
      if (got) { out = got.cell; done = false; break; }
    }
    if (done) break;
  }
  return out;
}

/* A cell's directions as ordinary words again, each in the brackets it
   was shown with — what a direction pasted into the Visual column, which
   has none, becomes. A bracket is a run of its own, never part of a tag. */
export function flattenDirections(cell) {
  var runs = normalizeCell(cell);
  if (!runs.some(isDirRun)) return runs;
  var out = [];
  runs.forEach(function (r, i) {
    if (!isDirRun(r)) { out.push(r); return; }
    var m = Object.assign({}, r.marks);
    delete m.dir;
    var edge = Object.assign({}, m);
    delete edge.tag;
    if (!isDirRun(runs[i - 1])) out.push({ text: "(", marks: edge });
    out.push({ text: r.text, marks: m });
    if (!isDirRun(runs[i + 1])) out.push({ text: ")", marks: edge });
  });
  return normalizeCell(out);
}

/* Enter / Shift+Enter over [from, to): the range replaced by a line break,
   as {cell, pos} with pos just after the break.

   At the very end of the cell there is nothing after the break to give the
   new last line a box (a trailing <br> renders no line), so it goes in
   twice with pos between the two — the sentinel the browser's own
   insertLineBreak adds, which the next thing typed then sits in front of.

   The break carries formatting on the way typing does (bold keeps going on
   the next line). A comment or a link only where the text on both sides of
   it is in the same one: a break typed inside a commented phrase stays
   inside its one anchor, and one typed at its edge does not stretch it. */
export function breakLine(cell, from, to) {
  from = clamp(cell, from);
  to = clamp(cell, to);
  if (to < from) { var x = from; from = to; to = x; }
  var rest = deleteRange(cell, from, to);
  var chars = explode(rest);
  var marks = typingMarks(rest, from);
  var prev = chars[from - 1], next = chars[from];
  if (prev && next) {
    var pm = prev.atom ? prev.atom.marks : prev.marks;
    var nm = next.atom ? next.atom.marks : next.marks;
    if (pm.href && pm.href === nm.href) marks.href = pm.href;
    var cmt = (pm.cmt || []).filter(function (id) { return (nm.cmt || []).indexOf(id) !== -1; });
    if (cmt.length) marks.cmt = cmt;
  }
  var text = from === chars.length ? "\n\n" : "\n";
  return { cell: insertText(rest, from, text, marks), pos: from + 1 };
}

function editComment(cell, from, to, id, add) {
  var chars = explode(cell);
  from = clamp(cell, from);
  to = clamp(cell, to);
  for (var i = Math.min(from, to); i < Math.max(from, to); i++) {
    var c = chars[i];
    var base = c.atom ? c.atom.marks : c.marks;
    var list = (base.cmt || []).filter(function (x) { return x !== id; });
    if (add) list.push(id);
    var next = Object.assign({}, base, { cmt: list });
    if (c.atom) chars[i] = { atom: Object.assign({}, c.atom, { marks: next }) };
    else chars[i] = { ch: c.ch, marks: next };
  }
  return implode(chars);
}

export function addComment(cell, from, to, id) { return editComment(cell, from, to, id, true); }

/* Without a range, everywhere in the cell. */
export function removeComment(cell, id, from, to) {
  return editComment(cell, from === undefined ? 0 : from, to === undefined ? cellLength(cell) : to, id, false);
}

/* Where a comment's text is, as {from, to} over its first stretch, or null. */
export function commentRange(cell, id) {
  var chars = explode(cell);
  var from = -1;
  for (var i = 0; i < chars.length; i++) {
    var m = chars[i].atom ? chars[i].atom.marks : chars[i].marks;
    var has = !!(m.cmt && m.cmt.indexOf(id) !== -1);
    if (has && from === -1) from = i;
    if (!has && from !== -1) return { from: from, to: i };
  }
  return from === -1 ? null : { from: from, to: chars.length };
}

export function commentIds(cell) {
  var ids = [];
  normalizeCell(cell).forEach(function (r) {
    (r.marks.cmt || []).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
  });
  return ids.sort();
}

export function tagIds(cell) {
  var ids = [];
  normalizeCell(cell).forEach(function (r) {
    if (!r.atom && r.marks.tag && ids.indexOf(r.marks.tag) === -1) ids.push(r.marks.tag);
  });
  return ids;
}

/* Every run tagged fromId now carries toId, or no tag at all when toId is
   null: a tag removed, or two registry entries folded into one. */
export function retag(cell, fromId, toId) {
  return normalizeCell(normalizeCell(cell).map(function (r) {
    if (r.atom || r.marks.tag !== fromId) return r;
    var m = Object.assign({}, r.marks);
    if (toId) m.tag = toId; else delete m.tag;
    return { text: r.text, marks: m };
  }));
}

export function splitCell(cell, pos) {
  return [sliceCell(cell, 0, pos), sliceCell(cell, pos)];
}

/* glue (a string, e.g. " ") goes between the two. It carries no formatting,
   but it does carry a comment or a link the text on both sides of it is in
   (breakLine's rule): a scene split through a commented phrase and joined
   back is one anchor again, not two with a gap between them. */
export function joinCells(a, b, glue) {
  var runs = normalizeCell(a).slice();
  var rest = normalizeCell(b);
  if (glue) {
    var marks = {};
    var last = runs[runs.length - 1], first = rest[0];
    if (last && first) {
      if (last.marks.href && last.marks.href === first.marks.href) marks.href = last.marks.href;
      var cmt = (last.marks.cmt || []).filter(function (id) { return (first.marks.cmt || []).indexOf(id) !== -1; });
      if (cmt.length) marks.cmt = cmt;
      if (isDirRun(last) && isDirRun(first)) marks.dir = true;
    }
    runs.push({ text: glue, marks: marks });
  }
  return normalizeCell(runs.concat(rest));
}

export function sameCell(a, b) {
  return JSON.stringify(normalizeCell(a)) === JSON.stringify(normalizeCell(b));
}

/* ---- where a comment is (design §3.2) ----

   A comment's anchor is its cmt mark in the script's cells: the words
   carry it wherever they go — split into a new scene, joined into the one
   above, cut and pasted. comment.rowId / comment.field only SAY where that
   is, for the panel's "Row 03 · Audio", its script-order sort, the jump
   and the server; this is the one function that keeps them in step, run
   wherever text moves between rows (a split, a join, a paste, a merge or
   a load through migrateRows).

   Each comment marked somewhere points at the first cell holding its mark,
   in document order (row by row, the visual column before the audio, the
   panel's own order). A comment whose mark is nowhere — its words deleted
   — keeps what it had: it is detached, and still shows in the panel with
   its quote. A conflict card and a title comment have no mark and are
   never touched. Mutates the comments in place; returns how many moved.

   Only cells whose HTML holds an anchor at all are read, and through
   cellOf's cache, so a document of a thousand scenes and one comment costs
   a thousand indexOf calls. */
export function syncCommentAnchors(state) {
  var comments = state && state.comments;
  if (!Array.isArray(comments) || !comments.length) return 0;
  var where = Object.create(null);
  (state.rows || []).forEach(function (row) {
    if (!row) return;
    ["visualText", "audioText"].forEach(function (field) {
      var html = row[field];
      if (typeof html !== "string" || html.indexOf("cmt-anchor") === -1) return;
      commentIds(cellOf(html)).forEach(function (id) {
        if (!where[id]) where[id] = { rowId: row.id, field: field };
      });
    });
  });
  var moved = 0;
  comments.forEach(function (c) {
    if (!c || typeof c !== "object" || c.kind === "conflict" || c.field === "title") return;
    var at = where[c.anchorId || c.id];
    if (!at || (c.rowId === at.rowId && c.field === at.field)) return;
    c.rowId = at.rowId;
    c.field = at.field;
    moved++;
  });
  return moved;
}

/* ---- steps (undo/redo) ----

   One document change is a list of steps; one list is one undo entry.
   A step records the value before and after, whatever the field holds —
   a cell is stored as HTML (design D2), so a cell step carries HTML:

     {op:"rowField", rowId, key, before, after}   a cell, status, picture…
     {op:"docField", key, before, after}          title, registry, comments…
     {op:"insertRow", index, row}
     {op:"deleteRow", index, row}
     {op:"moveRow", from, to}

   applySteps() returns a new state and never mutates the one it is given.
   A step whose `before` is not what the state holds is refused (throws):
   an undo that no longer applies must fail whole, never half way. */

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function stepRefused(step, why) {
  var err = new Error("step does not apply: " + step.op + " (" + why + ")");
  err.code = "STEP_REFUSED";
  return err;
}

function applyStep(state, step) {
  var rows = state.rows || [];
  var next = Object.assign({}, state);
  var i;
  if (step.op === "rowField") {
    i = rows.findIndex(function (r) { return r && r.id === step.rowId; });
    if (i === -1) throw stepRefused(step, "no row " + step.rowId);
    if (!same(rows[i][step.key], step.before)) throw stepRefused(step, step.key + " has changed");
    next.rows = rows.slice();
    next.rows[i] = Object.assign({}, rows[i]);
    if (step.after === undefined) delete next.rows[i][step.key];
    else next.rows[i][step.key] = clone(step.after);
  } else if (step.op === "docField") {
    if (!same(state[step.key], step.before)) throw stepRefused(step, step.key + " has changed");
    if (step.after === undefined) delete next[step.key];
    else next[step.key] = clone(step.after);
  } else if (step.op === "insertRow") {
    if (step.index < 0 || step.index > rows.length) throw stepRefused(step, "index " + step.index);
    if (rows.some(function (r) { return r && r.id === step.row.id; })) throw stepRefused(step, "row exists");
    next.rows = rows.slice();
    next.rows.splice(step.index, 0, clone(step.row));
  } else if (step.op === "deleteRow") {
    if (!rows[step.index] || !same(rows[step.index], step.row)) throw stepRefused(step, "row has changed");
    next.rows = rows.slice();
    next.rows.splice(step.index, 1);
  } else if (step.op === "moveRow") {
    if (!rows[step.from] || step.to < 0 || step.to >= rows.length) throw stepRefused(step, "index");
    next.rows = rows.slice();
    var moved = next.rows.splice(step.from, 1)[0];
    next.rows.splice(step.to, 0, moved);
  } else {
    throw stepRefused(step, "unknown op");
  }
  return next;
}

export function applySteps(state, steps) {
  return (steps || []).reduce(applyStep, state);
}

export function invertSteps(steps) {
  return (steps || []).slice().reverse().map(function (s) {
    if (s.op === "rowField") return { op: "rowField", rowId: s.rowId, key: s.key, before: clone(s.after), after: clone(s.before) };
    if (s.op === "docField") return { op: "docField", key: s.key, before: clone(s.after), after: clone(s.before) };
    if (s.op === "insertRow") return { op: "deleteRow", index: s.index, row: clone(s.row) };
    if (s.op === "deleteRow") return { op: "insertRow", index: s.index, row: clone(s.row) };
    if (s.op === "moveRow") return { op: "moveRow", from: s.to, to: s.from };
    throw stepRefused(s, "unknown op");
  });
}

/* Which cells a step list touches, as "rowId\u0000field" keys — what the
   undo stack compares with what a merge changed (design D4). A row
   inserted or deleted touches both its cells. */
export function touchedCells(steps) {
  var out = [];
  function add(k) { if (out.indexOf(k) === -1) out.push(k); }
  (steps || []).forEach(function (s) {
    if (s.op === "rowField" && (s.key === "visualText" || s.key === "audioText")) add(s.rowId + "\u0000" + s.key);
    if ((s.op === "insertRow" || s.op === "deleteRow") && s.row) {
      add(s.row.id + "\u0000visualText");
      add(s.row.id + "\u0000audioText");
    }
  });
  return out;
}

/* ---- three-way merge of one cell (design §8) ----

   Both sides changed the cell: merge the words, then the marks.
   1. Each side's projection is cut into tokens — a word (a run of anything
      but whitespace), one whitespace character, or one atom — and each side
      is diffed against base.
   2. Tokens neither side changed keep their characters, and each
      character's marks are merged one mark at a time: whichever side
      changed a mark wins; both changed it differently -> theirs, reported
      in markConflicts. Only a link or a tag can be set differently (one
      per character); formatting is on or off, so it never counts. The
      document merge (mergeTextField, 03-sync.js) treats a count above
      zero as a conflict: this cell stays live, my whole cell goes on a
      card.
   3. A stretch only one side changed takes that side. Both changed it the
      same way: that. Differently: theirs, and conflict is true — the
      caller keeps theirs live and puts my whole cell on a conflict card
      (design D3).
   Returns {cell, conflict, markConflicts}. */

function tokenize(chars) {
  var toks = [];
  var i = 0;
  while (i < chars.length) {
    if (chars[i].atom) { toks.push({ key: OBJ + chars[i].atom.id, chars: [chars[i]] }); i++; continue; }
    /* each whitespace character is a token of its own, so a change that
       only widens or narrows a gap still leaves the words either side of
       it in step */
    if (/\s/.test(chars[i].ch)) { toks.push({ key: chars[i].ch, chars: [chars[i]] }); i++; continue; }
    var j = i;
    var key = "";
    while (j < chars.length && !chars[j].atom && !/\s/.test(chars[j].ch)) { key += chars[j].ch; j++; }
    toks.push({ key: key, chars: chars.slice(i, j) });
    i = j;
  }
  return toks;
}

/* For each index of a, the index of b it is matched with in a longest
   common subsequence of keys, or -1. Common ends are matched first, so the
   table is only as big as the part that changed; past LCS_LIMIT cells of
   table (a few thousand words rewritten on both sides) it gives up and
   answers null, and the merge treats the cell as one conflicting change. */
var LCS_LIMIT = 4000000;

function lcsMap(a, b) {
  var map = new Array(a.length).fill(-1);
  var s = 0;
  while (s < a.length && s < b.length && a[s].key === b[s].key) { map[s] = s; s++; }
  var ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1].key === b[eb - 1].key) { ea--; eb--; map[ea] = eb; }
  var n = ea - s, m = eb - s;
  if (!n || !m) return map;
  if (n * m > LCS_LIMIT) return null;
  var dp = [];
  for (var x = 0; x <= n; x++) dp.push(new Int32Array(m + 1));
  for (x = n - 1; x >= 0; x--) {
    for (var y = m - 1; y >= 0; y--) {
      dp[x][y] = a[s + x].key === b[s + y].key ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
    }
  }
  x = 0;
  y = 0;
  while (x < n && y < m) {
    if (a[s + x].key === b[s + y].key) { map[s + x] = s + y; x++; y++; }
    else if (dp[x + 1][y] >= dp[x][y + 1]) x++;
    else y++;
  }
  return map;
}

function markSet(m) {
  var set = {};
  FORMAT_MARKS.forEach(function (k) { if (m[k]) set[k] = true; });
  if (m.dir) set.dir = true;
  if (m.href) set["href=" + m.href] = true;
  if (m.tag) set["tag=" + m.tag] = true;
  (m.cmt || []).forEach(function (id) { set["cmt=" + id] = true; });
  return set;
}

function marksFromSet(set) {
  var m = {};
  Object.keys(set).forEach(function (k) {
    var eq = k.indexOf("=");
    if (eq === -1) m[k] = true;
    else if (k.slice(0, eq) === "cmt") (m.cmt = m.cmt || []).push(k.slice(eq + 1));
    else m[k.slice(0, eq)] = k.slice(eq + 1);
  });
  return m;
}

/* One character's marks, three ways. Returns {marks, conflict}. */
function mergeMarks(o, a, b) {
  var so = markSet(o), sa = markSet(a), sb = markSet(b);
  var keys = {};
  [so, sa, sb].forEach(function (s) { Object.keys(s).forEach(function (k) { keys[k] = true; }); });
  var out = {};
  Object.keys(keys).forEach(function (k) {
    var vo = !!so[k], va = !!sa[k], vb = !!sb[k];
    if (va === vo ? vb : va) out[k] = true;
  });
  /* one link and one tag per character: where the set now holds two, the
     sides set different ones — theirs */
  var conflict = false;
  ["href", "tag"].forEach(function (name) {
    var have = Object.keys(out).filter(function (k) { return k.indexOf(name + "=") === 0; });
    if (have.length > 1) {
      conflict = true;
      have.forEach(function (k) { if (!sb[k]) delete out[k]; });
    }
  });
  return { marks: marksFromSet(out), conflict: conflict };
}

function sameTokens(x, y) {
  if (x.length !== y.length) return false;
  for (var i = 0; i < x.length; i++) {
    if (x[i].key !== y[i].key) return false;
    for (var j = 0; j < x[i].chars.length; j++) {
      var cx = x[i].chars[j], cy = y[i].chars[j];
      var mx = cx.atom ? cx.atom.marks : cx.marks, my = cy.atom ? cy.atom.marks : cy.marks;
      if (!sameMarks(orderedMarks(cleanMarks(mx)), orderedMarks(cleanMarks(my)))) return false;
    }
  }
  return true;
}

function sameKeys(x, y) {
  if (x.length !== y.length) return false;
  for (var i = 0; i < x.length; i++) if (x[i].key !== y[i].key) return false;
  return true;
}

export function mergeCells(base, mine, theirs) {
  var o = tokenize(explode(base)), a = tokenize(explode(mine)), b = tokenize(explode(theirs));
  var ma = lcsMap(o, a), mb = lcsMap(o, b);
  if (!ma || !mb) {
    var ca = normalizeCell(mine), cb = normalizeCell(theirs);
    var agree = JSON.stringify(ca) === JSON.stringify(cb);
    return { cell: cb, conflict: !agree, markConflicts: 0 };
  }
  var out = [];
  var conflict = false, markConflicts = 0;

  function emitStable(ot, at, bt) {
    ot.chars.forEach(function (oc, i) {
      var ac = at.chars[i], bc = bt.chars[i];
      if (oc.atom) {
        var am = mergeMarks(oc.atom.marks, ac.atom.marks, bc.atom.marks);
        if (am.conflict) markConflicts++;
        out.push({ atom: Object.assign({}, bc.atom, { marks: am.marks }) });
        return;
      }
      var r = mergeMarks(oc.marks, ac.marks, bc.marks);
      if (r.conflict) markConflicts++;
      out.push({ ch: oc.ch, marks: r.marks });
    });
  }
  function emit(toks) { toks.forEach(function (t) { t.chars.forEach(function (c) { out.push(c); }); }); }

  function chunk(oS, aS, bS) {
    if (!oS.length && !aS.length && !bS.length) return;
    var aSame = sameKeys(oS, aS), bSame = sameKeys(oS, bS);
    if (aSame && bSame) {
      /* the words are the same on all three: only marks may differ */
      for (var i = 0; i < oS.length; i++) emitStable(oS[i], aS[i], bS[i]);
    } else if (aSame) {
      emit(bS);
    } else if (bSame) {
      emit(aS);
    } else if (sameTokens(aS, bS)) {
      emit(aS);
    } else {
      conflict = true;
      emit(bS);
    }
  }

  var io = 0, ia = 0, ib = 0;
  for (var i = 0; i < o.length; i++) {
    if (ma[i] === -1 || mb[i] === -1) continue;
    /* a token matched on both sides — but only a sync point if the
       matches are in order with the last one */
    if (ma[i] < ia || mb[i] < ib) continue;
    chunk(o.slice(io, i), a.slice(ia, ma[i]), b.slice(ib, mb[i]));
    emitStable(o[i], a[ma[i]], b[mb[i]]);
    io = i + 1;
    ia = ma[i] + 1;
    ib = mb[i] + 1;
  }
  chunk(o.slice(io), a.slice(ia), b.slice(ib));
  return { cell: implode(out), conflict: conflict, markConflicts: markConflicts };
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
