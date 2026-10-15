import { atomKey, unitKey } from "../../core/text/selection.ts";
import type { Affinity, CellPoints } from "../../core/text/selection.ts";

export interface DomPoint {
  readonly node: Node;
  readonly offset: number;
}

type UnitKind = "text" | "br" | "atom" | "end";

type Visit = (kind: UnitKind, node: Node, length: number) => boolean;

const ATOM_SELECTOR = ".broll-key, .video-embed-card";
const ZWSP = /\u200B/g;
const ELEMENT = 1;
const TEXT = 3;
const FOLLOWING = 4;

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT;
}

function isAtomEl(node: Node): boolean {
  if (!isElement(node)) return false;
  if (node.tagName === "IMG") return true;
  return node.classList.contains("broll-key") || node.classList.contains("video-embed-card");
}

function isBlankPara(node: Node): boolean {
  const first = node.firstChild;
  return node.childNodes.length === 1 && !!first && isElement(first) && first.tagName === "BR";
}

function walkCell(cellEl: Node, visit: Visit): void {
  let stop = false;
  (function walk(parent: Node): void {
    for (let c = parent.firstChild; c && !stop; c = c.nextSibling) {
      if (c.nodeType === TEXT) {
        if (visit("text", c, (c.nodeValue || "").replace(ZWSP, "").length)) stop = true;
      } else if (isElement(c)) {
        if (c.tagName === "BR") { if (visit("br", c, 1)) stop = true; continue; }
        if (isAtomEl(c)) { if (visit("atom", c, 1)) stop = true; continue; }
        if (c.tagName === "DIV" || c.tagName === "P") {
          if (!isBlankPara(c)) walk(c);
          if (!stop && visit("end", c, 1)) stop = true;
          continue;
        }
        walk(c);
      }
    }
  })(cellEl);
}

function textCount(node: Node, offset: number): number {
  return (node.nodeValue || "").slice(0, offset).replace(ZWSP, "").length;
}

function atOrAfter(kind: UnitKind, n: Node, c: Node): boolean {
  if (n === c || c.contains(n)) return true;
  if (kind === "end" && n.contains(c)) return true;
  return !!(c.compareDocumentPosition(n) & FOLLOWING);
}

function posBefore(cellEl: Node, c: Node): number {
  let p = 0, result: number | null = null;
  walkCell(cellEl, function (kind, n, len) {
    if (atOrAfter(kind, n, c)) { result = p; return true; }
    p += len;
    return false;
  });
  return result === null ? p : result;
}

function posAfterNode(cellEl: Node, c: Node): number {
  let p = 0, result: number | null = null;
  walkCell(cellEl, function (kind, n, len) {
    const inside = n === c ? kind !== "end" : c.contains(n);
    if (!inside && atOrAfter(kind, n, c)) { result = p; return true; }
    p += len;
    return false;
  });
  return result === null ? p : result;
}

function closestAtom(node: Node | null): Element | null {
  const key = node && node.nodeType === TEXT ? node.parentNode : node;
  return key && isElement(key) ? key.closest(ATOM_SELECTOR) : null;
}

export function domToPos(cellEl: Node, node: Node, offset: number): number | null {
  if (node !== cellEl && !cellEl.contains(node)) return null;
  const atom = closestAtom(node);
  if (atom && cellEl.contains(atom)) {
    const atStart = offset === 0 && (node === atom || node === atom.firstChild);
    return atStart ? posBefore(cellEl, atom) : posAfterNode(cellEl, atom);
  }
  if (node.nodeType === TEXT) return posBefore(cellEl, node) + textCount(node, offset);
  const child = node.childNodes[offset];
  if (child) return posBefore(cellEl, child);
  return posAfterNode(cellEl, node);
}

function indexIn(node: Node): number {
  return Array.prototype.indexOf.call((node.parentNode as Node).childNodes, node);
}

function before(node: Node): DomPoint {
  return { node: node.parentNode as Node, offset: indexIn(node) };
}

function after(node: Node): DomPoint {
  return { node: node.parentNode as Node, offset: indexIn(node) + 1 };
}

function endOf(el: Node): DomPoint {
  return { node: el, offset: el.childNodes.length };
}

export function posToDom(cellEl: Node, pos: number): DomPoint {
  let p = 0;
  let result: DomPoint | null = null;
  let last: { kind: UnitKind; node: Node } | null = null;
  walkCell(cellEl, function (kind, n, len) {
    last = { kind: kind, node: n };
    if (kind === "text") {
      if (pos <= p + len) {
        const parent = n.parentNode;
        const tag = parent && isElement(parent) ? parent.closest(".tag-anchor") : null;
        if (tag && cellEl.contains(tag)) {
          result = pos === p && tag.firstChild === n ? before(tag) : after(tag);
          return true;
        }
        const raw = n.nodeValue || "";
        let seen = 0, i = 0;
        while (i < raw.length && seen < pos - p) { if (raw[i] !== "\u200B") seen++; i++; }
        result = { node: n, offset: i };
        return true;
      }
    } else if (pos <= p) {
      result = kind === "end" ? endOf(n) : before(n);
      return true;
    }
    p += len;
    return false;
  });
  if (result) return result;
  const tail = last as { kind: UnitKind; node: Node } | null;
  if (tail && tail.kind === "atom") return after(tail.node);
  return { node: cellEl, offset: cellEl.childNodes.length };
}

export function domKeys(cellEl: Node): string[] {
  const keys: string[] = [];
  walkCell(cellEl, function (kind, n) {
    if (kind === "text") {
      const text = (n.nodeValue || "").replace(ZWSP, "");
      for (let i = 0; i < text.length; i++) keys.push(unitKey(text[i] as string));
    } else if (kind === "atom") {
      const id = isElement(n) ? n.getAttribute("data-broll-id") : null;
      keys.push(atomKey(id === null ? "#media" : id));
    } else {
      keys.push("\n");
    }
    return false;
  });
  return keys;
}

export function readSelection(cellEl: Node, sel: Selection | null): CellPoints | null {
  if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.focusNode) return null;
  if (!cellEl.contains(sel.anchorNode) || !cellEl.contains(sel.focusNode)) return null;
  const anchor = domToPos(cellEl, sel.anchorNode, sel.anchorOffset);
  const head = domToPos(cellEl, sel.focusNode, sel.focusOffset);
  if (anchor === null || head === null) return null;
  const affinity: Affinity = head > 0 && (anchor !== head || sel.focusOffset > 0) ? "backward" : "forward";
  return { anchor: anchor, head: head, affinity: affinity };
}

export function placeSelection(cellEl: Node, sel: Selection | null, points: CellPoints): boolean {
  if (!sel) return false;
  const a = posToDom(cellEl, points.anchor);
  const h = points.head === points.anchor ? a : posToDom(cellEl, points.head);
  try {
    sel.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
  } catch {
    return false;
  }
  return true;
}
