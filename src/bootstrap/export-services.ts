import type { ExportServices } from "../application/export/services.ts";
import { cacheSeal } from "../legacy/cache-freeze.ts";
import { productionReaders } from "../legacy/document-ports.ts";
import { htmlToPlainText } from "../legacy/plain-text.ts";
import { cellOf, fromHtml, htmlToMarkdown, inertBody } from "../legacy/richtext.ts";

export function legacyExportServices(): ExportServices<HTMLElement> {
  return { cellOf, inertBody, fromHtml, htmlToMarkdown, htmlToPlainText, productionReaders, cacheSeal };
}
