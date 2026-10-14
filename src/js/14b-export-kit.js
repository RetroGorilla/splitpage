import { readClockPref } from "./00p-prefs.js";
import { migrateRows } from "./02-state.js";
import { bytesForSync, dataUrlPicture, ensureBytes, recordFor } from "./02c-blobs.js";
import { breakdownRows, commentEntries, sceneFacts, shotRecordForFile } from "./14c-export-projections.js";
import { tagPrintColor } from "../adapters/formats/print-colors.ts";
import { randomIds, systemClock } from "../adapters/identity/ids.ts";
import { exportAssetRequest, heldExportAssets, resolveExportAssets } from "../application/export/assets.ts";
import { captureExportDocument as captureWith } from "../application/save/capture.ts";
import { buildExportDocument } from "../core/document/export-document.ts";
import { rowImage } from "../core/document/media.ts";
import { contentMemo } from "../core/document/memo.ts";
import { DEFAULT_WPM, targetLengthOf } from "../core/document/timing.ts";
import { brollEntries, brollSortedForList } from "../core/production/broll.ts";
import { ROW_STATUSES, TAG_CATEGORIES, rowStatus } from "../core/production/looks.ts";
import { deriveProductionIndex } from "../core/production/tags.ts";
import { formatDuration, pad2, rowSeconds as rowSecondsIn, targetClock } from "../core/production/timing.ts";
import { toHtml } from "../core/text/html.ts";
import { toDocxRuns } from "../core/text/projections.ts";
import { cacheSeal } from "../legacy/cache-freeze.ts";
import { productionReaders } from "../legacy/document-ports.ts";
import { htmlToPlainText } from "../legacy/plain-text.ts";
import { cellOf, inertBody } from "../legacy/richtext.ts";
import { readSession } from "../legacy/session-bridge.ts";
import { refsIn, sniffImageMime } from "../../shared/blob-policy.js";

export { sceneFacts };

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
  try {
    return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }).format(d);
  } catch (e) {
    return d.toDateString();
  }
}

function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

function exportReadModels(doc) {
  return {
    production: deriveProductionIndex(doc, productionReaders).entries,
    commentNumbers: numberComments(doc),
    broll: brollEntries(doc, productionReaders, randomIds, htmlToPlainText, false).entries
  };
}

var capturePorts = { read: readSession, readModels: exportReadModels, clock: systemClock };

export function captureExportDocument(opts) {
  return captureWith(capturePorts, opts);
}

export function exportDay(doc) {
  var at = new Date(doc.capturedAt);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

var assetPorts = {
  load: function (shas, source) { return ensureBytes(shas, { source: source }); },
  bytes: bytesForSync,
  mime: function (sha, bytes) {
    var rec = recordFor(sha);
    return (rec && rec.mime) || sniffImageMime(bytes) || null;
  }
};

export function exportAssetsRequest(doc, source) {
  return exportAssetRequest(refsIn(doc.document), source || null);
}

export function loadExportAssets(request) {
  return resolveExportAssets(request, assetPorts);
}

export function exportAssetsNow(doc) {
  return heldExportAssets(exportAssetsRequest(doc, null), assetPorts);
}

export function capturedPicture(assets, ref) {
  var held = ref && assets ? assets.picture(ref.sha256) : null;
  return held ? { bytes: held.bytes, mime: ref.mime, width: ref.width, height: ref.height } : null;
}

export function capturedRowPicture(assets, row) {
  var img = rowImage(row);
  if (!img) return null;
  return img.ref ? capturedPicture(assets, img.ref) : dataUrlPicture(img.dataUrl);
}

export function exportDocumentOf(state, opts) {
  var doc = migrateRows(JSON.parse(JSON.stringify(state)));
  return buildExportDocument(doc, systemClock.nowIso(), exportReadModels(doc), opts);
}

export function exportFacts(doc) {
  var s = doc.document;
  var rows = s.rows || [];
  var seconds = 0, words = 0;
  var status = { todo: 0, ready: 0, shot: 0 };
  rows.forEach(function (r) {
    seconds += rowSecondsIn(r, s, productionReaders);
    words += productionReaders.wordCount(r.audioText);
    var st = rowStatus(r.status) || ROW_STATUSES[0];
    status[st.id]++;
  });
  var target = targetLengthOf(s);
  var clock = target === null ? null : targetClock(seconds, target);
  var when = new Date(doc.capturedAt);
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
  var out = [plural(facts.scenes, "scene"), facts.runtime + " running time"];
  if (facts.target) {
    out.push("Target " + facts.target.text + " · " +
      (facts.target.delta === "0:00" ? "on target" : facts.target.delta + (facts.target.over ? " over" : " under")));
  }
  if (facts.scenes) out.push(facts.status.shot + " of " + facts.scenes + " shot");
  return out;
}

export function commentNumbers(doc) {
  return doc.commentNumbers;
}

var anchorOrder = contentMemo(function (html) {
  var spans = Array.prototype.slice.call(inertBody(toHtml(cellOf(html))).querySelectorAll(".cmt-anchor"));
  spans.sort(function (a, b) {
    if (a.contains(b)) return 1;
    if (b.contains(a)) return -1;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return spans.map(function (el) { return el.getAttribute("data-cmt"); });
}, cacheSeal);

function numberComments(state) {
  var open = Object.create(null);
  (state.comments || []).forEach(function (c) {
    if (c && c.id && !c.resolved && c.field !== "title") open[c.id] = true;
  });
  var nums = Object.create(null), n = 0;
  (state.rows || []).forEach(function (row) {
    ["visualText", "audioText"].forEach(function (field) {
      var html = row[field] || "";
      if (html.indexOf("cmt-anchor") === -1) return;
      anchorOrder(html).forEach(function (id) {
        if (!open[id]) return;
        n++;
        if (!nums[id]) nums[id] = n;
      });
    });
  });
  return nums;
}

export function exportComments(doc, opts) {
  var nums = doc.commentNumbers;
  var list = commentEntries(doc, Object.assign({ clockMode: readClockPref() }, opts || { pieces: true })).map(function (c) {
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

export function breakdownGroups(doc) {
  var rows = breakdownRows(doc);
  return TAG_CATEGORIES.map(function (cat) {
    return {
      catId: cat.id,
      label: cat.plural,
      color: tagPrintColor(cat.id),
      items: rows.filter(function (r) { return r.catId === cat.id; })
    };
  }).filter(function (g) { return g.items.length; });
}

export function exportBrollScenes(doc) {
  var facts = sceneFacts(doc);
  var groups = [], byRow = Object.create(null);
  brollSortedForList(doc.broll).forEach(function (e) {
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
    var rec = shotRecordForFile(e, doc.people);
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
