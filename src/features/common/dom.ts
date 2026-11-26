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

const generatedBrollPrefixes = new WeakSet<Element>();
const BROLL_PREFIX_CLASS = "broll-marker-prefix";

export function decorateBrollMarkers(container: Element): void {
  for (const key of container.getElementsByClassName("broll-key")) {
    const first = key.firstChild;
    if (first?.nodeType !== 3) continue;
    const text = first as Text;
    const match = /^b-roll:/i.exec(text.data);
    if (!match) continue;
    const prefix = key.ownerDocument.createElement("span");
    prefix.className = BROLL_PREFIX_CLASS;
    generatedBrollPrefixes.add(prefix);
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

export function editableTextHtml(cell: Element): string {
  const shown = cell.innerHTML;
  if (!shown.includes(BROLL_PREFIX_CLASS)) return shown;
  const prefixes = Array.from(cell.getElementsByClassName(BROLL_PREFIX_CLASS));
  if (!prefixes.some(prefix => generatedBrollPrefixes.has(prefix))) return shown;
  const copy = cell.cloneNode(true) as Element;
  Array.from(copy.getElementsByClassName(BROLL_PREFIX_CLASS)).forEach((prefix, index) => {
    const original = prefixes[index];
    if (original && generatedBrollPrefixes.has(original)) prefix.replaceWith(...prefix.childNodes);
  });
  return copy.innerHTML;
}

export function writeUndecoratedBrollSelection(cell: Element, data: DataTransfer | null, nativeDefault = false): boolean {
  if (!data) return false;
  const doc = cell.ownerDocument;
  const view = doc.defaultView;
  const selection = view?.getSelection();
  if (!view || !selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!cell.contains(range.commonAncestorContainer)) return false;
  const prefixes = Array.from(cell.getElementsByClassName(BROLL_PREFIX_CLASS)).filter(prefix =>
    generatedBrollPrefixes.has(prefix) && range.intersectsNode(prefix));
  if (!prefixes.length) return false;

  const texts = new Map<Element, Text>();
  for (const prefix of prefixes) {
    if (prefix.firstChild?.nodeType === 3) texts.set(prefix, prefix.firstChild as Text);
  }
  if (!texts.size) return false;
  function point(node: Node | null, offset: number): readonly [Node | null, number] {
    const text = node?.nodeType === 1 ? texts.get(node as Element) : undefined;
    return text ? [text, offset ? text.length : 0] : [node, offset];
  }
  const anchor = point(selection.anchorNode, selection.anchorOffset);
  const focus = point(selection.focusNode, selection.focusOffset);
  for (const [prefix, text] of texts) prefix.replaceWith(text);
  if (anchor[0] && focus[0]) selection.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);

  function restore(): void {
    if (!selection) return;
    const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
    for (const [prefix, text] of texts) {
      if (!cell.contains(text)) continue;
      text.replaceWith(prefix);
      prefix.append(text);
    }
    if (anchorNode && focusNode && cell.contains(anchorNode) && cell.contains(focusNode)) {
      selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    }
  }

  try {
    const clean = selection.getRangeAt(0);
    const common = clean.commonAncestorContainer;
    const holder = doc.createElement("div");
    holder.append(clean.cloneContents());
    for (let parent = common.nodeType === 1 ? common as Element : common.parentElement; parent && parent !== cell; parent = parent.parentElement) {
      const copy = parent.cloneNode(false) as Element;
      copy.append(...holder.childNodes);
      holder.append(copy);
    }
    data.setData("text/html", holder.innerHTML);
    data.setData("text/plain", selection.toString());
  } finally {
    // why: native copy and cut must see the original text through their default action.
    if (nativeDefault) view.setTimeout(restore, 0);
    else restore();
  }
  return true;
}
