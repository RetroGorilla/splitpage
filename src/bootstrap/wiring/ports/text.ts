import type { TextServices } from "../../../application/text/services.ts";
import { retagTagAnchors } from "../../../adapters/richtext/tag-anchors.ts";
import { cacheSeal } from "../../../legacy/cache-freeze.ts";
import { productionReaders } from "../../document-ports.ts";
import { htmlToPlainText } from "../../../bootstrap/plain-text.ts";
import { cellOf, fromHtml, htmlToMarkdown, inertBody, sanitizeHtml, storedHtmlFromDom } from "../../../legacy/richtext.ts";
import { buildVideoCardEl } from "../../../legacy/richtext.ts";
import { videoHostLabel } from "../../../adapters/formats/video-host.ts";

export const video = { card: buildVideoCardEl, hostLabel: videoHostLabel };

export const text: TextServices<HTMLElement> = {
  cellOf, inertBody, fromHtml, sanitizeHtml, storedHtmlFromDom, htmlToMarkdown, htmlToPlainText, productionReaders, cacheSeal,
  retagBody: retagTagAnchors
};
