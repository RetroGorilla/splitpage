import type { TextServices } from "../../../application/text/services.ts";
import { retagTagAnchors } from "../../../adapters/richtext/tag-anchors.ts";
import { cacheSeal } from "../../cache-freeze.ts";
import { productionReaders } from "../../document-ports.ts";
import { htmlToPlainText } from "../../../bootstrap/plain-text.ts";
import { cellOf, fromHtml, htmlToMarkdown, inertBody, cleanPastedCell, sanitizeHtml, storedHtmlFromDom } from "../../richtext.ts";
import { buildVideoCardEl } from "../../richtext.ts";
import { videoHostLabel } from "../../../adapters/formats/video-host.ts";

export const video = { card: buildVideoCardEl, hostLabel: videoHostLabel };

export const text: TextServices<HTMLElement> = {
  cellOf, inertBody, cleanPastedCell, fromHtml, sanitizeHtml, storedHtmlFromDom, htmlToMarkdown, htmlToPlainText, productionReaders, cacheSeal,
  retagBody: retagTagAnchors
};
