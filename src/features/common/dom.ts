export function cssAttr(value: unknown): string {
  return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function isInsideTagOrLink(el: Element | null | undefined): boolean {
  return !!(el && el.closest && el.closest(".tag-anchor, .who-anchor, a"));
}

export function ensureTrailingCaretSpot(container: Node | null | undefined): void {
  const last = container && container.lastChild;
  if (last && last.nodeType === 1 && "getAttribute" in last && typeof last.getAttribute === "function" && last.getAttribute("contenteditable") === "false") {
    container?.appendChild(document.createTextNode("​"));
  }
}
