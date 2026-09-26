import { S } from "./_state.js";
import {
  ROW_STATUSES,
  DEFAULT_WPM,
  formatDuration,
  formatTimecode,
  hasSetLength,
  rowSeconds,
  rowStatus,
  targetClock,
  targetLengthOf,
  wordCount
} from "./01-scene-status.js";
import { inertBody } from "./04-richtext.js";
import { cellOf, toDocxRuns, toHtml } from "./04c-doc-model.js";
import { pad2 } from "./05-render.js";
import { TAG_CATEGORIES } from "./07-production-tags.js";
import { breakdownRows } from "./08-production-panels.js";
import { brollEntries, brollSortedForList } from "./08c-broll.js";
import { shotRecordForFile } from "./08d-broll-panel.js";
import { commentEntries } from "./10-comments.js";
import { tagPrintColor } from "./14-export.js";

/* ================= the exports' kit =================

   What every document export says about the script besides its words, in
   one place, so the PDF, the .docx, the Markdown and the spreadsheets say
   the same thing the same way — and the same thing the app shows:

   - the document's facts: scenes, running time, the target and how far
     off it the script is, how many scenes are shot, the words, the date
     (exportFacts, exportSummaryParts);
   - each scene's gutter: its number, the timecode it starts at, its
     status and its read time, set by hand or estimated (sceneFacts);
   - the open threads' numbers, counted the way the script's markers count
     them (commentNumbers), and the comments in that numbering
     (exportComments);
   - a cell's runs with what the script draws round them: the tag and its
     colour, the comments over them and the marker after them, the b-roll
     key (exportRuns);
   - the breakdown by category, as the Production panel groups it
     (breakdownGroups), and the b-roll shots by scene (exportBrollScenes);
   - the light palette, as the exports print it (PRINT_COLORS).

   Nothing here draws. Each writer draws these its own way. */

/* ---- the palette ----

   The light theme's :root values (app.css), hex without "#", upper case —
   what Word's w:color takes and what 17-pdf.js turns into operands. Like
   TAG_PRINT_COLORS (14-export.js, #171) a deliberate second copy: a file
   format cannot read a CSS token, and the page is white whatever theme the
   app is in. src/test/palette.test.mjs holds each one to its token
   (PRINT_TOKENS). */
export var PRINT_COLORS = {
  text: "171613",
  dim: "4E4D48",
  faint: "64635E",
  border: "DCDAD4",
  borderStrong: "C9C7C1",
  surface2: "E9E8E4",
  visual: "2863AB",
  visualSoft: "E3ECF7",
  audio: "9E5800",
  audioSoft: "F6EBDC",
  broll: "00717F"
};

export var PRINT_TOKENS = {
  text: "--text",
  dim: "--text-dim",
  faint: "--text-faint",
  border: "--border",
  borderStrong: "--border-strong",
  surface2: "--surface-2",
  visual: "--visual",
  visualSoft: "--visual-soft",
  audio: "--audio",
  audioSoft: "--audio-soft",
  broll: "--broll"
};

/* A scene status's colour and how its lamp is drawn (#169): To do an
   unlit outline, Ready lit amber, Shot lit in the text colour with a
   check. `lamp` is "outline", "fill" or "check". */
export var STATUS_PRINT = {
  todo: { color: PRINT_COLORS.faint, lamp: "outline" },
  ready: { color: PRINT_COLORS.audio, lamp: "fill" },
  shot: { color: PRINT_COLORS.text, lamp: "check" }
};

/* The same for a tracked item's status (TAG_STATUSES, 07-production-tags.js):
   Needed unlit, Sourcing half lit amber, Have it lit, Returned an unlit
   ring (the panel's return arrow, which a page has no glyph for). */
export var TAG_STATUS_PRINT = {
  needed: { color: PRINT_COLORS.faint, lamp: "outline" },
  sourcing: { color: PRINT_COLORS.audio, lamp: "half" },
  have: { color: PRINT_COLORS.text, lamp: "fill" },
  returned: { color: PRINT_COLORS.faint, lamp: "ring" }
};

/* ---- the document's facts ---- */

/* "26 September 2026" in the reader's own order — a date on a page, not
   a timestamp. */
export function exportDateText(d) {
  d = d || new Date();
  try {
    return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }).format(d);
  } catch (e) {
    return d.toDateString();
  }
}

function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

export function exportFacts(now) {
  var s = S.state;
  var rows = s.rows || [];
  var seconds = 0, words = 0;
  var status = { todo: 0, ready: 0, shot: 0 };
  rows.forEach(function (r) {
    seconds += rowSeconds(r);
    words += wordCount(r.audioText);
    var st = rowStatus(r.status) || ROW_STATUSES[0];
    status[st.id]++;
  });
  var target = targetLengthOf(s);
  var clock = target === null ? null : targetClock(seconds, target);
  var when = now || new Date();
  return {
    title: s.title || "Untitled Script",
    scenes: rows.length,
    seconds: seconds,
    runtime: formatDuration(seconds),
    /* {seconds, text "9:00", delta "0:44", over} or null */
    target: clock ? { seconds: target, text: clock.target, delta: clock.delta, over: clock.over } : null,
    status: status,
    words: words,
    wpm: s.wordsPerMinute || DEFAULT_WPM,
    exportedAt: when,
    date: exportDateText(when)
  };
}

/* The facts as the short phrases a title block strings together:
   "30 scenes", "9:44 running time", "Target 9:00 · 0:44 over",
   "13 of 30 shot". The date is left to the writer (a title block puts
   it last, a spreadsheet in its own cell). */
export function exportSummaryParts(facts) {
  facts = facts || exportFacts();
  var out = [plural(facts.scenes, "scene"), facts.runtime + " running time"];
  if (facts.target) {
    out.push("Target " + facts.target.text + " · " +
      (facts.target.delta === "0:00" ? "on target" : facts.target.delta + (facts.target.over ? " over" : " under")));
  }
  if (facts.scenes) out.push(facts.status.shot + " of " + facts.scenes + " shot");
  return out;
}

/* ---- each scene's gutter ---- */

/* One per row, in order: {number "01", start "00:00" (the timecode it
   starts at, the gutter's figure), startSeconds, seconds, read "0:10" (a
   length), readSet (a read time set by hand, #179 — the app boxes it),
   status {id, label}}. */
export function sceneFacts() {
  var at = 0;
  return (S.state.rows || []).map(function (r, i) {
    var sec = rowSeconds(r);
    var st = rowStatus(r.status) || ROW_STATUSES[0];
    var out = {
      index: i,
      number: pad2(i + 1),
      start: formatTimecode(at),
      startSeconds: at,
      seconds: sec,
      read: formatDuration(sec),
      readSet: hasSetLength(r),
      status: { id: st.id, label: st.label }
    };
    at += sec;
    return out;
  });
}

/* ---- the open threads' numbers ----

   The script numbers each open comment where its words end — a CSS
   counter over `.cmt-anchor:not(.resolved)::after` (app.css), which the
   Comments panel reads back off the page (commentThreadNumbers,
   10-comments.js). An export has no page to read, so this counts the
   same spans the same way off each cell's own markup (toHtml, the markup
   the script is drawn from): every row, Visual then Audio, each open
   `.cmt-anchor` element in the order its end is reached — one nested in
   another first. A thread in two spans takes the first one's number, as
   the panel's card does. Every scene counts, shot ones included: the
   export has them all, where the app may have folded some away. Resolved
   threads, and ids no comment has, get none. */
export function commentNumbers() {
  var open = Object.create(null);
  (S.state.comments || []).forEach(function (c) {
    if (c && c.id && !c.resolved && c.field !== "title") open[c.id] = true;
  });
  var nums = Object.create(null), n = 0;
  (S.state.rows || []).forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      var html = row[field] || "";
      if (html.indexOf("cmt-anchor") === -1) return;
      var spans = Array.prototype.slice.call(inertBody(toHtml(cellOf(html))).querySelectorAll(".cmt-anchor"))
        .filter(function (el) { return open[el.getAttribute("data-cmt")]; });
      spans.sort(function (a, b) {
        if (a.contains(b)) return 1;
        if (b.contains(a)) return -1;
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      spans.forEach(function (el) {
        n++;
        var id = el.getAttribute("data-cmt");
        if (!nums[id]) nums[id] = n;
      });
    });
  });
  return nums;
}

/* commentEntries({pieces: true}) (10-comments.js) as an export's appendix
   wants them: each with `number` (its marker's number, or null for a
   resolved thread or one whose words are gone), `scene` ("03", "" for the
   title or a deleted row) and `where`, the place as the panel names it:
   "Scene 03 · Audio". Script order, as commentEntries gives it, except
   that within one scene's field the numbered threads read in their
   numbers' order — a cell's threads are otherwise in the order they were
   posted, which is not the order their markers read. */
export function exportComments(opts) {
  var nums = commentNumbers();
  var list = commentEntries(opts || { pieces: true }).map(function (c) {
    var scene = c.rowIndex >= 0 ? pad2(c.rowIndex + 1) : "";
    var field = c.field === "audioText" ? "Audio" : "Visual";
    return Object.assign(c, {
      number: nums[c.id] || null,
      scene: scene,
      where: c.field === "title" ? "Document title" : scene ? "Scene " + scene + " · " + field : "Deleted scene"
    });
  });
  var i = 0;
  while (i < list.length) {
    var j = i;
    while (j < list.length && list[j].rowIndex === list[i].rowIndex && list[j].field === list[i].field) j++;
    var slots = [];
    for (var k = i; k < j; k++) if (list[k].number) slots.push(k);
    var numbered = slots.map(function (x) { return list[x]; }).sort(function (a, b) { return a.number - b.number; });
    slots.forEach(function (x, m) { list[x] = numbered[m]; });
    i = j;
  }
  return list;
}

/* ---- a cell's runs, annotated ----

   toDocxRuns(cell, {annotate}) (04c-doc-model.js): each run's text and
   formats, stage directions bracketed, and besides them
     tag      {cat, name, color} — color the category's print hex, or null
     cmt      the ids of the comments over the run
     markers  on the LAST run of an open thread's span, the numbers the
              script draws after it, in the order it draws them
     broll    the b-roll key's own run ("B-roll: "), its shot's id
   `nums` is commentNumbers(), worked out once per export and passed to
   every cell. */
export function exportRuns(html, nums) {
  nums = nums || commentNumbers();
  var runs = toDocxRuns(cellOf(html), { annotate: true });
  runs.forEach(function (r, i) {
    if (r.tag) r.tag = { cat: r.tag.cat, name: r.tag.name, color: tagPrintColor(r.tag.cat) };
    if (!r.cmt) return;
    var next = null;
    for (var k = i + 1; k < runs.length; k++) {
      /* a bracket a direction added belongs to the words it closes */
      if (runs[k].dir && (runs[k].text === "(" || runs[k].text === ")") && !runs[k].cmt) continue;
      next = runs[k];
      break;
    }
    var nextIds = (next && next.cmt) || [];
    var ending = r.cmt.filter(function (id) { return nextIds.indexOf(id) === -1 && nums[id]; }).reverse();
    if (ending.length) r.markers = ending.map(function (id) { return nums[id]; });
  });
  return runs;
}

/* ---- the breakdown, by category ----

   breakdownRows() (08-production-panels.js) as the Production panel lays
   it out: a group per category in TAG_CATEGORIES order, headed by its
   plural ("Props & set dressing") in its colour. */
export function breakdownGroups(rows) {
  rows = rows || breakdownRows();
  return TAG_CATEGORIES.map(function (cat) {
    return {
      catId: cat.id,
      label: cat.plural,
      color: tagPrintColor(cat.id),
      items: rows.filter(function (r) { return r.catId === cat.id; })
    };
  }).filter(function (g) { return g.items.length; });
}

/* ---- the b-roll, by scene ----

   Every shot, in script order, read without writing (brollEntries(true)):
   a group per scene — "Scene 04", its start timecode, how many are shot —
   and, last, the shots added by hand with no scene. Each item is the
   record the shot list's own files are made of (shotRecordForFile,
   08d-broll-panel.js). */
export function exportBrollScenes() {
  var facts = sceneFacts();
  var groups = [], byRow = Object.create(null);
  brollSortedForList(brollEntries(true)).forEach(function (e) {
    var key = e.rowIndex === -1 ? "none" : String(e.rowIndex);
    var g = byRow[key];
    if (!g) {
      var f = e.rowIndex === -1 ? null : facts[e.rowIndex];
      g = byRow[key] = {
        label: f ? "Scene " + f.number : "Not in the script",
        scene: f ? f.number : "",
        start: f ? f.start : "",
        done: 0,
        total: 0,
        items: []
      };
      groups.push(g);
    }
    var rec = shotRecordForFile(e);
    rec.id = e.id;
    g.items.push(rec);
    g.total++;
    if (rec.shot) g.done++;
  });
  return groups;
}

/* "3 of 9 shot · 1 flagged" over exportBrollScenes() — the b-roll page's
   own summary. */
export function brollSummaryText(groups) {
  var all = 0, shot = 0, flagged = 0;
  groups.forEach(function (g) {
    g.items.forEach(function (r) { all++; if (r.shot) shot++; if (r.flagged) flagged++; });
  });
  return shot + " of " + all + " shot" + (flagged ? " · " + flagged + " flagged" : "");
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
