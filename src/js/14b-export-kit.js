import { migrateRows } from "./02-state.js";
import { tagPrintColor } from "../adapters/formats/print-colors.ts";
import { randomIds, systemClock } from "../adapters/identity/ids.ts";
import { exportServices } from "../application/export/services.ts";
import { resolveExportAssets } from "../application/export/assets.ts";
import { assetPorts } from "../adapters/formats/export-assets.ts";
import { captureExportDocument as captureWith } from "../application/save/capture.ts";
import { buildExportDocument } from "../core/document/export-document.ts";
import { contentMemo } from "../core/document/memo.ts";
import { deriveProductionIndex } from "../core/production/tags.ts";
import { toHtml } from "../core/text/html.ts";
import { toDocxRuns } from "../core/text/projections.ts";
import { readSession } from "../legacy/session-bridge.ts";
import { preferences } from "../legacy/preferences-bridge.ts";

import { brollEntries } from "../core/production/broll.ts";

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

function exportReadModels(doc) {
  var services = exportServices();
  return {
    production: deriveProductionIndex(doc, services.productionReaders).entries,
    commentNumbers: numberComments(doc),
    broll: brollEntries(doc, services.productionReaders, randomIds, services.htmlToPlainText)
  };
}

var capturePorts = { read: readSession, readModels: exportReadModels, clock: systemClock };

function withClock(opts) {
  return Object.assign({ clockMode: preferences().clock() }, opts);
}

export function captureExportDocument(opts) {
  return captureWith(capturePorts, withClock(opts));
}

export function loadExportAssets(request) {
  return resolveExportAssets(request, assetPorts);
}

export function exportDocumentOf(state, opts) {
  var doc = migrateRows(JSON.parse(JSON.stringify(state)));
  return buildExportDocument(doc, systemClock.nowIso(), exportReadModels(doc), withClock(opts));
}

export function commentNumbers(doc) {
  return doc.commentNumbers;
}

var anchorOrder = contentMemo(function (html) {
  var services = exportServices();
  var spans = Array.prototype.slice.call(services.inertBody(toHtml(services.cellOf(html))).querySelectorAll(".cmt-anchor"));
  spans.sort(function (a, b) {
    if (a.contains(b)) return 1;
    if (b.contains(a)) return -1;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return spans.map(function (el) { return el.getAttribute("data-cmt"); });
}, function (value) { return exportServices().cacheSeal(value); });

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

export function exportRuns(html, nums) {
  var runs = toDocxRuns(exportServices().cellOf(html), { annotate: true });
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

export function __init() {}
