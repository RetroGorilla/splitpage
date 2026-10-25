import type { TextServices } from "../../../application/text/services.ts";
import { retagTagAnchors } from "../../../adapters/richtext/tag-anchors.ts";
import { cacheSeal } from "../../../legacy/cache-freeze.ts";
import { productionReaders } from "../../../legacy/document-ports.ts";
import { htmlToPlainText } from "../../../legacy/plain-text.ts";
import { cellOf, fromHtml, htmlToMarkdown, inertBody, sanitizeHtml, storedHtmlFromDom } from "../../../legacy/richtext.ts";

export const text: TextServices<HTMLElement> = {
  cellOf, inertBody, fromHtml, sanitizeHtml, storedHtmlFromDom, htmlToMarkdown, htmlToPlainText, productionReaders, cacheSeal,
  retagBody: retagTagAnchors
};
