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
import { TAG_CATEGORIES } from "./07-production-tags.js";
import { breakdownRows } from "./08-production-panels.js";
import { brollEntries, brollSortedForList } from "./08c-broll.js";
import { shotRecordForFile } from "./08d-broll-panel.js";
import { commentEntries } from "./10-comments.js";
import { tagPrintColor } from "./14-export.js";
import { pad2 } from "../core/production/timing.ts";
import { toHtml } from "../core/text/html.ts";
import { toDocxRuns } from "../core/text/projections.ts";
import { cellOf, inertBody } from "../legacy/richtext.ts";

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

export var STATUS_PRINT = {
  todo: { color: PRINT_COLORS.faint, lamp: "outline" },
  ready: { color: PRINT_COLORS.audio, lamp: "fill" },
  shot: { color: PRINT_COLORS.text, lamp: "check" }
};

export var TAG_STATUS_PRINT = {
  needed: { color: PRINT_COLORS.faint, lamp: "outline" },
  sourcing: { color: PRINT_COLORS.audio, lamp: "half" },
  have: { color: PRINT_COLORS.text, lamp: "fill" },
  returned: { color: PRINT_COLORS.faint, lamp: "ring" }
};

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
    target: clock ? { seconds: target, text: clock.target, delta: clock.delta, over: clock.over } : null,
    status: status,
    words: words,
    wpm: s.wordsPerMinute || DEFAULT_WPM,
    exportedAt: when,
    date: exportDateText(when)
  };
}

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

export function exportRuns(html, nums) {
  nums = nums || commentNumbers();
  var runs = toDocxRuns(cellOf(html), { annotate: true });
  runs.forEach(function (r, i) {
    if (r.tag) r.tag = { cat: r.tag.cat, name: r.tag.name, color: tagPrintColor(r.tag.cat) };
    if (!r.cmt) return;
    var next = null;
    for (var k = i + 1; k < runs.length; k++) {
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

export function brollSummaryText(groups) {
  var all = 0, shot = 0, flagged = 0;
  groups.forEach(function (g) {
    g.items.forEach(function (r) { all++; if (r.shot) shot++; if (r.flagged) flagged++; });
  });
  return shot + " of " + all + " shot" + (flagged ? " · " + flagged + " flagged" : "");
}

export function __init() {}
