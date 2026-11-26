export function cssAttr(value: unknown): string {
  return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function isInsideTagOrLink(el: Element | null | undefined): boolean {
  return !!el?.closest(".tag-anchor, .who-anchor, a");
}

export function isInsideProtectedTagOrLink(el: Element | null | undefined): boolean {
  if (!el?.closest) return false;
  if (el.closest(".who-anchor, a")) return true;
  return !!protectedTagAt(el);
}

export function protectedTagAt(el: Element | null): Element | null {
  let protectedTag: Element | null = null;
  for (let tag = el?.closest(".tag-anchor"); tag; tag = tag.parentElement?.closest(".tag-anchor")) {
    if (tag.hasAttribute("data-tag-editing")) return protectedTag;
    if (tag.getAttribute("contenteditable") !== "true") protectedTag = tag;
  }
  return protectedTag;
}

export function ensureTrailingCaretSpot(container: Node | null | undefined): void {
  const last = container && container.lastChild;
  if (last && last.nodeType === 1 && "getAttribute" in last && typeof last.getAttribute === "function" && last.getAttribute("contenteditable") === "false") {
    container?.appendChild(document.createTextNode("​"));
  }
}

export function decorateBrollMarkers(container: Element): void {
  for (const key of container.getElementsByClassName("broll-key")) {
    const first = key.firstChild;
    if (first?.nodeType !== 3) continue;
    const text = first as Text;
    const match = /^b-roll:/i.exec(text.data);
    if (!match) continue;
    const prefix = key.ownerDocument.createElement("span");
    prefix.className = "broll-marker-prefix";
    prefix.textContent = match[0];
    text.deleteData(0, match[0].length);
    key.prepend(prefix);
    if (!text.length) text.remove();
  }
}

export function setEditableTextHtml(cell: Element, html: string): void {
  cell.innerHTML = html;
  if (html.includes("broll-key")) decorateBrollMarkers(cell);
}

export function writeUndecoratedBrollSelection(cell: Element, data: DataTransfer | null): boolean {
  if (!data) return false;
  const doc = cell.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  if (!cell.contains(common)) return false;
  const prefixes = cell.getElementsByClassName("broll-marker-prefix");
  if (!Array.from(prefixes).some(prefix => range.intersectsNode(prefix))) return false;

  const holder = doc.createElement("div");
  holder.append(range.cloneContents());
  for (let parent = common.nodeType === 1 ? common as Element : common.parentElement; parent && parent !== cell; parent = parent.parentElement) {
    const copy = parent.cloneNode(false) as Element;
    copy.append(...holder.childNodes);
    holder.append(copy);
  }
  Array.from(holder.getElementsByClassName("broll-marker-prefix")).forEach(prefix => prefix.replaceWith(...prefix.childNodes));
  data.setData("text/html", holder.innerHTML);
  data.setData("text/plain", selection.toString());
  return true;
}
