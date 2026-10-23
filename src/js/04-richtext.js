import { randomIds } from "../adapters/identity/ids.ts";
import {
  plainName,
  plainText,
  safeHref,
  safeId as safeIdFrom,
  safeImageSrc,
  storedImageHtml
} from "../core/document/text-policy.ts";
export { plainName, plainText, safeHref, safeImageSrc, storedImageHtml };
export {
  buildVideoCardEl,
  htmlToMarkdown,
  imageRefOf,
  inertBody,
  sanitizeHtml,
  storedHtmlFromDom
} from "../legacy/richtext.ts";

export function safeId(id, prefix) {
  return safeIdFrom(id, prefix, randomIds);
}

export function ensureTrailingCaretSpot(container) {
  var last = container && container.lastChild;
  if (last && last.nodeType === 1 && last.getAttribute && last.getAttribute("contenteditable") === "false") {
    container.appendChild(document.createTextNode("​"));
  }
}

export function __init() {}
