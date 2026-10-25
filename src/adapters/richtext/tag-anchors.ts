import { normalizeTagName } from "../../core/document/tags.ts";

export function retagTagAnchors(body: HTMLElement, cat: string, target: string, toName: string | null): string {
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
