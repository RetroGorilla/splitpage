import { readPref, writePref } from "./00p-prefs.js";
import { exportDay, exportFacts, exportBrollScenes } from "./14b-export-kit.js";
import { brollShotListForPrint } from "./14c-export-projections.js";
import {
  exportMetaLine,
  htmlToPlainScript,
  markdownExportImages,
  toMarkdownDoc,
  toMarkdownTableDoc
} from "./14d-export-text.js";
import {
  buildDocx,
  buildNarrationDocx,
  buildNarrationText,
  narrationRows
} from "./15-docx.js";
import { buildBreakdownCsv, buildBrollCsv, buildCsv } from "./16-csv.js";
import { buildBreakdownXlsx, buildBrollXlsx, buildScriptXlsx } from "./16b-xlsx.js";
import {
  buildPackingListPdf,
  buildPdf,
  buildShotListPdf,
  pdfCommentImagesFor,
  pdfImagesFor
} from "./17-pdf.js";
import { strBytes } from "../adapters/formats/bytes.ts";
import { zipWrite } from "../adapters/formats/zip.ts";
import { tagCategory } from "../core/production/looks.ts";
import { exportFormats } from "../legacy/export-formats.ts";

export var NARRATION_DIRECTIONS_KEY = "splitpage-export-directions";

export function narrationIncludesDirections() {
  return readPref(NARRATION_DIRECTIONS_KEY) !== "0";
}

export function setNarrationIncludesDirections(on) {
  writePref(NARRATION_DIRECTIONS_KEY, on ? null : "0");
}

export function exportToggleOptions(exporter, overrides) {
  var out = {};
  var card = exporter && exporter.card ? exportFormats.card(exporter.card) : null;
  var toggle = card && card.toggle;
  if (toggle) {
    out[toggle.id] = overrides && typeof overrides[toggle.id] === "boolean" ? overrides[toggle.id] : toggle.on();
  }
  return out;
}

function suffixed(suffix) {
  return function (base) { return base + suffix; };
}

function product(data) {
  return { data: data };
}

function packingLabel(catId) {
  var cat = tagCategory(catId);
  return cat ? cat.label : catId;
}

function packingReason(catId) {
  return function (doc) {
    var has = doc.production.some(function (e) { return e.catId === catId; });
    return has ? "" : "Nothing tagged " + packingLabel(catId) + " yet — nothing to pack";
  };
}

function narrationReason(doc) {
  return narrationRows(doc, { directions: narrationIncludesDirections() }).length
    ? "" : "The Audio column is empty — there is no narration yet";
}

function brollReason(doc) {
  return exportBrollScenes(doc).length ? "" : "No b-roll yet — start a Visual line with \"B-roll:\"";
}

var CARDS = [
  { id: "pdf", group: "whole", name: "PDF", ext: ".pdf", icon: "i-file",
    purpose: "To print, or to send someone to read", pictures: true, extras: true },
  { id: "docx", group: "whole", name: "Word", ext: ".docx", icon: "i-file",
    purpose: "To keep writing in Word or Google Docs", pictures: true, extras: true },
  { id: "md", group: "whole", name: "Markdown", ext: ".md", icon: "i-file",
    purpose: "Plain text that reads anywhere", pictures: true, extras: true, option: "Shape" },
  { id: "csv", group: "whole", name: "Spreadsheet", ext: ".xlsx / .csv", icon: "i-file",
    purpose: "A row per scene, for Excel, Sheets or Numbers", option: "Format" },
  { id: "html", group: "whole", name: "SplitShare", ext: ".html", icon: "i-globe",
    purpose: "The script and the whole app in one file. Any device, nothing to install", pictures: true },
  { id: "narration", group: "part", name: "Narration only", ext: ".docx / .txt", icon: "i-mic",
    purpose: "The Audio column, for a voice artist", option: "Format",
    toggle: { id: "directions", label: "Include stage directions",
              on: narrationIncludesDirections, set: setNarrationIncludesDirections } },
  { id: "breakdown", group: "part", name: "Breakdown", ext: ".xlsx / .csv", icon: "i-tag",
    purpose: "Every tagged item, its status and owner", option: "Format" },
  { id: "packing", group: "part", name: "Packing list", ext: ".pdf", icon: "i-box",
    purpose: "A checklist for the shoot: out, back, and signed off", option: "List" },
  { id: "broll", group: "part", name: "B-roll shot list", ext: ".pdf / .xlsx / .csv", icon: "i-camera",
    purpose: "Every shot, with props, flags and room for notes", option: "Format" }
];

var EXPORTERS = [
  { id: "pdf", action: "export-pdf", card: "pdf", name: "PDF", menuLabel: "PDF (.pdf)",
    words: "pdf print", fileName: suffixed(".pdf"),
    build: async function (ctx) {
      var jpegs = await pdfImagesFor(ctx.doc, ctx.assets);
      var commentJpegs = await pdfCommentImagesFor(ctx.doc, ctx.assets);
      return product(buildPdf(ctx.doc, jpegs, commentJpegs));
    } },
  { id: "docx", action: "export-docx", card: "docx", name: "Word", menuLabel: "Word (.docx)",
    words: "word docx document google docs", writeback: true, fileName: suffixed(".docx"),
    build: function (ctx) { return product(buildDocx(ctx.doc, ctx.assets)); } },
  { id: "md", action: "export-md", card: "md", choice: { value: "stacked", label: "Stacked" },
    name: "Markdown", menuLabel: "Markdown (.md)", words: "markdown md text stacked",
    writeback: true, bundlesPictures: true,
    fileName: function (base, opts) { return opts && opts.imageBundle ? base + " (with images).zip" : base + ".md"; },
    build: function (ctx, base) {
      if (ctx.options.allowImageBundle) {
        var images = markdownExportImages(ctx.doc, ctx.assets);
        if (images.length) {
          var entries = [{ name: base + ".md", data: strBytes(toMarkdownDoc(ctx.doc, { assets: ctx.assets })) }];
          images.forEach(function (img) { entries.push({ name: img.path, data: img.bytes }); });
          return { data: zipWrite(entries, exportDay(ctx.doc)), imageBundle: true };
        }
      }
      return product(toMarkdownDoc(ctx.doc, { assets: ctx.assets }));
    } },
  { id: "md-table", action: "export-md-table", card: "md", choice: { value: "table", label: "Two columns" },
    name: "Markdown, two columns", menuLabel: "Markdown, two columns (.md)",
    words: "markdown md table two columns side by side", fileName: suffixed(" - two column.md"),
    build: function (ctx) { return product(toMarkdownTableDoc(ctx.doc, { export: true })); } },
  { id: "xlsx", action: "export-xlsx", card: "csv", choice: { value: "xlsx", label: "Excel (.xlsx)" },
    name: "Excel", menuLabel: "Spreadsheet (.xlsx)",
    words: "excel xlsx spreadsheet workbook sheets numbers table", fileName: suffixed(".xlsx"),
    build: function (ctx) { return product(buildScriptXlsx(ctx.doc)); } },
  { id: "csv", action: "export-csv", card: "csv", choice: { value: "csv", label: "CSV (.csv)" },
    name: "CSV", menuLabel: "Spreadsheet (.csv)", words: "spreadsheet csv excel sheets table",
    writeback: true, fileName: suffixed(".csv"),
    build: function (ctx) { return product(buildCsv(ctx.doc)); } },
  { id: "html", action: "export-html", card: "html", name: "SplitShare", menuLabel: "SplitShare (.html)",
    words: "splitshare share standalone page html web browser send any device app",
    fileName: suffixed(" - SplitShare.html"),
    build: function (ctx) {
      return {
        data: ctx.ports.standaloneHtml(ctx.doc, {
          title: (ctx.doc.title || "Untitled Script") + " — SplitShare",
          description: exportMetaLine(exportFacts(ctx.doc))
        }, ctx.assets),
        diagnostics: { imagesLeftOut: ctx.assets.missing.length }
      };
    } },
  { id: "narration-docx", action: "export-narration-docx", card: "narration",
    choice: { value: "docx", label: "Word (.docx)" }, name: "Narration (.docx)",
    menuLabel: "Narration only (.docx)", words: "narration voice over voiceover audio artist word docx",
    reason: narrationReason, refusal: "There is no narration to export yet — the Audio column is empty.",
    fileName: suffixed(" - narration.docx"),
    build: function (ctx) { return product(buildNarrationDocx(ctx.doc, { directions: ctx.options.directions })); } },
  { id: "narration-txt", action: "export-narration-txt", card: "narration",
    choice: { value: "txt", label: "Plain text (.txt)" }, name: "Narration (.txt)",
    menuLabel: "Narration only (.txt)", words: "narration voice over voiceover audio artist text txt",
    reason: narrationReason, refusal: "There is no narration to export yet — the Audio column is empty.",
    fileName: suffixed(" - narration.txt"),
    build: function (ctx) { return product(buildNarrationText(ctx.doc, { directions: ctx.options.directions })); } },
  { id: "breakdown xlsx", action: "export-breakdown-xlsx", card: "breakdown",
    choice: { value: "xlsx", label: "Excel (.xlsx)" }, name: "Breakdown (Excel)",
    menuLabel: "Breakdown (.xlsx)",
    words: "breakdown excel xlsx spreadsheet workbook tags props locations cast list",
    fileName: suffixed(" - breakdown.xlsx"),
    build: function (ctx) { return product(buildBreakdownXlsx(ctx.doc)); } },
  { id: "breakdown", action: "export-breakdown", card: "breakdown",
    choice: { value: "csv", label: "CSV (.csv)" }, name: "Breakdown (.csv)", menuLabel: "Breakdown (.csv)",
    words: "breakdown csv tags props locations cast list", fileName: suffixed(" - breakdown.csv"),
    build: function (ctx) { return product(buildBreakdownCsv(ctx.doc)); } },
  { id: "packing-gear", action: "export-packing-gear", card: "packing",
    choice: { value: "gear", label: "Gear" }, name: "Gear packing list", menuLabel: "Gear packing list (.pdf)",
    words: "packing list checklist gear equipment kit pdf", reason: packingReason("gear"),
    fileName: function (base) { return base + " - " + packingLabel("gear") + " packing list.pdf"; },
    build: function (ctx) { return product(buildPackingListPdf(ctx.doc, "gear")); } },
  { id: "packing-prop", action: "export-packing-prop", card: "packing",
    choice: { value: "prop", label: "Props" }, name: "Props packing list", menuLabel: "Props packing list (.pdf)",
    words: "packing list checklist props prop pdf", reason: packingReason("prop"),
    fileName: function (base) { return base + " - " + packingLabel("prop") + " packing list.pdf"; },
    build: function (ctx) { return product(buildPackingListPdf(ctx.doc, "prop")); } },
  { id: "b-roll pdf", action: "export-broll-pdf", card: "broll", choice: { value: "pdf", label: "PDF, landscape" },
    name: "B-roll shot list", menuLabel: "B-roll shot list (.pdf)",
    words: "b-roll broll shot list shots second unit print pdf landscape",
    reason: brollReason, refusal: "There is no b-roll to export yet — start a Visual line with B-roll:",
    defaults: { brollView: { filter: "all", group: "scene" } },
    fileName: suffixed(" - b-roll shot list.pdf"),
    build: function (ctx) {
      return product(buildShotListPdf(ctx.doc, brollShotListForPrint(ctx.doc, ctx.options.brollView)));
    } },
  { id: "b-roll xlsx", action: "export-broll-xlsx", card: "broll", choice: { value: "xlsx", label: "Excel (.xlsx)" },
    name: "B-roll shot list (Excel)", menuLabel: "B-roll shot list (.xlsx)",
    words: "b-roll broll shot list shots excel xlsx spreadsheet workbook sheets",
    reason: brollReason, refusal: "There is no b-roll to export yet — start a Visual line with B-roll:",
    fileName: suffixed(" - b-roll shot list.xlsx"),
    build: function (ctx) { return product(buildBrollXlsx(ctx.doc)); } },
  { id: "b-roll csv", action: "export-broll-csv", card: "broll", choice: { value: "csv", label: "CSV (.csv)" },
    name: "B-roll shot list (.csv)", menuLabel: "B-roll shot list (.csv)",
    words: "b-roll broll shot list shots spreadsheet csv excel sheets",
    reason: brollReason, refusal: "There is no b-roll to export yet — start a Visual line with B-roll:",
    fileName: suffixed(" - b-roll shot list.csv"),
    build: function (ctx) { return product(buildBrollCsv(ctx.doc)); } },
  { id: "txt", writeback: true, fileName: suffixed(".txt"),
    build: function (ctx) { return product(htmlToPlainScript(ctx.doc)); } }
];

export function registerBuiltInExporters() {
  CARDS.forEach(function (card) { exportFormats.defineCard(card); });
  EXPORTERS.forEach(function (exporter) { exportFormats.register(exporter); });
}

registerBuiltInExporters();
