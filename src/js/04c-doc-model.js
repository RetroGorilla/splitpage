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

   Marks, all optional: b, i, u, s, hl (true); href (a safeHref URL); tag (a
   registry id, at most one per run); cmt (sorted comment ids). "\n" in text
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
  ["b", "i", "u", "s", "hl", "href", "tag", "cmt"].forEach(function (k) { if (m[k] !== undefined) out[k] = m[k]; });
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

  /* A tag is one unit in the editor, so a comment or a link covers all of
     it or none of it: across each stretch of one tag, cmt becomes the union
     and href the first one found. That is also what lets toHtml() nest a
     tag inside its comments and links without ever splitting it. */
  for (var i = 0; i < runs.length;) {
    var tag = runs[i].atom ? null : runs[i].marks.tag;
    if (!tag) { i++; continue; }
    var j = i;
    while (j < runs.length && !runs[j].atom && runs[j].marks.tag === tag) j++;
    if (j - i > 1) {
      var cmt = [], href = null;
      for (var k = i; k < j; k++) {
        (runs[k].marks.cmt || []).forEach(function (c) { if (cmt.indexOf(c) === -1) cmt.push(c); });
        if (!href && runs[k].marks.href) href = runs[k].marks.href;
      }
      cmt.sort();
      for (k = i; k < j; k++) {
        if (cmt.length) runs[k].marks.cmt = cmt.slice(); else delete runs[k].marks.cmt;
        if (href) runs[k].marks.href = href; else delete runs[k].marks.href;
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
   link, the tag, then highlight, bold, italic, underline, strike. Where two
   neighbouring runs share a prefix of that list the elements stay open
   across both, so a comment over bold and plain text is one span. The order
   never changes with the content, which is what makes the output canonical
   — and normalizeCell() guarantees no comment or link starts or ends inside
   a tag, so a tag is never split. */
function elementKeys(marks, isAtom) {
  var keys = [];
  (marks.cmt || []).forEach(function (id) { keys.push({ k: "cmt", v: id }); });
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

   opts.textHtml(text, esc), when given, writes each stretch of text
   instead of esc(text) — a stretch being what one text node of the output
   would hold (never a line break), the b-roll key's word included. It is
   how a reader that wants the cell's own markup around something of its
   own, the teleprompter's per-word spans, gets it without parsing HTML.
   What it returns goes in as it is, so it must escape what it writes. */
export function toHtml(cell, opts) {
  var t = buildTree(cell, opts);
  var textHtml = opts && opts.textHtml
    ? function (s) { return opts.textHtml(s, escText); }
    : escText;
  function render(node) {
    var out = "";
    node.kids.forEach(function (n) {
      if (n.text !== undefined) { out += textHtml(n.text); return; }
      if (n.br) { out += "<br>"; return; }
      if (n.atom) {
        out += '<span class="broll-key" data-broll-id="' + escAttr(n.atom.id) + '" contenteditable="false">' + textHtml(n.atom.text) + "</span>";
        return;
      }
      var inner = render(n);
      var e = n.el;
      if (e.k === "cmt") out += '<span class="cmt-anchor" data-cmt="' + escAttr(e.v) + '">' + inner + "</span>";
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
  return render(t.root);
}

/* ---- readers (what htmlToPlainText, htmlToMarkdown and htmlToRuns give
   for this cell's HTML, without parsing any) ---- */

export function toPlainText(cell) {
  var out = "";
  normalizeCell(cell).forEach(function (r) { out += r.text; });
  return out.replace(/\u00a0/g, " ").trim();
}

export function toMarkdown(cell, opts) {
  var t = buildTree(cell, opts);
  function md(node) {
    var out = "";
    node.kids.forEach(function (n) {
      if (n.text !== undefined) { out += n.text; return; }
      if (n.br) { out += "\n"; return; }
      if (n.atom) { out += n.atom.text; return; }
      var inner = md(n);
      var k = n.el.k;
      if (k === "b") out += "**" + inner + "**";
      else if (k === "i") out += "*" + inner + "*";
      else if (k === "u") out += "<u>" + inner + "</u>";
      else if (k === "s") out += "~~" + inner + "~~";
      else if (k === "hl") out += "<mark>" + inner + "</mark>";
      else if (k === "href") out += "[" + inner.replace(/([\]()])/g, "\\$1") + "](" + n.el.v + ")";
      else out += inner;
    });
    return out;
  }
  return md(t.root).replace(/\n{3,}/g, "\n\n").trim();
}

/* [{text, b, i, u, s, mark, href}], a line break as its own {text:"\n"}. */
export function toDocxRuns(cell, opts) {
  var t = buildTree(cell, opts);
  var runs = [];
  (function walk(node, fmt) {
    node.kids.forEach(function (n) {
      if (n.text !== undefined || n.atom) {
        var text = (n.atom ? n.atom.text : n.text).replace(/\u00a0/g, " ");
        if (text) runs.push({ text: text, b: fmt.b, i: fmt.i, u: fmt.u, s: fmt.s, mark: fmt.mark, href: fmt.href });
        return;
      }
      if (n.br) { runs.push({ text: "\n" }); return; }
      var k = n.el.k;
      walk(n, {
        b: fmt.b || k === "b", i: fmt.i || k === "i", u: fmt.u || k === "u", s: fmt.s || k === "s",
        mark: fmt.mark || k === "hl", href: k === "href" ? n.el.v : fmt.href
      });
    });
  })(t.root, { b: false, i: false, u: false, s: false, mark: false, href: null });
  return runs;
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
   comment or a link: those end where they end. Exported for the editor's
   toolbar state and its pending marks (05-render.js): what a character
   typed at pos would carry. */
export function typingMarks(cell, pos) {
  var m = marksAt(cell, pos);
  delete m.tag;
  delete m.cmt;
  delete m.href;
  return m;
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

/* name is b, i, u, s, hl (value true/false), href (a URL or null) or tag
   (an id or null). Comments have addComment/removeComment. */
export function setMark(cell, from, to, name, value) {
  var chars = explode(cell);
  from = clamp(cell, from);
  to = clamp(cell, to);
  var cache = new Map();
  for (var i = Math.min(from, to); i < Math.max(from, to); i++) {
    var c = chars[i];
    var base = c.atom ? c.atom.marks : c.marks;
    if (c.atom && name === "tag") continue;
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

/* glue (a string, e.g. "\n") goes between the two, unmarked. */
export function joinCells(a, b, glue) {
  var runs = normalizeCell(a).slice();
  if (glue) runs.push({ text: glue, marks: {} });
  return normalizeCell(runs.concat(normalizeCell(b)));
}

export function sameCell(a, b) {
  return JSON.stringify(normalizeCell(a)) === JSON.stringify(normalizeCell(b));
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
      in markConflicts.
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
