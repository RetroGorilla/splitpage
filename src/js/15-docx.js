import { S } from "./_state.js";
import { readPref, writePref } from "./00p-prefs.js";
import { DEFAULT_WPM, formatDuration, wordCount } from "./01-scene-status.js";
import { escapeHtml, makeId } from "./02-state.js";
import { bytesForSync, internDataUrl, queuePersist, rowImage, rowImageBytes } from "./02c-blobs.js";
import { morePictureRefs, pictureBytes, rowVideoLinks } from "./02d-gallery.js";
import { imageDims, sniffImageMime } from "../../shared/blob-policy.js";
import { inertBody, safeHref } from "./04-richtext.js";
import {
  OMIT_CLOSES,
  cellLength,
  cellOf,
  fromHtml,
  importCues,
  importDirections,
  setMark,
  flattenCues,
  toDocxRuns,
  toHtml,
  toPlainText,
  withoutCues
} from "./04c-doc-model.js";
import { pad2 } from "./05-render.js";
import {
  htmlToPlainText,
  strBytes,
  xmlEscape,
  zipRead,
  zipWrite
} from "./14-export.js";
import {
  PRINT_COLORS,
  STATUS_PRINT,
  TAG_STATUS_PRINT,
  breakdownGroups,
  brollSummaryText,
  commentNumbers,
  exportBrollScenes,
  exportComments,
  exportFacts,
  exportRuns,
  exportSummaryParts,
  sceneFacts
} from "./14b-export-kit.js";

/* The swatch in front of a breakdown category (#171): a black circle and a
   space, drawn in the category's colour. */
var DOCX_CATEGORY_DOT = "● ";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
var STYLES_XML;

/* The export's table style: named so Word lists it, and the id
   docxToRows finds the export's own script table by (exportTailStart). */
var EXPORT_TABLE_STYLE_ID = "SplitpageTable";

/* ================= .docx writing ================= */

export function dataUrlToBytes(dataUrl) {
  var comma = dataUrl.indexOf(",");
  var b64 = dataUrl.slice(comma + 1);
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* A picture's file extension inside a .docx, by the type its bytes are. */
var DOCX_IMAGE_EXT = { "image/jpeg": "jpeg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

/* read intrinsic pixel size straight out of the JPEG's SOF marker */
export function jpegSize(bytes) {
  var i = 2;
  while (i < bytes.length - 9) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    var marker = bytes[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    var len = (bytes[i + 2] << 8) | bytes[i + 3];
    i += 2 + len;
  }
  return { w: 800, h: 450 };
}

/* never divide by a bogus declared width */
export function safeAspect(dim) {
  var w = dim && dim.w > 0 ? dim.w : 800;
  var h = dim && dim.h > 0 ? dim.h : 450;
  return { w: w, h: h, ratio: h / w };
}

/* Column widths that actually fit what's in them, instead of a fixed guess
   — a Notes column full of real prose gets more room than a two-word
   Status column, whatever the content looks like this run. `mins` is a
   floor in the SAME character-count units as `longest`, not a twip width —
   mixing the two would make the floor win every time, since a sane twip
   minimum (hundreds) always dwarfs a column's actual character count.
   Each column's weight is its longest cell (header included, so a header
   alone always fits), clamped so one very long outlier can't starve every
   other column — at 40 characters, or `maxChars` for a column that wraps
   well (a list of scene numbers) — and widths are then totalWidth split
   proportionally to those weights, with the rounding remainder folded into
   the last column so the grid always sums to exactly totalWidth. */
function fitColumnWidths(totalWidth, minChars, headers, rowsCells, maxChars) {
  var weights = headers.map(function (h, i) {
    var longest = String(h).length;
    rowsCells.forEach(function (r) {
      var len = String(r[i] == null ? "" : r[i]).length;
      if (len > longest) longest = len;
    });
    return Math.max(minChars[i], Math.min(maxChars && maxChars[i] || 40, longest));
  });
  var sum = weights.reduce(function (a, b) { return a + b; }, 0);
  var widths = weights.map(function (w) { return Math.floor(totalWidth * w / sum); });
  var used = widths.reduce(function (a, b) { return a + b; }, 0);
  widths[widths.length - 1] += totalWidth - used;
  return widths;
}

/* A cell's runs come from the document model (#85), not a walk of its
   HTML: the same text in the same formats, except that neighbours in one
   format the stored markup happened to keep in separate elements
   (<strong>a</strong><strong>b</strong>) are one <w:r>, which Word draws
   exactly as it drew two. */
/* A stage direction (#167) is its own character style, bracketed by
   toDocxRuns: italic and grey where Word shows it, and the style name is
   how docxToRows knows one again when the file is opened. The italic and
   the colour are also written on the run itself, for a viewer that ignores
   character styles. opts.directions "omit" leaves them out (a narration
   export without them). */
var DIRECTION_STYLE = "SplitpageDirection";
var DIRECTION_COLOR = "6B6A65";

/* The runs without their directions, one space kept where one stood
   between two words — toPlainText's "omit", over runs. */
function omitDirectionRuns(runs) {
  var out = [], gap = false;
  runs.forEach(function (r) {
    if (r.dir) { gap = true; return; }
    if (r.text === "\n") { gap = false; out.push(r); return; }
    if (gap) {
      var last = out[out.length - 1];
      var t = r.text;
      if (OMIT_CLOSES.test(t)) {
        if (last && last.text !== "\n") out[out.length - 1] = Object.assign({}, last, { text: last.text.replace(/[ \t]+$/, "") });
      } else if (!last || /\s$/.test(last.text)) {
        t = t.replace(/^[ \t]+/, "");
      } else if (!/^\s/.test(t)) {
        t = " " + t;
      }
      if (!t) return;
      r = Object.assign({}, r, { text: t });
    }
    gap = false;
    out.push(r);
  });
  return out;
}

/* A sound cue line (#219): its own character style, small and in the
   Music/SFX colour, as the editor shows it — written on the run too, like
   a direction's. It is its own line already (a cue is a whole line). A
   narration export leaves cues out (opts.cues "omit"). */
var CUE_STYLE = "SplitpageCue";
var CUE_COLOR = "AB413E";
var CUE_SIZE = 18;

/* What the script export draws round the words, as the app draws it
   (#169) — each its own character style, because the style is how
   docxToRows tells the drawing from the words when the file comes back:

   - a production tag: the words in the category's colour, underlined in
     it (SplitpageTag). Read back as its plain words.
   - an open comment's number after its words: a small amber number,
     raised and boxed like the app's marker (SplitpageMarker). Read back as
     nothing at all. The words under a comment get a dotted underline,
     amber while it is open and faint once resolved (the app's own two).
   - the b-roll key: its own text, small, bold and teal in a teal box —
     the app's chip (SplitpageBroll). Read back as that text, not bold.

   An underline the export draws (a tag's, a comment's) carries its own
   colour; an underline the writer typed never does (it takes the text's
   colour). That is the rule the reader keeps: in a Splitpage export, a
   coloured underline is drawing, not formatting (colouredUnderline). A
   run can be a tag under a comment: the tag keeps its colour, the
   comment takes the underline. */
var TAG_STYLE = "SplitpageTag";
var MARKER_STYLE = "SplitpageMarker";
var BROLL_STYLE = "SplitpageBroll";
var MARKER_SIZE = 15;
var BROLL_SIZE = 16;
/* A thin space either side of a boxed run's words: a character border
   hugs its glyphs, and these are the box's padding. */
var CHIP_PAD = String.fromCharCode(0x2009);
var CHIP_PAD_ENDS = new RegExp("^" + CHIP_PAD + "+|" + CHIP_PAD + "+$", "g");
var NBSP = String.fromCharCode(0xA0);

/* rPr children in the order the schema (CT_RPr) lists them. */
function rPrXml(p) {
  var out = "";
  if (p.style) out += '<w:rStyle w:val="' + p.style + '"/>';
  if (p.b) out += "<w:b/>";
  if (p.i) out += "<w:i/>";
  if (p.s) out += "<w:strike/>";
  if (p.color) out += '<w:color w:val="' + p.color + '"/>';
  if (p.position) out += '<w:position w:val="' + p.position + '"/>';
  if (p.sz) out += '<w:sz w:val="' + p.sz + '"/>';
  if (p.mark) out += '<w:highlight w:val="yellow"/>';
  if (p.u) out += '<w:u w:val="' + p.u + '"' + (p.uColor ? ' w:color="' + p.uColor + '"' : "") + "/>";
  if (p.bdr) out += '<w:bdr w:val="single" w:sz="4" w:space="0" w:color="' + p.bdr + '"/>';
  if (p.shd) out += '<w:shd w:val="clear" w:color="auto" w:fill="' + p.shd + '"/>';
  if (p.vertAlign) out += '<w:vertAlign w:val="' + p.vertAlign + '"/>';
  return out ? "<w:rPr>" + out + "</w:rPr>" : "";
}

function textRunXml(text, p) {
  return "<w:r>" + rPrXml(p || {}) + '<w:t xml:space="preserve">' + xmlEscape(text) + "</w:t></w:r>";
}

/* An open thread's number after its words, one run per number, boxed and
   padded like the chip. The run is dropped whole on the way back in, so
   what is in it never matters. */
function markerRunsXml(nums) {
  return nums.map(function (n) {
    return textRunXml(CHIP_PAD + n + CHIP_PAD, {
      style: MARKER_STYLE, b: true, color: PRINT_COLORS.audio, sz: MARKER_SIZE, position: 6, bdr: PRINT_COLORS.audio
    });
  }).join("");
}

/* A cell as one paragraph, lines joined by <w:br/>. opts:
     cues / directions  "omit" — the narration's options
     annotate           {nums, open} — the script export: draw tags, the
                        comments' underlines and markers and the b-roll
                        key (exportRuns); nums is commentNumbers(), open
                        commentOpenness() (each comment's id: open or not)
     sz                 the column's size, for runs without their own
     pPr                the paragraph's properties, as XML
     lead               a run to start the paragraph with */
function docxRunsXml(html, rels, opts) {
  opts = opts || {};
  var ann = opts.annotate;
  var runs;
  if (ann) {
    runs = exportRuns(html, ann.nums);
  } else {
    var cell = cellOf(html);
    if (opts.cues === "omit") cell = withoutCues(cell);
    runs = toDocxRuns(cell);
  }
  if (opts.directions === "omit") runs = omitDirectionRuns(runs);
  var out = "<w:p>" + (opts.pPr ? "<w:pPr>" + opts.pPr + "</w:pPr>" : "") + (opts.lead || "");
  runs.forEach(function (r) {
    if (r.text === "\n") { out += "<w:r><w:br/></w:r>"; return; }
    var tag = ann && r.tag;
    var p = { b: r.b, i: r.i || r.dir, s: r.s, mark: r.mark };
    var text = r.text;
    if (ann && r.broll) {
      p.style = BROLL_STYLE;
      p.b = true;
      p.color = PRINT_COLORS.broll;
      p.sz = BROLL_SIZE;
      p.bdr = PRINT_COLORS.broll;
      /* the chip's padding inside its box, which the reader takes off */
      text = CHIP_PAD + text + CHIP_PAD;
    } else if (r.dir) {
      p.style = DIRECTION_STYLE;
      if (!r.href) p.color = DIRECTION_COLOR;
    } else if (r.cue) {
      p.style = CUE_STYLE;
      if (!r.href) p.color = CUE_COLOR;
    } else if (tag) {
      p.style = TAG_STYLE;
      if (!r.href && tag.color) p.color = tag.color;
    }
    if (r.href) p.color = "1155CC";
    if (r.cue) p.sz = CUE_SIZE;
    else if (!p.sz && opts.sz) p.sz = opts.sz;
    var cmt = ann && r.cmt ? r.cmt.filter(function (id) { return id in ann.open; }) : [];
    if (r.u || r.href) {
      p.u = "single";
    } else if (cmt.length) {
      p.u = "dotted";
      p.uColor = cmt.some(function (id) { return ann.open[id]; }) ? PRINT_COLORS.audio : PRINT_COLORS.faint;
    } else if (tag && tag.color) {
      p.u = "single";
      p.uColor = tag.color;
    }
    var run = textRunXml(text, p);
    if (r.href) out += '<w:hyperlink r:id="' + rels.addLink(r.href) + '">' + run + "</w:hyperlink>";
    else out += run;
    if (ann && r.markers) out += markerRunsXml(r.markers);
  });
  return out + "</w:p>";
}

/* One inline picture as a run: `img` is what rels.addImage returned, `id`
   the drawing's id (unique in the document), cx/cy its size in EMU. */
function docxDrawingRun(img, id, cx, cy) {
  return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="' + id + '" name="' + img.name + '"/><wp:cNvGraphicFramePr/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + id + '" name="' + img.name + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="' + img.rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

/* A scene's video links (#135) as one small paragraph under its pictures:
   "▶ " and each link — a web address as a hyperlink showing it, without
   its "https://www." as the app shows it ("youtube.com/watch?v=…", which
   fits the column where the whole address broke over two lines), a video
   file by its name. docxVideoLinksOf (below) is how docxToRows knows it
   again. */
var VIDEO_LINKS_MARK = "▶ ";

function shortHref(href) {
  return String(href).replace(/^https?:\/\/(www\.)?/i, "");
}

function docxVideoLinksXml(links, rels) {
  if (!links.length) return "";
  var rPr = '<w:rPr><w:sz w:val="18"/></w:rPr>';
  var out = '<w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r>' + rPr + '<w:t xml:space="preserve">' + VIDEO_LINKS_MARK + '</w:t></w:r>';
  links.forEach(function (l, i) {
    if (i) out += '<w:r>' + rPr + '<w:t xml:space="preserve">  ·  </w:t></w:r>';
    if (l.href) {
      out += '<w:hyperlink r:id="' + rels.addLink(l.href) + '"><w:r><w:rPr><w:color w:val="1155CC"/><w:sz w:val="18"/><w:u w:val="single"/></w:rPr>' +
        '<w:t xml:space="preserve">' + xmlEscape(shortHref(l.href)) + '</w:t></w:r></w:hyperlink>';
    } else {
      out += '<w:r>' + rPr + '<w:t xml:space="preserve">' + xmlEscape(l.name + " (video file)") + '</w:t></w:r>';
    }
  });
  return out + '</w:p>';
}

/* A table cell's paragraph written by docxVideoLinksXml, read back as the
   links it names — null for any other paragraph. Only "▶ " followed by
   nothing but links and file names separated by " · " counts, each link
   showing its own address, whole (an export before #169) or without its
   "https://www." (since); a line of the user's own that happens to start
   with the mark keeps its words. */
function docxVideoLinksOf(pEl, linkMap) {
  var html = docxParaToHtml(pEl, linkMap);
  var text = htmlToPlainText(html);
  if (text.indexOf(VIDEO_LINKS_MARK) !== 0) return null;
  var hrefs = [];
  inertBody(html).querySelectorAll("a[href]").forEach(function (a) { hrefs.push(a.getAttribute("href")); });
  var parts = text.slice(VIDEO_LINKS_MARK.length).split("  ·  ");
  var links = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    var file = /^(.+) \(video file\)$/.exec(p);
    if (file) { links.push({ name: file[1] }); continue; }
    var at = hrefs.findIndex(function (h) { return h === p || shortHref(h) === p; });
    if (at === -1) return null;
    links.push({ href: hrefs.splice(at, 1)[0] });
  }
  return links.length ? links : null;
}

/* One table cell. opts: span (columns it covers), mar {top, bottom,
   left, right} in twips (each defaults to the table style's), bottom (a
   rule under the cell: {sz, color}). */
function docxCellXml(inner, widthDxa, opts) {
  opts = opts || {};
  var mar = opts.mar || {};
  var marXml = ["top", "left", "bottom", "right"].map(function (side) {
    return mar[side] === undefined ? "" : '<w:' + side + ' w:w="' + mar[side] + '" w:type="dxa"/>';
  }).join("");
  return '<w:tc><w:tcPr><w:tcW w:w="' + widthDxa + '" w:type="dxa"/>' +
    (opts.span ? '<w:gridSpan w:val="' + opts.span + '"/>' : "") +
    (opts.bottom ? '<w:tcBorders><w:bottom w:val="single" w:sz="' + opts.bottom.sz + '" w:space="0" w:color="' + opts.bottom.color + '"/></w:tcBorders>' : "") +
    (marXml ? "<w:tcMar>" + marXml + "</w:tcMar>" : "") + "</w:tcPr>" +
    (inner || cellParaXml("")) + "</w:tc>";
}

/* A cell's paragraph: no space round it unless asked (the cell's margins
   are the gap). o: keepNext, before, after (twips), jc. The pPr children
   in the schema's order, as everywhere in this file. */
function cellParaXml(runs, o) {
  o = o || {};
  return "<w:p><w:pPr>" + (o.keepNext ? "<w:keepNext/>" : "") +
    '<w:spacing w:before="' + (o.before || 0) + '" w:after="' + (o.after || 0) + '"/>' +
    (o.jc ? '<w:jc w:val="' + o.jc + '"/>' : "") + "</w:pPr>" + runs + "</w:p>";
}

/* A left-indented paragraph for plain (already-unformatted) multi-line
   text — comment bodies and quotes, not the rich row content that
   docxRunsXml() handles. Each source line becomes its own <w:t>, joined
   by <w:br/> so line breaks survive instead of collapsing to one line. */
function docxLineBreakParagraph(text, indentDxa, rPr) {
  var runXml = String(text || "").split(/\r\n|\r|\n/).map(function (line, i) {
    return (i > 0 ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + xmlEscape(line) + '</w:t>';
  }).join('');
  return '<w:p><w:pPr><w:spacing w:after="120"/><w:ind w:left="' + indentDxa + '"/></w:pPr>' +
    '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + runXml + '</w:r></w:p>';
}

/* ---- the script table (#169, on paper) ----

   Four columns, as the app lays a scene out: its gutter (the number, the
   timecode it starts at, its status), Visual, Audio and its read time.
   Only Visual and Audio are the script. The header row's "Visual" and
   "Audio" are what mapTableColumns finds them by; "Scene" and "Read" match
   neither, so those two columns are read past, as the old "No." column
   always was. Rules across only, no grid: a stronger one under the header
   (which repeats on every page), a hairline between scenes. Twentieths of
   a point, inside 1080-twip margins on a Letter page (12240 wide): 10080
   usable. The gutter's left margin and the read time's right one are
   nothing, so the scene number lines up under the title and the read
   times with the right margin. */
var PAGE_W = 10080;
var COL_SCENE = 1080, COL_VISUAL = 3880, COL_AUDIO = 4400, COL_READ = 720;
/* The Visual column a point smaller than the Audio, as the app sets what
   is seen smaller than what is said; the Audio is the body's 11pt. */
var VISUAL_SZ = 20;
var HEAD_SZ = 17;
var GUTTER_SZ = 16;

/* A status's lamp as Word can print it — a real character, where the PDF
   has to draw one (STATUS_PRINT / TAG_STATUS_PRINT say which lamp). A
   returned item gets the return arrow the Production panel shows. */
var LAMP_CHARS = { outline: "○", fill: "●", half: "◐", check: "✓", ring: "↩" };

function lampRunsXml(status, label, sz) {
  return textRunXml(LAMP_CHARS[status.lamp] || LAMP_CHARS.outline, { color: status.color, sz: sz }) +
    textRunXml(" " + label, { color: status.lamp === "outline" ? PRINT_COLORS.faint : PRINT_COLORS.dim, sz: sz });
}

/* The scene's gutter: the number, bold and larger; the timecode it starts
   at, small and faint; the status, its lamp and its word. */
function sceneCellXml(f) {
  var st = STATUS_PRINT[f.status.id] || STATUS_PRINT.todo;
  return docxCellXml(
    cellParaXml(textRunXml(f.number, { b: true, sz: 26 })) +
    cellParaXml(textRunXml(f.start, { color: PRINT_COLORS.faint, sz: GUTTER_SZ }), { after: 80 }) +
    cellParaXml(lampRunsXml(st, f.status.label, GUTTER_SZ)),
    COL_SCENE, { mar: { left: 0 } });
}

/* The read time at the right edge — boxed when it was set by hand (#179),
   as the app boxes it. */
function readCellXml(f) {
  var p = { color: PRINT_COLORS.dim, sz: 18 };
  if (f.readSet) p.bdr = PRINT_COLORS.borderStrong;
  return docxCellXml(cellParaXml(textRunXml(f.readSet ? CHIP_PAD + f.read + CHIP_PAD : f.read, p), { jc: "right" }),
    COL_READ, { mar: { right: 0 } });
}

/* A header row's cell: a small bold word over the stronger rule. */
var HEAD_RULE_SZ = 8;

function headCellXml(text, width, color, opts) {
  opts = opts || {};
  return docxCellXml(cellParaXml(textRunXml(text, { b: true, color: color || PRINT_COLORS.dim, sz: HEAD_SZ }), { jc: opts.jc }),
    width, { mar: Object.assign({ top: 0, bottom: 80 }, opts.mar), bottom: { sz: HEAD_RULE_SZ, color: PRINT_COLORS.borderStrong } });
}

/* A scene short enough to sit whole on a page is never split across two
   (w:cantSplit) — three lines at the foot of one page and the rest on the
   next read badly. A longer one is left free to break (never leaving a
   lone line either side: widow control, styles.xml): kept whole, it
   would leave a third of a page empty behind it as often as not, and one
   taller than a page could not be kept whole anyway. Lines are estimated
   from the words (about 40 characters to a line in either column) and a
   picture counted as eight. */
var KEEP_WHOLE_LINES = 10;

function sceneLineEstimate(row) {
  function lines(html) {
    return toPlainText(cellOf(html)).split("\n").reduce(function (n, l) { return n + Math.max(1, Math.ceil(l.length / 40)); }, 0);
  }
  var pics = (rowImage(row) ? 1 : 0) + morePictureRefs(row).length;
  return Math.max(lines(row.visualText) + pics * 8, lines(row.audioText));
}

/* Which comments are open, by id: true open, false resolved — for the
   colour of the underline under their words. */
function commentOpenness() {
  var out = Object.create(null);
  (S.state.comments || []).forEach(function (c) { if (c && c.id) out[c.id] = !c.resolved; });
  return out;
}

/* ---- the document's own paragraphs ---- */

var META_STYLE = "SplitpageMeta";

/* The line under the title, and under each appendix heading: small and
   dim, in a paragraph style only this export writes, which is how
   docxToRows knows to skip it. */
function metaParaXml(text) {
  return '<w:p><w:pPr><w:pStyle w:val="' + META_STYLE + '"/></w:pPr>' + textRunXml(text) + "</w:p>";
}

function titleParaXml(title) {
  return '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>' + textRunXml(title) + "</w:p>";
}

/* An appendix heading. The first of them starts a page of its own, so the
   script and what follows it are not run together. */
function headingParaXml(text, newPage) {
  return '<w:p><w:pPr><w:pStyle w:val="Heading1"/>' + (newPage ? "<w:pageBreakBefore/>" : "") + "</w:pPr>" +
    textRunXml(text) + "</w:p>";
}

function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

/* A table in the export's own style (SplitpageTable, styles.xml — also
   how docxToRows knows a Splitpage export's script table: exportTailStart)
   at its columns' exact widths. The borders are written on the table too,
   for a viewer that ignores table styles. */
function tableXml(cols, rowsXml) {
  var width = cols.reduce(function (a, b) { return a + b; }, 0);
  return '<w:tbl><w:tblPr><w:tblStyle w:val="' + EXPORT_TABLE_STYLE_ID + '"/><w:tblW w:w="' + width + '" w:type="dxa"/>' +
    tableBordersXml() + '<w:tblLayout w:type="fixed"/>' +
    '<w:tblLook w:val="0620" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>' +
    "</w:tblPr><w:tblGrid>" + cols.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join("") + "</w:tblGrid>" +
    rowsXml + "</w:tbl>";
}

/* Rules across only: none down the sides or between the columns, a
   hairline between rows and under the last. */
function tableBordersXml() {
  var hair = 'w:val="single" w:sz="4" w:space="0" w:color="' + PRINT_COLORS.border + '"';
  return "<w:tblBorders>" +
    '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom ' + hair + '/><w:right w:val="nil"/>' +
    '<w:insideH ' + hair + '/><w:insideV w:val="nil"/></w:tblBorders>';
}

/* The breakdown table's column heads — isBreakdownHeader (below) knows
   them, and the old export's, so either table is never read as script. */
var BREAKDOWN_HEAD_WORDS = ["Item", "Status", "Scenes", "Assigned to", "Notes"];

/* "Flagged" for a reshoot, in the app's red (--danger). */
var FLAG_COLOR = "C4302A";
var SHOT_INDENT = 400;

export function buildDocx() {
  var media = [];
  var links = [];
  var rels = {
    addLink: function (href) {
      links.push(href);
      return "rIdL" + links.length;
    },
    /* Each picture keeps the type it is, named and declared as that type
       (#82): a PNG used to go in as "imageN.jpeg" under image/jpeg. */
    addImage: function (bytes, mime) {
      var ext = DOCX_IMAGE_EXT[mime] || "jpeg";
      media.push({ bytes: bytes, ext: ext });
      return { rid: "rIdM" + media.length, name: "image" + media.length + "." + ext };
    }
  };

  /* sha -> the picture's media part and pixel size, or null when its bytes
     are not here: each ref'd row picture, and each comment picture once
     written, so a comment showing one of those again reuses its part */
  var pictureParts = {};

  /* the title, then one line of what the document is: "30 scenes · 9:44
     running time · Target 9:00 · 0:44 over · 13 of 30 shot · 26
     September 2026" */
  var facts = exportFacts();
  var body = titleParaXml(facts.title) + metaParaXml(exportSummaryParts(facts).concat(facts.date).join(" · "));

  var rowsXml = "";
  /* header row, repeated on every page: the words in the column's own
     colour, as the app heads its columns */
  rowsXml += "<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>" +
    headCellXml("Scene", COL_SCENE, null, { mar: { left: 0 } }) +
    headCellXml("Visual", COL_VISUAL, PRINT_COLORS.visual) +
    headCellXml("Audio", COL_AUDIO, PRINT_COLORS.audio) +
    headCellXml("Read", COL_READ, null, { jc: "right", mar: { right: 0 } }) +
    "</w:tr>";

  var scenes = sceneFacts();
  var ann = { nums: commentNumbers(), open: commentOpenness() };
  /* a picture at most the Visual column's width inside its margins
     (twips to EMU is x635) */
  var maxW = (COL_VISUAL - 200) * 635;
  S.state.rows.forEach(function (row, idx) {
    var visual = "";
    /* A ref'd picture's bytes are in memory by now: buildFileData
       (18-local-files.js) awaits ensureBytes before building. One that
       nobody had is left out, as an unreadable one always was. */
    var pic = rowImage(row) && rowImageBytes(row);
    if (pic) {
      try {
        var bytes = pic.bytes;
        var dim = safeAspect(rowImage(row).ref ? { w: pic.width, h: pic.height } : jpegSize(bytes));
        var img = rels.addImage(bytes, pic.mime);
        var cx = Math.round(Math.min(maxW, dim.w * 9525));
        var cy = Math.round(cx * dim.ratio);
        visual += cellParaXml(docxDrawingRun(img, media.length, cx, cy), { after: 80 });
        if (rowImage(row).ref) pictureParts[rowImage(row).ref.sha256] = { rid: img.rid, name: img.name, w: dim.w, h: dim.h };
      } catch (e) { /* unreadable image — skip it rather than break the export */ }
    }
    /* the rest of the scene's gallery (#135), each picture under the one
       before it, and its video links as one paragraph of "▶ " links —
       what docxToRows reads back into the gallery */
    morePictureRefs(row).forEach(function (ref) {
      var more = pictureBytes(ref);
      if (!more) return;
      try {
        var mdim = safeAspect({ w: more.width, h: more.height });
        var mimg = rels.addImage(more.bytes, more.mime);
        var mcx = Math.round(Math.min(maxW, mdim.w * 9525));
        visual += cellParaXml(docxDrawingRun(mimg, media.length, mcx, Math.round(mcx * mdim.ratio)), { after: 80 });
        pictureParts[ref.sha256] = { rid: mimg.rid, name: mimg.name, w: mdim.w, h: mdim.h };
      } catch (e) { /* as above */ }
    });
    visual += docxVideoLinksXml(rowVideoLinks(row), rels);
    visual += docxRunsXml(row.visualText, rels, { annotate: ann, sz: VISUAL_SZ, pPr: '<w:spacing w:after="0"/>' });
    var audio = docxRunsXml(row.audioText, rels, { annotate: ann, pPr: '<w:spacing w:after="0"/>' });
    rowsXml += "<w:tr>" + (sceneLineEstimate(row) <= KEEP_WHOLE_LINES ? "<w:trPr><w:cantSplit/></w:trPr>" : "") +
      sceneCellXml(scenes[idx]) + docxCellXml(visual, COL_VISUAL) + docxCellXml(audio, COL_AUDIO) +
      readCellXml(scenes[idx]) + "</w:tr>";
  });

  body += tableXml([COL_SCENE, COL_VISUAL, COL_AUDIO, COL_READ], rowsXml);
  /* the first appendix section starts a page of its own */
  var appendix = 0;
  /* ---- the production breakdown, by category (#169) ----

     As the Production panel groups it: one table, its column heads
     repeated on every page, and under them a row per category spanning
     the table — a dot and the category's plural in its colour (#171), a
     faint count — kept with the first item under it, then the category's
     items. An item's row never splits across a page (the old export
     broke "Camera shop" over one). The b-roll shots that need an item
     (#149) are listed under its notes. */
  var groups = breakdownGroups();
  if (groups.length) {
    var itemCount = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    body += headingParaXml("Production breakdown", !appendix++) +
      metaParaXml(plural(itemCount, "tracked item") + " · " + plural(groups.length, "category", "categories"));

    var bHeaders = BREAKDOWN_HEAD_WORDS;
    var items = [];
    groups.forEach(function (g) { items = items.concat(g.items); });
    /* floors and caps in characters, not twips — see fitColumnWidths
       above. A narrow column needs a couple more than its words for the
       cell's margins: the status's floor fits "● Sourcing" on one line,
       the owner's "Assigned to". The scenes wrap well and stop at 16. */
    var bMins = [12, 13, 10, 13, 14];
    var bMaxes = [28, 13, 16, 18, 40];
    var bCellRows = items.map(function (r) {
      return [r.name, "● " + r.statusLabel, r.scenes.join(", "), r.owner,
        r.notes + (r.broll.length ? " B-roll: " + r.broll.join("; ") : "")];
    });
    /* columns sized to what's actually in them (fitColumnWidths above),
       not a fixed guess a long Notes column would just wrap badly under */
    var bCols = fitColumnWidths(PAGE_W, bMins, bHeaders, bCellRows, bMaxes);
    var BD_SZ = 19;
    var edge = function (i) {
      return i === 0 ? { left: 0 } : i === bHeaders.length - 1 ? { right: 0 } : {};
    };

    var bRows = "<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>" +
      bHeaders.map(function (h, i) { return headCellXml(h, bCols[i], null, { mar: edge(i) }); }).join("") + "</w:tr>";

    groups.forEach(function (g) {
      var color = g.color || PRINT_COLORS.text;
      /* keepNext holds the category's head to the item under it */
      bRows += "<w:tr><w:trPr><w:cantSplit/></w:trPr>" +
        docxCellXml(cellParaXml(
          textRunXml(DOCX_CATEGORY_DOT, { color: color, sz: 20 }) +
          textRunXml(g.label, { b: true, color: color, sz: 20 }) +
          textRunXml("  " + g.items.length, { color: PRINT_COLORS.faint, sz: 18 }), { keepNext: true }),
        PAGE_W, { span: bHeaders.length, mar: { top: 240, left: 0, right: 0, bottom: 80 } }) + "</w:tr>";
      g.items.forEach(function (r) {
        var st = TAG_STATUS_PRINT[r.status] || TAG_STATUS_PRINT.needed;
        var notes = r.notes ? cellParaXml(textRunXml(r.notes, { color: PRINT_COLORS.dim, sz: BD_SZ })) : "";
        r.broll.forEach(function (shot) {
          notes += cellParaXml(textRunXml("B-roll ", { b: true, color: PRINT_COLORS.broll, sz: 16 }) +
            textRunXml(shot, { color: PRINT_COLORS.dim, sz: 17 }), { before: notes ? 40 : 0 });
        });
        var cells = [
          cellParaXml(textRunXml(r.name, { sz: BD_SZ })),
          cellParaXml(lampRunsXml(st, r.statusLabel, BD_SZ)),
          cellParaXml(textRunXml(r.scenes.join(", "), { color: PRINT_COLORS.dim, sz: BD_SZ })),
          cellParaXml(textRunXml(r.owner, { color: PRINT_COLORS.dim, sz: BD_SZ })),
          notes
        ];
        /* a list, set a little closer than the script's scenes */
        bRows += "<w:tr><w:trPr><w:cantSplit/></w:trPr>" + cells.map(function (inner, i) {
          return docxCellXml(inner, bCols[i], { mar: Object.assign({ top: 70, bottom: 90 }, edge(i)) });
        }).join("") + "</w:tr>";
      });
    });

    body += tableXml(bCols, bRows);
  }

  /* ---- the b-roll shot list (#149), by scene ----

     As the B-roll panel lists it: each scene's head — "Scene 04", the
     timecode it starts at, and how many of its shots are shot at the right
     — then each shot with its box, ticked in teal once shot, and under it
     where, who, the props it needs and whether it is flagged for a
     reshoot. Read without writing (exportBrollScenes). */
  var shots = exportBrollScenes();
  if (shots.length) {
    body += headingParaXml("B-roll shot list", !appendix++) + metaParaXml(brollSummaryText(shots));
    shots.forEach(function (g) {
      body += '<w:p><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="3" w:color="' + PRINT_COLORS.border + '"/></w:pBdr>' +
        '<w:tabs><w:tab w:val="right" w:pos="' + PAGE_W + '"/></w:tabs><w:spacing w:before="280" w:after="100"/></w:pPr>' +
        textRunXml(g.label, { b: true, sz: 20 }) +
        (g.start ? textRunXml("  " + g.start, { color: PRINT_COLORS.faint, sz: 18 }) : "") +
        "<w:r><w:tab/></w:r>" +
        textRunXml(g.done + "/" + g.total + " shot", { color: PRINT_COLORS.faint, sz: 18 }) + "</w:p>";
      g.items.forEach(function (it, k) {
        var details = [];
        if (it.location) details.push(textRunXml(it.location, { color: PRINT_COLORS.dim, sz: 17 }));
        if (it.owner) details.push(textRunXml(it.owner, { color: PRINT_COLORS.dim, sz: 17 }));
        if (it.propsWithStatus.length) details.push(textRunXml(it.propsWithStatus.join(", "), { color: PRINT_COLORS.dim, sz: 17 }));
        if (it.flagged) details.push(textRunXml("Flagged", { b: true, color: FLAG_COLOR, sz: 17 }));
        var more = details.length || it.note;
        body += '<w:p><w:pPr>' + (more ? "<w:keepNext/>" : "") + '<w:spacing w:before="' + (k ? 120 : 0) + '" w:after="0"/>' +
          '<w:ind w:left="' + SHOT_INDENT + '" w:hanging="' + SHOT_INDENT + '"/></w:pPr>' +
          textRunXml(it.shot ? "☑" : "☐", { color: it.shot ? PRINT_COLORS.broll : PRINT_COLORS.faint, sz: 22 }) +
          "<w:r><w:tab/></w:r>" + textRunXml(it.name, { sz: 20 }) + "</w:p>";
        var sep = textRunXml("  ·  ", { color: PRINT_COLORS.faint, sz: 17 });
        if (details.length) {
          body += '<w:p><w:pPr>' + (it.note ? "<w:keepNext/>" : "") + '<w:spacing w:before="20" w:after="0"/><w:ind w:left="' + SHOT_INDENT + '"/></w:pPr>' +
            details.join(sep) + "</w:p>";
        }
        if (it.note) {
          body += '<w:p><w:pPr><w:spacing w:before="20" w:after="0"/><w:ind w:left="' + SHOT_INDENT + '"/></w:pPr>' +
            textRunXml(it.note, { i: true, color: PRINT_COLORS.dim, sz: 17 }) + "</w:p>";
        }
      });
    });
  }

  /* ---- the comments, numbered as the script's markers are ---- */
  var comments = exportComments({ pieces: true });
  if (comments.length) {
    var openCount = comments.filter(function (c) { return !c.resolved; }).length;
    body += headingParaXml("Comments", !appendix) +
      metaParaXml([openCount ? openCount + " open" : "", comments.length - openCount ? (comments.length - openCount) + " resolved" : ""]
        .filter(Boolean).join(" · "));

    /* Pictures in comments and replies (#82 P6 keeps them in the body as
       <img data-blob>; commentEntries' pieces name them by sha). Each is a
       paragraph of its own at its body's indent, in the order the body has
       it — sized as the PDF sizes them: at most CIMG_MAXW of what is left
       of the text column beside the indent and CIMG_MAXH tall, aspect kept,
       and never larger than its own pixels at 96 dpi, so a small picture
       stays small. Each is embedded as the type it is, like a row's; the
       same picture twice — or one a row already shows — is one media
       part (pictureParts). One whose bytes are not here
       (buildFileData has already fetched every one it could) is an italic
       "[image unavailable]" in its place. */
    var CIMG_MAXW = 0.6, CIMG_MAXH = 3302000; /* 260pt, in EMU */
    var drawingId = media.length;

    function commentPictureXml(sha, indentDxa) {
      var img = pictureParts[sha];
      if (img === undefined) {
        img = null;
        var bytes = bytesForSync(sha);
        var mime = bytes && sniffImageMime(bytes);
        var dims = mime && imageDims(bytes);
        if (dims && dims.width > 0 && dims.height > 0) {
          img = rels.addImage(bytes, mime);
          img.w = dims.width;
          img.h = dims.height;
        }
        pictureParts[sha] = img;
      }
      if (!img) return docxLineBreakParagraph("[image unavailable]", indentDxa, "<w:i/>");
      /* twips to EMU is x635 */
      var scale = Math.min(9525, (10080 - indentDxa) * 635 * CIMG_MAXW / img.w, CIMG_MAXH / img.h);
      var cx = Math.max(1, Math.round(img.w * scale));
      var cy = Math.max(1, Math.round(img.h * scale));
      return '<w:p><w:pPr><w:spacing w:after="120"/><w:ind w:left="' + indentDxa + '"/></w:pPr>' +
        docxDrawingRun(img, ++drawingId, cx, cy) + '</w:p>';
    }

    /* A comment's or reply's body in order. One with no picture is the one
       paragraph it always was, "(empty)" and all. */
    function commentBodyXml(entry, indentDxa) {
      var pieces = entry.pieces || [];
      if (!pieces.some(function (p) { return p.image; })) {
        return docxLineBreakParagraph(entry.body || '(empty)', indentDxa, '');
      }
      return pieces.map(function (p) {
        return p.image ? commentPictureXml(p.image, indentDxa) : docxLineBreakParagraph(p.text, indentDxa, '');
      }).join("");
    }

    /* Each thread headed by its number — white on a filled amber badge,
       the number its marker in the script carries — then where it is
       ("Scene 03 · Audio"), who wrote it and when; a resolved one has no
       number and says who resolved it. The words it is about as a quote
       under an amber rule (faint once resolved), the body, and each reply
       indented under its author. */
    comments.forEach(function (c) {
      var head = "";
      if (c.number) {
        head += textRunXml(NBSP + c.number + NBSP, { b: true, color: "FFFFFF", sz: 18, shd: PRINT_COLORS.audio }) +
          textRunXml("  ");
      }
      head += textRunXml(c.where, { b: true, color: c.resolved ? PRINT_COLORS.dim : PRINT_COLORS.text }) +
        textRunXml("   " + c.author, { color: PRINT_COLORS.dim, sz: 19 }) +
        (c.when ? textRunXml(" · " + c.when, { color: PRINT_COLORS.faint, sz: 19 }) : "");
      if (c.resolved) head += textRunXml("  ·  Resolved" + (c.resolvedBy ? " by " + c.resolvedBy : ""), { color: PRINT_COLORS.faint, sz: 19 });
      if (c.assignee) head += textRunXml("  ·  Assigned to " + c.assignee, { color: PRINT_COLORS.dim, sz: 19 });
      body += '<w:p><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="100"/></w:pPr>' + head + "</w:p>";
      if (c.quoted) {
        body += '<w:p><w:pPr><w:keepNext/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="' +
          (c.resolved ? PRINT_COLORS.borderStrong : PRINT_COLORS.audio) + '"/></w:pBdr>' +
          '<w:spacing w:after="120"/><w:ind w:left="' + (360 + 180) + '"/></w:pPr>' +
          textRunXml("“" + c.quoted + "”", { i: true, color: PRINT_COLORS.dim }) + "</w:p>";
      }
      body += commentBodyXml(c, 360);
      c.replies.forEach(function (rp) {
        body += '<w:p><w:pPr><w:keepNext/><w:spacing w:before="60" w:after="20"/><w:ind w:left="720"/></w:pPr>' +
          textRunXml("↳ " + rp.author, { b: true, sz: 18 }) +
          (rp.when ? textRunXml(" · " + rp.when, { color: PRINT_COLORS.faint, sz: 18 }) : "") + "</w:p>";
        body += commentBodyXml(rp, 720);
      });
    });
  }

  return packDocx(body, links, media);
}

/* Everything below the body: page setup, theme, styles, footer,
   relationships and the zip itself — identical for any .docx this file
   produces, so the narration export builds its own body and hands it to
   the same packer rather than growing a second copy of the boilerplate. */

/* A minimal but schema-complete DrawingML theme — the "document theme
   font" Word actually reads styles.xml's asciiTheme/hAnsiTheme references
   against. Calibri is Word's own long-standing default, so every Windows
   and Mac install already has it; only the color scheme is Splitpage's
   own. fmtScheme's four lists are fixed-size in the OOXML
   schema (3 entries each) but nothing here ever draws a themed shape, so
   each entry is the simplest legal one rather than a copy of Word's own
   gradients. */
var THEME_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Splitpage">' +
  '<a:themeElements>' +
  '<a:clrScheme name="Splitpage">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  /* the app's light palette (PRINT_COLORS, TAG_PRINT_COLORS), so Word's
     theme colours are the ones the document is drawn in: text, the raised
     grey, then Visual, Audio, B-roll and three of the tag colours —
     literal here, since this string is built before any module's values */
  '<a:dk2><a:srgbClr val="171613"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="E9E8E4"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="2863AB"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="9E5800"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="00717F"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="764AA2"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="2A7449"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="AB413E"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="1155CC"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="764AA2"/></a:folHlink>' +
  '</a:clrScheme>' +
  '<a:fontScheme name="Splitpage">' +
  /* Calibri for the headings too: the title and headings are bold, as the
     app's are, and Calibri Light has no bold of its own to show */
  '<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="Splitpage">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '</a:lnStyleLst>' +
  '<a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '</a:effectStyleLst>' +
  '<a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:bgFillStyleLst>' +
  '</a:fmtScheme>' +
  '</a:themeElements>' +
  '</a:theme>';

/* The running footer on every page (#169): the title at the left, "Page 2
   of 8" at the right — Word's own PAGE and NUMPAGES fields, which it
   works out as it lays the pages — small and faint over a hairline. A
   title too long for the line is cut short with an ellipsis rather than
   wrapped into the page number. */
var FOOTER_TITLE_MAX = 90;

function footerXml(title) {
  var rPr = '<w:rPr><w:color w:val="' + PRINT_COLORS.faint + '"/><w:sz w:val="16"/></w:rPr>';
  var t = function (s) { return "<w:r>" + rPr + '<w:t xml:space="preserve">' + xmlEscape(s) + "</w:t></w:r>"; };
  var field = function (name) {
    return "<w:r>" + rPr + '<w:fldChar w:fldCharType="begin"/></w:r>' +
      "<w:r>" + rPr + '<w:instrText xml:space="preserve"> ' + name + " </w:instrText></w:r>" +
      "<w:r>" + rPr + '<w:fldChar w:fldCharType="separate"/></w:r>' + t("1") +
      "<w:r>" + rPr + '<w:fldChar w:fldCharType="end"/></w:r>';
  };
  if (title.length > FOOTER_TITLE_MAX) title = title.slice(0, FOOTER_TITLE_MAX - 1).replace(/\s+$/, "") + "…";
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="' + PRINT_COLORS.border + '"/></w:pBdr>' +
    '<w:tabs><w:tab w:val="right" w:pos="' + PAGE_W + '"/></w:tabs><w:spacing w:after="0"/>' + rPr + "</w:pPr>" +
    t(title) + "<w:r>" + rPr + "<w:tab/></w:r>" + t("Page ") + field("PAGE") + t(" of ") + field("NUMPAGES") +
    "</w:p></w:ftr>";
}

/* The package's own description of the document — what Word's File ▸
   Info and the file's properties show: the script's title, Splitpage as
   its author and the application that made it, and the day it was made.
   The day, not the second: two exports of the same script are the same
   bytes (suite 98 holds the Export dialog to the File menu that way). */
function corePropsXml(title) {
  var d = new Date();
  var day = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T00:00:00Z";
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + xmlEscape(title) + "</dc:title><dc:creator>Splitpage</dc:creator>" +
    "<cp:lastModifiedBy>Splitpage</cp:lastModifiedBy>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + day + "</dcterms:created>" +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + day + "</dcterms:modified>" +
    "</cp:coreProperties>";
}

var APP_PROPS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
  ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  "<Application>Splitpage</Application></Properties>";

/* Word's current layout rules (compatibility mode 15), so the file opens
   as a document of today's Word, not in "Compatibility Mode" — a table's
   edge on the margin, as this export measures it. */
var SETTINGS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  "</w:settings>";

function packDocx(body, links, media) {
  var title = S.state.title || "Untitled Script";
  body += '<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter1"/>' +
    '<w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1260" w:right="1080" w:bottom="1260" w:left="1080" w:header="720" w:footer="600" w:gutter="0"/></w:sectPr>';

  var documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' + body + '</w:body></w:document>';

  var relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
    '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>';
  links.forEach(function (href, idx) {
    relsXml += '<Relationship Id="rIdL' + (idx + 1) + '"' +
      ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"' +
      ' Target="' + xmlEscape(href) + '" TargetMode="External"/>';
  });
  media.forEach(function (m, idx) {
    relsXml += '<Relationship Id="rIdM' + (idx + 1) + '"' +
      ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"' +
      ' Target="media/image' + (idx + 1) + '.' + m.ext + '"/>';
  });
  /* jpeg is always declared, as it always was; another type only when a
     picture of that type is in the package */
  var extraTypes = "";
  ["png", "gif", "webp"].forEach(function (ext) {
    if (media.some(function (m) { return m.ext === ext; })) {
      extraTypes += '<Default Extension="' + ext + '" ContentType="image/' + ext + '"/>';
    }
  });
  relsXml += '</Relationships>';

  var entries = [
    { name: "[Content_Types].xml", data: strBytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="jpeg" ContentType="image/jpeg"/>' + extraTypes +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
      '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>') },
    { name: "_rels/.rels", data: strBytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>') },
    { name: "docProps/core.xml", data: strBytes(corePropsXml(title)) },
    { name: "docProps/app.xml", data: strBytes(APP_PROPS_XML) },
    { name: "word/document.xml", data: strBytes(documentXml) },
    { name: "word/styles.xml", data: strBytes(STYLES_XML) },
    { name: "word/settings.xml", data: strBytes(SETTINGS_XML) },
    { name: "word/theme/theme1.xml", data: strBytes(THEME_XML) },
    { name: "word/footer1.xml", data: strBytes(footerXml(title)) },
    { name: "word/_rels/document.xml.rels", data: strBytes(relsXml) }
  ];
  media.forEach(function (m, idx) {
    entries.push({ name: "word/media/image" + (idx + 1) + "." + m.ext, data: m.bytes });
  });

  return zipWrite(entries);
}

/* ================= the narration on its own =================

   The audio column lifted back out as an ordinary document: one paragraph
   per scene, blank line between — which is exactly the shape "Paste a
   script…" reads back in its paragraph mode, so a narration exported here
   and re-imported reproduces the same rows it came from.

   The visual column, the breakdown and the comments are all deliberately
   missing. This is the file you hand to a voice artist, or carry into
   Word to keep writing, not another copy of the whole script — every
   other export already is that. */

/* "Include stage directions" (#167), the narration export's one option
   (the Export dialog, 18c-export-dialog.js): some voice artists want the
   directions, some want clean copy. On unless switched off — per device,
   like the remembered format, never in the document. "0" is off. */
export var NARRATION_DIRECTIONS_KEY = "splitpage-export-directions";

export function narrationIncludesDirections() {
  return readPref(NARRATION_DIRECTIONS_KEY) !== "0";
}

export function setNarrationIncludesDirections(on) {
  writePref(NARRATION_DIRECTIONS_KEY, on ? null : "0");
}

/* opts.directions: true/false overrides the preference (tests). Sound
   cues (#219) are never in it: this is what is said, and a cue is not. */
function narrationTextOpts(opts) {
  var include = opts && typeof opts.directions === "boolean" ? opts.directions : narrationIncludesDirections();
  return include ? { cues: "omit" } : { directions: "omit", cues: "omit" };
}

export function narrationRows(opts) {
  var t = narrationTextOpts(opts);
  return S.state.rows.filter(function (row) { return toPlainText(cellOf(row.audioText), t); });
}

export function buildNarrationText(opts) {
  var t = narrationTextOpts(opts);
  var out = [S.state.title || "Untitled Script", ""];
  narrationRows(opts).forEach(function (row) {
    /* A blank line is the separator between scenes in this format, so one
       *inside* a scene would split it in two on the way back in — the
       round trip this format exists for, quietly broken by a scene whose
       narration happened to contain two line breaks in a row. Runs of
       blank lines collapse to a single break; the scene stays one scene. */
    out.push(toPlainText(cellOf(row.audioText), t).replace(/\n[ \t]*(\n[ \t]*)+/g, "\n"));
    out.push("");
  });
  return out.join("\n");
}

/* The narration .docx for a voice artist: the title, one line of what it
   is — "Narration · 30 scenes · 1,462 words · about 9:45 at 150 wpm", the
   read time worked out from the words said at the document's reading
   speed, which is what a voice artist is asked to hit — then a paragraph
   per scene at a size and spacing to read aloud from (the Narration
   paragraph style: 12pt, 1.5 lines, a gap between), each with its scene's
   number out in the left margin, small and faint, so a director can say
   "pick up from 14". The number is the scene's number in the script, gaps
   and all, not a count of the paragraphs.

   The paragraph shape is the round trip: opened again (docxToRows) it is
   the rows it always was — the title the title, each paragraph a scene.
   The meta line is a paragraph style only this export writes and the
   numbers a character style (SplitpageSceneNo), both skipped on the way
   back in. The number hangs from a negative first-line indent and a tab
   to the text's own edge — never a table, which would make it a different
   document to read back. */
var NARRATION_STYLE = "SplitpageNarration";
var SCENE_NO_STYLE = "SplitpageSceneNo";
var SCENE_NO_HANG = 560;

function groupDigits(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function buildNarrationDocx(opts) {
  var t = narrationTextOpts(opts);
  var links = [];
  var rels = { addLink: function (href) { links.push(href); return "rIdL" + links.length; } };
  var rows = narrationRows(opts);
  var words = rows.reduce(function (n, row) { return n + wordCount(row.audioText); }, 0);
  var wpm = S.state.wordsPerMinute || DEFAULT_WPM;

  var body = titleParaXml(S.state.title || "Untitled Script") +
    metaParaXml(["Narration", plural(rows.length, "scene"), groupDigits(words) + (words === 1 ? " word" : " words"),
      "about " + formatDuration(words / wpm * 60) + " at " + wpm + " wpm"].join(" · "));

  rows.forEach(function (row) {
    var number = pad2(S.state.rows.indexOf(row) + 1);
    body += docxRunsXml(row.audioText, rels, Object.assign({
      pPr: '<w:pStyle w:val="' + NARRATION_STYLE + '"/><w:ind w:left="0" w:hanging="' + SCENE_NO_HANG + '"/>',
      lead: '<w:r><w:rPr><w:rStyle w:val="' + SCENE_NO_STYLE + '"/><w:color w:val="' + PRINT_COLORS.faint + '"/><w:sz w:val="16"/></w:rPr>' +
        '<w:t xml:space="preserve">' + number + "</w:t><w:tab/></w:r>"
    }, t));
  });

  return packDocx(body, links, []);
}

/* ================= .docx reading ================= */

var W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
var R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
var A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

function directChildren(el, localName) {
  return Array.prototype.filter.call(el.childNodes, function (n) {
    return n.nodeType === 1 && n.localName === localName;
  });
}

/* Word writes <w:b w:val="0"/> to switch a style's bold OFF — treating the
   element's mere presence as "on" makes every such run bold. */
function docxFlag(props, name) {
  if (!props) return false;
  var el = props.getElementsByTagNameNS(W_NS, name)[0];
  if (!el) return false;
  var val = el.getAttributeNS(W_NS, "val");
  if (val === null || val === undefined) val = el.getAttribute("w:val");
  if (val === null || val === undefined || val === "") return true;
  var v = String(val).toLowerCase();
  return !(v === "0" || v === "false" || v === "none" || v === "off");
}

/* A run's character style id, lower-cased, or "". */
function runStyleName(rEl) {
  var props = rEl.getElementsByTagNameNS(W_NS, "rPr")[0];
  var rs = props && props.getElementsByTagNameNS(W_NS, "rStyle")[0];
  return rs ? (rs.getAttributeNS(W_NS, "val") || rs.getAttribute("w:val") || "").toLowerCase() : "";
}

/* Runs a Splitpage export writes that are no part of the script: an open
   comment's number after its words (SplitpageMarker) and a narration
   paragraph's scene number in the margin (SplitpageSceneNo). Dropped
   whole, wherever they are. */
function isDroppedRun(rEl) {
  var st = runStyleName(rEl);
  return st === MARKER_STYLE.toLowerCase() || st === SCENE_NO_STYLE.toLowerCase();
}

/* An underline with a colour of its own. In a Splitpage export that is
   one the export drew — a tag's, a comment's — never one the writer typed,
   which the export writes without a colour (docxRunsXml). */
function colouredUnderline(props) {
  var el = props.getElementsByTagNameNS(W_NS, "u")[0];
  return !!el && !!(el.getAttributeNS(W_NS, "color") || el.getAttribute("w:color"));
}

/* opts.ownExport: the document is one a Splitpage export wrote (docxToRows
   decides), so a coloured underline is the export's drawing, not the
   writer's underline. */
function docxParaToHtml(pEl, linkMap, opts) {
  var html = "";
  var own = !!(opts && opts.ownExport);
  function runToHtml(rEl, href) {
    if (isDroppedRun(rEl)) return "";
    var props = rEl.getElementsByTagNameNS(W_NS, "rPr")[0];
    var b = false, i = false, u = false, s = false, mark = false, dir = false, chip = false;
    if (props) {
      b = docxFlag(props, "b");
      i = docxFlag(props, "i");
      u = docxFlag(props, "u");
      s = docxFlag(props, "strike");
      mark = docxFlag(props, "highlight");
      /* a stage direction a Splitpage export wrote (#167): its style, not
         its look — the italic that shows it is not the writer's italic */
      var rsv = runStyleName(rEl);
      if (rsv === DIRECTION_STYLE.toLowerCase()) { dir = true; i = false; }
      /* the b-roll key's chip: its words as they were, the bold is the
         chip's (a key carries no formatting of its own), and so is the
         padding either side of them */
      if (rsv === BROLL_STYLE.toLowerCase()) { b = false; chip = true; }
      if (u && own && colouredUnderline(props)) u = false;
    }
    var piece = "";
    Array.prototype.forEach.call(rEl.childNodes, function (child) {
      if (child.nodeType !== 1) return;
      var ln = child.localName;
      if (ln === "t") piece += escapeHtml(child.textContent || "");
      else if (ln === "br" || ln === "cr") piece += "<br>";
      else if (ln === "tab") piece += " ";
    });
    if (chip) piece = piece.replace(CHIP_PAD_ENDS, "");
    if (!piece) return "";
    if (mark) piece = "<mark>" + piece + "</mark>";
    if (s) piece = "<s>" + piece + "</s>";
    if (u && !href) piece = "<u>" + piece + "</u>";
    if (i) piece = "<em>" + piece + "</em>";
    if (b) piece = "<strong>" + piece + "</strong>";
    if (dir) piece = '<span class="stage-dir">' + piece + "</span>";
    var safe = href ? safeHref(href) : null;
    if (safe) piece = '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener">' + piece + "</a>";
    return piece;
  }

  Array.prototype.forEach.call(pEl.childNodes, function (child) {
    if (child.nodeType !== 1) return;
    if (child.localName === "r") { html += runToHtml(child, null); return; }
    if (child.localName === "hyperlink") {
      var rid = child.getAttributeNS(R_NS, "id");
      var href = rid && linkMap[rid] ? linkMap[rid] : null;
      var runs = child.getElementsByTagNameNS(W_NS, "r");
      for (var k = 0; k < runs.length; k++) html += runToHtml(runs[k], href);
    }
  });
  return html;
}

/* ---- reading a Word document ----

   Real scripts are not one uniform shape: a document typically mixes prose
   (narration and stage directions) with one or more two-column tables, in a
   meaningful order. So walk the body in document order and convert BOTH,
   rather than taking the tables and throwing the prose away. */

function paraStyleName(pEl) {
  var pPr = directChildren(pEl, "pPr")[0];
  if (!pPr) return "";
  var st = directChildren(pPr, "pStyle")[0];
  if (!st) return "";
  return (st.getAttributeNS(R_NS, "val") || st.getAttribute("w:val") || st.getAttribute("val") || "").toLowerCase();
}

function isHeadingPara(pEl) {
  return /^heading|^title$/.test(paraStyleName(pEl));
}

/* true when every run carrying text is bold — the usual convention for a
   stage direction sitting among plain narration. A run the reader drops
   (a narration's scene number) is no part of the paragraph's text. */
function isAllBoldPara(pEl) {
  var runs = pEl.getElementsByTagNameNS(W_NS, "r");
  var sawText = false;
  for (var i = 0; i < runs.length; i++) {
    if (isDroppedRun(runs[i])) continue;
    var texts = runs[i].getElementsByTagNameNS(W_NS, "t");
    var hasText = false;
    for (var j = 0; j < texts.length; j++) {
      if ((texts[j].textContent || "").trim()) { hasText = true; break; }
    }
    if (!hasText) continue;
    sawText = true;
    if (!docxFlag(runs[i].getElementsByTagNameNS(W_NS, "rPr")[0], "b")) return false;
  }
  return sawText;
}

/* Every picture a cell holds, by relationship id, in order. */
function allEmbedIds(el) {
  return Array.prototype.map.call(el.getElementsByTagNameNS(A_NS, "blip"), function (b) {
    return b.getAttributeNS(R_NS, "embed");
  }).filter(Boolean);
}

function firstEmbedId(el) {
  var blip = el.getElementsByTagNameNS(A_NS, "blip")[0];
  return blip ? blip.getAttributeNS(R_NS, "embed") : null;
}

var VISUAL_HEAD = /^(video|visual|picture|image|shot|shots|action|camera|b-?roll|screen|graphics?)\b/;
var AUDIO_HEAD = /^(audio|voice|vo|narration|narrator|dialogue|dialog|script|line|lines|copy|speech)\b/;

/* buildDocx()'s own "Production breakdown" table, verbatim — none of its
   header words match VISUAL_HEAD/AUDIO_HEAD, so without this check
   mapTableColumns() fell into its no-header fallback and grabbed the
   first two columns ("Category"/"Item") as if they were Visual/Audio,
   turning every breakdown row (and the header row itself) into a
   fabricated scene on reimport. The export's heads since #169 (by
   category, BREAKDOWN_HEAD_WORDS) and the ones before it, which files
   already exported still carry. */
var BREAKDOWN_HEADERS = [
  ["category", "item", "status", "assigned to", "mentions", "scenes", "notes"],
  ["item", "status", "scenes", "assigned to", "notes"]
];
function isBreakdownHeader(head) {
  return BREAKDOWN_HEADERS.some(function (words) {
    return words.length === head.length && words.every(function (w, i) { return head[i] === w; });
  });
}

/* ---- where a Splitpage export's script ends ----

   buildDocx() writes the script as one table and then, when the document
   has them, a "Production breakdown" section (heading + table), a "B-roll
   shot list" (heading + a paragraph per scene and shot, since #169) and a
   "Comments" section (heading + a paragraph per comment line, reply and
   picture). None is script: walked as prose, the headings came back as
   bold rows, every comment line as a narration row, and a comment's
   picture as a row picture. The breakdown table itself was already
   skipped (isBreakdownHeader), its heading was not.

   Recognised structurally, not by the words alone: the section starts at a
   paragraph in the Heading1 style reading exactly one of the headings
   buildDocx() writes, AFTER a table in the "SplitpageTable" table style —
   a style id only this export defines (styles.xml, __init below) and
   nobody produces by typing. A Word document of the user's own with a
   "Comments" heading has no such table and imports exactly as it always
   did. Files Splitpage exported before this check carry the same shape,
   so they reopen cleanly too.

   The comments are dropped, not rebuilt: the export carries them as
   plain text with a formatted date and a scene label, not the anchor
   (row, field, offsets), the formatting or the timestamps a comment
   record needs, and opening a .docx starts a new document with no
   comments of its own (issue #7). */
var EXPORT_TABLE_STYLE = EXPORT_TABLE_STYLE_ID.toLowerCase();
var EXPORT_SECTION_HEADINGS = ["Production breakdown", "B-roll shot list", "Comments"];

function tableStyleName(tblEl) {
  var tblPr = directChildren(tblEl, "tblPr")[0];
  var st = tblPr && directChildren(tblPr, "tblStyle")[0];
  if (!st) return "";
  return (st.getAttributeNS(W_NS, "val") || st.getAttribute("w:val") || "").toLowerCase();
}

/* The index in `blocks` where a Splitpage export's own trailing sections
   begin, or blocks.length when there are none (any other document). */
function exportTailStart(blocks) {
  var sawExportTable = false;
  for (var i = 0; i < blocks.length; i++) {
    var n = blocks[i];
    if (n.localName === "tbl") {
      if (tableStyleName(n) === EXPORT_TABLE_STYLE) sawExportTable = true;
      continue;
    }
    if (sawExportTable && paraStyleName(n) === "heading1" &&
        EXPORT_SECTION_HEADINGS.indexOf((n.textContent || "").trim()) !== -1) return i;
  }
  return blocks.length;
}

/* Work out which columns hold the visual and the audio. Tables in the wild
   have an extra scene-number column, and put the columns in either order. */
function mapTableColumns(rowsText) {
  var head = (rowsText[0] || []).map(function (t) { return t.toLowerCase().trim(); });
  if (isBreakdownHeader(head)) return null;
  var vi = head.findIndex(function (t) { return VISUAL_HEAD.test(t); });
  var ai = head.findIndex(function (t) { return AUDIO_HEAD.test(t); });
  if (vi !== -1 && ai !== -1 && vi !== ai) return { vi: vi, ai: ai, skipHeader: true };

  /* no usable header — ignore columns that are empty throughout (index
     columns), then take the first two that carry content, left to right */
  var width = 0;
  rowsText.forEach(function (r) { width = Math.max(width, r.length); });
  var used = [];
  for (var c = 0; c < width; c++) {
    var any = rowsText.some(function (r) { return (r[c] || "").trim(); });
    if (any) used.push(c);
  }
  if (used.length < 2) return null;
  return { vi: used[0], ai: used[1], skipHeader: false };
}

export async function docxToRows(file) {
  var zip = await zipRead(await file.arrayBuffer());
  var docBytes = await zip.get("word/document.xml");
  if (!docBytes) throw new Error("no-document-xml");
  var xml = new DOMParser().parseFromString(new TextDecoder().decode(docBytes), "application/xml");
  if (xml.getElementsByTagName("parsererror").length) throw new Error("bad-xml");

  /* hyperlink and image targets live in the rels part */
  var linkMap = {}, imageMap = {};
  var relBytes = await zip.get("word/_rels/document.xml.rels");
  if (relBytes) {
    var relXml = new DOMParser().parseFromString(new TextDecoder().decode(relBytes), "application/xml");
    Array.prototype.forEach.call(relXml.getElementsByTagName("Relationship"), function (rel) {
      var type = rel.getAttribute("Type") || "";
      if (type.indexOf("/hyperlink") !== -1) linkMap[rel.getAttribute("Id")] = rel.getAttribute("Target");
      else if (type.indexOf("/image") !== -1) imageMap[rel.getAttribute("Id")] = rel.getAttribute("Target");
    });
  }

  var bodyEl = xml.getElementsByTagNameNS(W_NS, "body")[0];
  if (!bodyEl) throw new Error("no-body");

  var blocks = Array.prototype.filter.call(bodyEl.childNodes, function (n) {
    return n.nodeType === 1 && (n.localName === "p" || n.localName === "tbl");
  });
  /* A document a Splitpage export wrote — its script table in the export's
     own table style, or the line under its title in the export's own
     paragraph style (the narration has no table) — draws round the words
     in ways the reader must not take for formatting (docxParaToHtml). */
  var ownExport = blocks.some(function (n) {
    return n.localName === "tbl" ? tableStyleName(n) === EXPORT_TABLE_STYLE : paraStyleName(n) === META_STYLE.toLowerCase();
  });
  var paraOpts = { ownExport: ownExport };
  /* a Splitpage export ends at its script: its breakdown, b-roll and
     comments sections are not rows (exportTailStart above); and the line
     of what the document is, under its title, is no scene (metaParaXml) */
  blocks = blocks.slice(0, exportTailStart(blocks)).filter(function (n) {
    return !(n.localName === "p" && paraStyleName(n) === META_STYLE.toLowerCase());
  });

  /* Only read bold as "this is a direction" when the document uses it that
     way — sparingly, among plain paragraphs. In an all-bold document it
     means nothing. */
  var loose = blocks.filter(function (n) { return n.localName === "p" && !isHeadingPara(n); });
  var withText = loose.filter(function (n) { return htmlToPlainText(docxParaToHtml(n, linkMap, paraOpts)); });
  var boldCount = withText.filter(isAllBoldPara).length;
  var boldMeansVisual = boldCount > 0 && boldCount < withText.length * 0.7;

  var rows = [], title = null, pending = null;

  function flush() {
    if (pending) { rows.push(pending); pending = null; }
  }
  function newRow(fields) {
    return {
      id: makeId(),
      visualText: fields.visualText || "",
      imageRef: null,
      audioText: fields.audioText || "",
      _pendingImage: fields._pendingImage || null,
      _pendingMore: fields._pendingMore || null,
      _links: fields._links || null
    };
  }

  blocks.forEach(function (node) {
    if (node.localName === "tbl") {
      flush();
      var trs = directChildren(node, "tr");
      var cellHtml = [], cellEls = [], cellLinks = [];
      for (var t = 0; t < trs.length; t++) {
        var tcs = directChildren(trs[t], "tc");
        var rowLinks = [];
        cellEls.push(tcs);
        cellLinks.push(rowLinks);
        cellHtml.push(tcs.map(function (tc) {
          var parts = [];
          directChildren(tc, "p").forEach(function (pEl) {
            /* buildDocx's line of a scene's video links (#135) goes
               back into its gallery, not its words */
            var vl = docxVideoLinksOf(pEl, linkMap);
            if (vl) { vl.forEach(function (l) { rowLinks.push(l); }); return; }
            var h = docxParaToHtml(pEl, linkMap, paraOpts);
            if (h) parts.push(h);
          });
          return parts.join("<br>");
        }));
      }
      var mapping = mapTableColumns(cellHtml.map(function (r) {
        return r.map(function (h) { return htmlToPlainText(h); });
      }));
      if (!mapping) return;

      for (var i = mapping.skipHeader ? 1 : 0; i < cellHtml.length; i++) {
        var v = cellHtml[i][mapping.vi] || "";
        var a = cellHtml[i][mapping.ai] || "";
        /* a picture can sit in either cell — the first is the scene's
           picture, any after it the rest of its gallery (#135) */
        var targets = [];
        for (var c = 0; c < cellEls[i].length; c++) {
          allEmbedIds(cellEls[i][c]).forEach(function (id) {
            if (imageMap[id] && targets.indexOf(imageMap[id]) === -1) targets.push(imageMap[id]);
          });
        }
        if (!htmlToPlainText(v) && !htmlToPlainText(a) && !targets.length && !cellLinks[i].length) continue;
        rows.push(newRow({
          visualText: v, audioText: a,
          _pendingImage: targets[0] || null,
          _pendingMore: targets.length > 1 ? targets.slice(1) : null,
          _links: cellLinks[i].length ? cellLinks[i] : null
        }));
      }
      return;
    }

    /* paragraph */
    var html = docxParaToHtml(node, linkMap, paraOpts);
    var plain = htmlToPlainText(html);
    var embedId = firstEmbedId(node);
    var target = embedId && imageMap[embedId] ? imageMap[embedId] : null;
    if (!plain && !target) return;

    if (isHeadingPara(node)) {
      /* a heading at the very top, before anything else has been kept, is
         the document's title; otherwise headings are section markers
         worth keeping as their own row. This used to also require there
         be no MORE than one heading anywhere in the whole document — but
         buildDocx() always adds a second Heading1 ("Comments" /
         "Production breakdown") once there's a saved comment or tracked
         item, which defeated that count on every one of its own exports:
         the title paragraph became a bogus row. (That appended section is
         cut off before this walk now — exportTailStart.) Position (nothing kept yet) is
         the actual invariant the comment above describes — count of
         headings elsewhere in the document has nothing to do with it. */
      if (title === null && !rows.length && !pending) { title = plain; return; }
      flush();
      rows.push(newRow({ visualText: "<strong>" + html + "</strong>" }));
      return;
    }

    if (target) {
      /* an image paragraph is a visual: attach it to the row being built */
      if (pending && !pending.imageRef && !pending._pendingImage) {
        pending._pendingImage = target;
        if (plain) pending.visualText = pending.visualText ? pending.visualText + "<br>" + html : html;
      } else {
        flush();
        pending = newRow({ visualText: plain ? html : "", _pendingImage: target });
      }
      return;
    }

    /* a paragraph wrapped entirely in brackets is a direction by convention */
    var bracketed = /^\s*[[(].*[\])]\s*$/.test(plain) && plain.length < 200;
    if ((boldMeansVisual && isAllBoldPara(node)) || bracketed) {
      flush();
      pending = newRow({ visualText: html });
      return;
    }

    /* narration: fill the direction we are holding, or stand on its own */
    if (pending && !pending.audioText) {
      pending.audioText = html;
      flush();
    } else {
      flush();
      rows.push(newRow({ audioText: html }));
    }
  });
  flush();

  /* pull each referenced picture out of the package and inline it */
  async function pictureAt(target) {
    try {
      var path = target.indexOf("/") === 0 ? target.slice(1) : "word/" + target;
      var imgBytes = await zip.get(path);
      if (!imgBytes) return null;
      var raw = bytesToDataUrl(imgBytes, mimeForPath(path));
      /* JPEG, at most 1000px — what a picture attached by hand becomes
         too — then into the image registry (#82), named by its record */
      var rec = internDataUrl(await toJpegDataUrl(raw));
      if (rec) queuePersist([rec.sha256]);
      return rec;
    } catch (e) { return null; }   /* unreadable picture — keep the row, drop the image */
  }
  for (var ri = 0; ri < rows.length; ri++) {
    var pendingTarget = rows[ri]._pendingImage;
    var pendingMore = rows[ri]._pendingMore || [];
    var pendingLinks = rows[ri]._links;
    delete rows[ri]._pendingImage;
    delete rows[ri]._pendingMore;
    delete rows[ri]._links;
    if (pendingTarget) rows[ri].imageRef = await pictureAt(pendingTarget);
    var more = [];
    for (var mi = 0; mi < pendingMore.length; mi++) {
      var mrec = await pictureAt(pendingMore[mi]);
      if (mrec) more.push({ imageRef: mrec });
    }
    /* each video is an item of its own, after the pictures (#135) */
    (pendingLinks || []).forEach(function (l) { more.push({ links: [Object.assign({}, l, { poster: true })] }); });
    if (more.length) rows[ri].moreImages = more;
    rows[ri].audioText = audioDirectionsHtml(rows[ri].audioText);
    rows[ri].visualText = noDirectionsHtml(rows[ri].visualText);
  }

  return { title: title, rows: rows, looseText: "" };
}

/* Stage directions coming in (#167). In the Audio column an inline
   "((words))" becomes one, and one a Splitpage export wrote (its own
   character style, read above) loses the brackets the export printed
   round it. The Visual column has none: a styled one that landed there —
   a paragraph that was nothing but a direction goes to the Visual column
   by the bracket rule above — is its words, brackets and all. A cell
   with neither is left exactly as it was read.

   Sound cues (#219) the same way: in the Audio column a line starting
   "SFX:" or "Music:" becomes one, as typing it would; in the Visual column
   it is its words. */
export function audioDirectionsHtml(html) {
  if (!html) return html;
  var dirs = html.indexOf("((") !== -1 || html.indexOf("stage-dir") !== -1;
  var cues = /(sfx|music)[ \t\u00a0]*:/i.test(html);
  if (!dirs && !cues) return html;
  var c = fromHtml(html);
  if (dirs) c = importDirections(c);
  if (cues) c = importCues(c);
  return toHtml(c);
}

function noDirectionsHtml(html) {
  if (!html || (html.indexOf("stage-dir") === -1 && html.indexOf("audio-cue") === -1)) return html;
  var c = fromHtml(html);
  return toHtml(flattenCues(setMark(c, 0, cellLength(c), "dir", false)));
}

/* re-encode any image to JPEG so every downstream writer can rely on it */
function toJpegDataUrl(dataUrl) {
  return new Promise(function (resolve) {
    if (!dataUrl) { resolve(null); return; }
    if (dataUrl.indexOf("data:image/jpeg") === 0) { resolve(dataUrl); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var scale = Math.min(1, 1000 / Math.max(img.width, img.height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      } catch (e) { resolve(null); }
    };
    img.onerror = function () { resolve(null); };
    img.src = dataUrl;
  });
}

function mimeForPath(path) {
  var ext = (/\.([a-z0-9]+)$/i.exec(path) || ["", ""])[1].toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function bytesToDataUrl(bytes, mime) {
  var bin = "", CHUNK = 0x8000;
  for (var i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return "data:" + mime + ";base64," + btoa(bin);
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  var C = PRINT_COLORS;
  var font = function (which) {
    return '<w:rFonts w:asciiTheme="' + which + 'HAnsi" w:hAnsiTheme="' + which + 'HAnsi" w:cstheme="' + which + 'HAnsi"/>';
  };
  var charStyle = function (id, name, rPr) {
    return '<w:style w:type="character" w:customStyle="1" w:styleId="' + id + '"><w:name w:val="' + name + '"/>' +
      "<w:rPr>" + rPr + "</w:rPr></w:style>";
  };
  var paraStyle = function (id, name, pPr, rPr, custom) {
    return '<w:style w:type="paragraph"' + (custom ? ' w:customStyle="1"' : "") + ' w:styleId="' + id + '"><w:name w:val="' + name + '"/>' +
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      "<w:pPr>" + pPr + "</w:pPr><w:rPr>" + rPr + "</w:rPr></w:style>";
  };

  /* Named styles, as Word's own documents have them: Normal, the title
     and the appendix headings in the theme's heading font (the theme names
     Calibri for both, so a writer who changes the document's fonts in Word
     changes them all), the export's own paragraph and character styles —
     each how docxToRows tells what the export drew from what was written
     (docxRunsXml and the reader below) — and the table style, rules across
     only. Colours are the app's light palette (PRINT_COLORS). */
  STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults>' +
    "<w:rPrDefault><w:rPr>" + font("minor") +
    '<w:color w:val="' + C.text + '"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/>' +
    "</w:rPr></w:rPrDefault>" +
    '<w:pPrDefault><w:pPr><w:widowControl/><w:spacing w:after="160" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    "</w:docDefaults>" +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    paraStyle("Title", "Title", '<w:keepNext/><w:spacing w:after="80" w:line="240" w:lineRule="auto"/>',
      font("major") + '<w:b/><w:sz w:val="40"/><w:szCs w:val="40"/>') +
    /* the line of what the document is, under the title and the headings */
    paraStyle(META_STYLE, "Document details", '<w:keepNext/><w:spacing w:after="360"/>',
      '<w:color w:val="' + C.dim + '"/><w:sz w:val="18"/><w:szCs w:val="18"/>', true) +
    paraStyle("Heading1", "heading 1", '<w:keepNext/><w:keepLines/><w:spacing w:before="480" w:after="80"/><w:outlineLvl w:val="0"/>',
      font("major") + '<w:b/><w:sz w:val="28"/><w:szCs w:val="28"/>') +
    /* the narration export's paragraphs: to be read aloud off the page */
    paraStyle(NARRATION_STYLE, "Narration", '<w:spacing w:after="200" w:line="360" w:lineRule="auto"/>',
      '<w:sz w:val="24"/><w:szCs w:val="24"/>', true) +
    /* a stage direction (#167, docxRunsXml) */
    charStyle(DIRECTION_STYLE, "Stage direction", '<w:i/><w:color w:val="' + DIRECTION_COLOR + '"/>') +
    /* a sound cue line (#219, docxRunsXml) */
    charStyle(CUE_STYLE, "Sound cue", '<w:color w:val="' + CUE_COLOR + '"/><w:sz w:val="' + CUE_SIZE + '"/>') +
    /* what the script export draws round the words (docxRunsXml) */
    charStyle(TAG_STYLE, "Production tag", '<w:u w:val="single"/>') +
    charStyle(MARKER_STYLE, "Comment marker", '<w:b/><w:color w:val="' + C.audio + '"/><w:position w:val="6"/>' +
      '<w:sz w:val="' + MARKER_SIZE + '"/><w:bdr w:val="single" w:sz="4" w:space="0" w:color="' + C.audio + '"/>') +
    charStyle(BROLL_STYLE, "B-roll key", '<w:b/><w:color w:val="' + C.broll + '"/><w:sz w:val="' + BROLL_SIZE + '"/>' +
      '<w:bdr w:val="single" w:sz="4" w:space="0" w:color="' + C.broll + '"/>') +
    /* the narration's scene numbers in the margin */
    charStyle(SCENE_NO_STYLE, "Scene number", '<w:color w:val="' + C.faint + '"/><w:sz w:val="16"/>') +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
      '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/>' +
      '<w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '<w:style w:type="table" w:styleId="' + EXPORT_TABLE_STYLE_ID + '"><w:name w:val="Splitpage Table"/>' +
      '<w:basedOn w:val="TableNormal"/>' +
      "<w:tblPr>" + tableBordersXml() +
      '<w:tblCellMar><w:top w:w="110" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>' +
      '<w:bottom w:w="130" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>' +
      "</w:tblPr>" +
      '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr></w:tblStylePr>' +
      "</w:style>" +
    "</w:styles>";
}
