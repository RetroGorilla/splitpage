import type { ImportFormats } from "../../../application/formats/import-formats.ts";
import { parseImportRows, detectTwoColumnFormat } from "../../../adapters/formats/import-text.js";
import { normalizeImportedRows } from "../../../adapters/formats/import-rows.ts";
import { csvToRows } from "../../../adapters/formats/csv.ts";
import { docxToRows } from "../../../adapters/formats/docx.ts";
import { anchorBrollInRows } from "../../../adapters/production/broll-anchors.ts";
import { ids } from "./identity.ts";
import { brollAnchoring } from "./preferences.ts";
import { text } from "./text.ts";

export const importFormats: ImportFormats = {
  parse: parseImportRows,
  detect: detectTwoColumnFormat,
  normalize: normalizeImportedRows,
  csv: csvToRows,
  docx: docxToRows,
  anchorBroll: (doc, rows) => anchorBrollInRows(doc, rows, { readers: text.productionReaders, ids, cellOf: text.cellOf, inertBody: text.inertBody, sanitize: text.sanitizeHtml, declined: brollAnchoring.declined }),
  declineBroll: brollAnchoring.decline
};
