import type { TextServices } from "../../../application/text/services.ts";
import { normalizeTagName } from "../../../core/document/tags.ts";
import { cacheSeal } from "../../../legacy/cache-freeze.ts";
import { productionReaders } from "../../../legacy/document-ports.ts";
import { htmlToPlainText } from "../../../legacy/plain-text.ts";
import { cellOf, fromHtml, htmlToMarkdown, inertBody, sanitizeHtml, storedHtmlFromDom } from "../../../legacy/richtext.ts";

export const text: TextServices<HTMLElement> = {
  cellOf, inertBody, fromHtml, sanitizeHtml, storedHtmlFromDom, htmlToMarkdown, htmlToPlainText, productionReaders, cacheSeal,
  retagBody(body, cat, target, toName) {
    body.querySelectorAll(".tag-anchor").forEach(function (el) {
      if (el.getAttribute("data-tag-cat") !== cat) return;
      if (normalizeTagName(el.getAttribute("data-tag-name")) !== target) return;
      if (toName !== null) { el.setAttribute("data-tag-name", toName); return; }
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });
    return body.innerHTML;
  }
};
