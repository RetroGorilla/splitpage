import type { ExportCardDecl, ExportProduct, ExportRegistry, ExporterDecl } from "../../application/export/registry.ts";
import type { ExportAssets } from "../../application/export/assets.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import { strBytes } from "../../adapters/formats/bytes.ts";
import { zipWrite } from "../../adapters/formats/zip.ts";
import { tagCategory } from "../../core/production/looks.ts";
import { readPref, writePref } from "../../js/00p-prefs.js";
import { exportBrollScenes, exportDay, exportFacts } from "../../js/14b-export-kit.js";
import { brollShotListForPrint } from "../../js/14c-export-projections.js";
import {
  exportMetaLine,
  htmlToPlainScript,
  markdownExportImages,
  toMarkdownDoc,
  toMarkdownTableDoc
} from "../../js/14d-export-text.js";
import {
  buildDocx,
  buildNarrationDocx,
  buildNarrationText,
  narrationRows
} from "../../js/15-docx.js";
import { buildBreakdownCsv, buildBrollCsv, buildCsv } from "../../js/16-csv.js";
import { buildBreakdownXlsx, buildBrollXlsx, buildScriptXlsx } from "../../js/16b-xlsx.js";
import {
  buildPackingListPdf,
  buildPdf,
  buildShotListPdf,
  pdfCommentImagesFor,
  pdfImagesFor
} from "../../js/17-pdf.js";

export interface ExportBuild {
  readonly doc: ExportDocument;
  readonly options: Readonly<Record<string, unknown>>;
  readonly assets: ExportAssets;
  readonly ports: { readonly standaloneHtml: (doc: ExportDocument, meta: { title: string; description: string }, assets: ExportAssets) => string };
}

type BuiltInExporter = ExporterDecl<ExportBuild, ExportDocument>;

const NARRATION_DIRECTIONS_KEY = "splitpage-export-directions";

export function narrationIncludesDirections(): boolean {
  return readPref(NARRATION_DIRECTIONS_KEY) !== "0";
}

export function setNarrationIncludesDirections(on: boolean): void {
  writePref(NARRATION_DIRECTIONS_KEY, on ? null : "0");
}

function suffixed(suffix: string): (base: string) => string {
  return (base) => base + suffix;
}

function product(data: string | Uint8Array): ExportProduct {
  return { data: data };
}

function packingLabel(catId: string): string {
  const cat = tagCategory(catId);
  return cat ? cat.label : catId;
}

function packingReason(catId: string): (doc: ExportDocument) => string {
  return (doc) => {
    const has = doc.production.some((e) => e.catId === catId);
    return has ? "" : "Nothing tagged " + packingLabel(catId) + " yet — nothing to pack";
  };
}

function narrationReason(doc: ExportDocument): string {
  return narrationRows(doc, { directions: narrationIncludesDirections() }).length
    ? "" : "The Audio column is empty — there is no narration yet";
}

function brollReason(doc: ExportDocument): string {
  return exportBrollScenes(doc).length ? "" : "No b-roll yet — start a Visual line with \"B-roll:\"";
}

const CARDS: readonly ExportCardDecl[] = [
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

const EXPORTERS: readonly BuiltInExporter[] = [
  { id: "pdf", action: "export-pdf", card: "pdf", name: "PDF", menuLabel: "PDF (.pdf)",
    words: "pdf print", fileName: suffixed(".pdf"),
    build: async (ctx) => {
      const jpegs = await pdfImagesFor(ctx.doc, ctx.assets);
      const commentJpegs = await pdfCommentImagesFor(ctx.doc, ctx.assets);
      return product(buildPdf(ctx.doc, jpegs, commentJpegs));
    } },
  { id: "docx", action: "export-docx", card: "docx", name: "Word", menuLabel: "Word (.docx)",
    words: "word docx document google docs", writeback: true, fileName: suffixed(".docx"),
    build: (ctx) => product(buildDocx(ctx.doc, ctx.assets)) },
  { id: "md", action: "export-md", card: "md", choice: { value: "stacked", label: "Stacked" },
    name: "Markdown", menuLabel: "Markdown (.md)", words: "markdown md text stacked",
    writeback: true, bundlesPictures: true,
    fileName: (base, opts) => opts && opts.imageBundle ? base + " (with images).zip" : base + ".md",
    build: (ctx, base) => {
      if (ctx.options.allowImageBundle) {
        const images = markdownExportImages(ctx.doc, ctx.assets);
        if (images.length) {
          const entries: { name: string; data: Uint8Array }[] = [{ name: base + ".md", data: strBytes(toMarkdownDoc(ctx.doc, { assets: ctx.assets })) }];
          images.forEach((img: { path: string; bytes: Uint8Array }) => { entries.push({ name: img.path, data: img.bytes }); });
          return { data: zipWrite(entries, exportDay(ctx.doc)), imageBundle: true };
        }
      }
      return product(toMarkdownDoc(ctx.doc, { assets: ctx.assets }));
    } },
  { id: "md-table", action: "export-md-table", card: "md", choice: { value: "table", label: "Two columns" },
    name: "Markdown, two columns", menuLabel: "Markdown, two columns (.md)",
    words: "markdown md table two columns side by side", fileName: suffixed(" - two column.md"),
    build: (ctx) => product(toMarkdownTableDoc(ctx.doc, { export: true, assets: ctx.assets })) },
  { id: "xlsx", action: "export-xlsx", card: "csv", choice: { value: "xlsx", label: "Excel (.xlsx)" },
    name: "Excel", menuLabel: "Spreadsheet (.xlsx)",
    words: "excel xlsx spreadsheet workbook sheets numbers table", fileName: suffixed(".xlsx"),
    build: (ctx) => product(buildScriptXlsx(ctx.doc)) },
  { id: "csv", action: "export-csv", card: "csv", choice: { value: "csv", label: "CSV (.csv)" },
    name: "CSV", menuLabel: "Spreadsheet (.csv)", words: "spreadsheet csv excel sheets table",
    writeback: true, fileName: suffixed(".csv"),
    build: (ctx) => product(buildCsv(ctx.doc)) },
  { id: "html", action: "export-html", card: "html", name: "SplitShare", menuLabel: "SplitShare (.html)",
    words: "splitshare share standalone page html web browser send any device app",
    fileName: suffixed(" - SplitShare.html"),
    build: (ctx) => {
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
    build: (ctx) => product(buildNarrationDocx(ctx.doc, { directions: ctx.options.directions })) },
  { id: "narration-txt", action: "export-narration-txt", card: "narration",
    choice: { value: "txt", label: "Plain text (.txt)" }, name: "Narration (.txt)",
    menuLabel: "Narration only (.txt)", words: "narration voice over voiceover audio artist text txt",
    reason: narrationReason, refusal: "There is no narration to export yet — the Audio column is empty.",
    fileName: suffixed(" - narration.txt"),
    build: (ctx) => product(buildNarrationText(ctx.doc, { directions: ctx.options.directions })) },
  { id: "breakdown xlsx", action: "export-breakdown-xlsx", card: "breakdown",
    choice: { value: "xlsx", label: "Excel (.xlsx)" }, name: "Breakdown (Excel)",
    menuLabel: "Breakdown (.xlsx)",
    words: "breakdown excel xlsx spreadsheet workbook tags props locations cast list",
    fileName: suffixed(" - breakdown.xlsx"),
    build: (ctx) => product(buildBreakdownXlsx(ctx.doc)) },
  { id: "breakdown", action: "export-breakdown", card: "breakdown",
    choice: { value: "csv", label: "CSV (.csv)" }, name: "Breakdown (.csv)", menuLabel: "Breakdown (.csv)",
    words: "breakdown csv tags props locations cast list", fileName: suffixed(" - breakdown.csv"),
    build: (ctx) => product(buildBreakdownCsv(ctx.doc)) },
  { id: "packing-gear", action: "export-packing-gear", card: "packing",
    choice: { value: "gear", label: "Gear" }, name: "Gear packing list", menuLabel: "Gear packing list (.pdf)",
    words: "packing list checklist gear equipment kit pdf", reason: packingReason("gear"),
    fileName: (base) => base + " - " + packingLabel("gear") + " packing list.pdf",
    build: (ctx) => product(buildPackingListPdf(ctx.doc, "gear")) },
  { id: "packing-prop", action: "export-packing-prop", card: "packing",
    choice: { value: "prop", label: "Props" }, name: "Props packing list", menuLabel: "Props packing list (.pdf)",
    words: "packing list checklist props prop pdf", reason: packingReason("prop"),
    fileName: (base) => base + " - " + packingLabel("prop") + " packing list.pdf",
    build: (ctx) => product(buildPackingListPdf(ctx.doc, "prop")) },
  { id: "b-roll pdf", action: "export-broll-pdf", card: "broll", choice: { value: "pdf", label: "PDF, landscape" },
    name: "B-roll shot list", menuLabel: "B-roll shot list (.pdf)",
    words: "b-roll broll shot list shots second unit print pdf landscape",
    reason: brollReason, refusal: "There is no b-roll to export yet — start a Visual line with B-roll:",
    defaults: { brollView: { filter: "all", group: "scene" } },
    fileName: suffixed(" - b-roll shot list.pdf"),
    build: (ctx) => {
      return product(buildShotListPdf(ctx.doc, brollShotListForPrint(ctx.doc, ctx.options.brollView)));
    } },
  { id: "b-roll xlsx", action: "export-broll-xlsx", card: "broll", choice: { value: "xlsx", label: "Excel (.xlsx)" },
    name: "B-roll shot list (Excel)", menuLabel: "B-roll shot list (.xlsx)",
    words: "b-roll broll shot list shots excel xlsx spreadsheet workbook sheets",
    reason: brollReason, refusal: "There is no b-roll to export yet — start a Visual line with B-roll:",
    fileName: suffixed(" - b-roll shot list.xlsx"),
    build: (ctx) => product(buildBrollXlsx(ctx.doc)) },
  { id: "b-roll csv", action: "export-broll-csv", card: "broll", choice: { value: "csv", label: "CSV (.csv)" },
    name: "B-roll shot list (.csv)", menuLabel: "B-roll shot list (.csv)",
    words: "b-roll broll shot list shots spreadsheet csv excel sheets",
    reason: brollReason, refusal: "There is no b-roll to export yet — start a Visual line with B-roll:",
    fileName: suffixed(" - b-roll shot list.csv"),
    build: (ctx) => product(buildBrollCsv(ctx.doc)) },
  { id: "txt", writeback: true, fileName: suffixed(".txt"),
    build: (ctx) => product(htmlToPlainScript(ctx.doc)) }
];

export function registerBuiltInExporters(registry: ExportRegistry): () => void {
  const drops: (() => void)[] = [];
  CARDS.forEach((card) => { drops.push(registry.defineCard(card)); });
  EXPORTERS.forEach((exporter) => { drops.push(registry.register(exporter as ExporterDecl)); });
  return () => {
    while (drops.length) drops.pop()?.();
  };
}
