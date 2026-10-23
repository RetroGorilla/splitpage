import { BROLL_MARKER_RE } from "../../core/document/broll.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { anchorBrollCell, brollAnchorTodo, planBrollAnchors } from "../../core/production/broll.ts";
import { holdsMedia } from "../../core/production/tags.ts";
import { toHtml } from "../../core/text/html.ts";
import { brollAnchoringDeclined } from "../../application/broll-anchoring.ts";

import type { IdSource } from "../../core/document/ports.ts";
import type { DocumentRow, ValidatedDocument } from "../../core/document/validated.ts";
import type { FieldHtml, ProductionReaders } from "../../core/production/ports.ts";
import type { Frozen } from "../../core/document/freeze.ts";
import type { Run } from "../../core/text/runs.ts";

interface HtmlLine {
  nodes: Node[];
  br: Node | null;
}

interface BrollAnchorPorts {
  readers: ProductionReaders;
  ids: IdSource;
  cellOf: (html: FieldHtml) => Frozen<Run[]>;
  inertBody: (html: FieldHtml) => HTMLElement;
  sanitize: (html: string) => string;
}
export function brollHtmlLines(body: HTMLElement): HtmlLine[] {
  hoistNestedBrs(body);
  const kids: Node[] = Array.from(body.childNodes);
  const lines: HtmlLine[] = [];
  let start = 0;
  kids.forEach(function (n, i) {
    if (n.nodeType === 1 && (n as Element).tagName === "BR") {
      lines.push({ nodes: kids.slice(start, i), br: n });
      start = i + 1;
    }
  });
  lines.push({ nodes: kids.slice(start), br: null });
  return lines;
}

function hoistNestedBrs(body: HTMLElement): void {
  let guard = 0;
  while (guard++ < 1000) {
    const brs = body.getElementsByTagName("br");
    let br: HTMLBRElement | null = null;
    for (let i = 0; i < brs.length; i++) {
      const candidate = brs[i];
      if (candidate && candidate.parentNode !== body) { br = candidate; break; }
    }
    if (!br) return;
    const parent = br.parentNode as Node;
    const grand = parent.parentNode;
    if (!grand) return;
    const tail = parent.cloneNode(false);
    while (br.nextSibling) tail.appendChild(br.nextSibling);
    parent.removeChild(br);
    const ref = parent.nextSibling;
    grand.insertBefore(br, ref);
    if (tail.childNodes.length) grand.insertBefore(tail, ref);
  }
}

function brollHtmlLineText(nodes: readonly Node[]): string {
  return nodes.map(function (n) { return n.textContent || ""; }).join("");
}

export function brollKeyHtml(id: string, text: string): string {
  return '<span class="broll-key" data-broll-id="' + escapeHtml(id) +
    '" contenteditable="false">' + escapeHtml(text) + '</span>';
}

function brollLineTextNodes(nodes: readonly Node[]): Text[] {
  const out: Text[] = [];
  (function walk(list: ArrayLike<Node>): void {
    for (let i = 0; i < list.length; i++) {
      const n = list[i] as Node;
      if (n.nodeType === 3) out.push(n as Text);
      else if (n.nodeType === 1) walk(n.childNodes);
    }
  })(nodes);
  return out;
}

function brollPruneEmpty(el: Node | null, body: HTMLElement): void {
  while (el && el !== body && el.parentNode && !el.childNodes.length) {
    const parent: ParentNode = el.parentNode;
    parent.removeChild(el);
    el = parent;
  }
}

function brollWrapHtmlLine(body: HTMLElement, line: HtmlLine, id: string): boolean {
  const m = BROLL_MARKER_RE.exec(brollHtmlLineText(line.nodes));
  if (!m) return false;
  let left = m[0].length;
  brollLineTextNodes(line.nodes).forEach(function (t) {
    if (left <= 0) return;
    const val = t.nodeValue || "";
    if (val.length > left) { t.nodeValue = val.slice(left); left = 0; return; }
    left -= val.length;
    const parent = t.parentNode;
    if (!parent) return;
    parent.removeChild(t);
    brollPruneEmpty(parent, body);
  });

  let ref: Node | null = null;
  for (let i = 0; i < line.nodes.length && !ref; i++) {
    const node = line.nodes[i];
    if (node && node.parentNode === body) ref = node;
  }
  if (!ref) ref = line.br;
  const holder = body.ownerDocument.createElement("div");
  holder.innerHTML = brollKeyHtml(id, (m[1] as string) + (m[2] as string)) + " ";
  Array.from(holder.childNodes).forEach(function (n) {
    body.insertBefore(n, ref);
  });
  return true;
}

function brollRekeyHtmlLine(line: HtmlLine, id: string): boolean {
  for (let i = 0; i < line.nodes.length; i++) {
    const n = line.nodes[i] as Node;
    if (n.nodeType !== 1) continue;
    const element = n as Element;
    const key = element.classList.contains("broll-key") ? element : element.querySelector(".broll-key");
    if (key) { key.setAttribute("data-broll-id", id); return true; }
  }
  return false;
}

export function anchorBrollInRows(doc: ValidatedDocument | null | undefined, only: readonly DocumentRow[] | null | undefined, ports: BrollAnchorPorts): number {
  const rows = only || (doc && doc.rows);
  if (!doc || !rows || !rows.length) return 0;
  const plan = planBrollAnchors(doc, ports.readers, ports.ids);
  let total = 0;
  rows.forEach(function (row) {
    if (brollAnchoringDeclined(row.id)) return;
    const html = row.visualText;
    const cell = ports.cellOf(html);
    const todo = brollAnchorTodo(cell, row.id, plan);
    if (!todo.length) return;
    let n = 0;
    if (holdsMedia(html)) {
      const body = ports.inertBody(html);
      const htmlLines = brollHtmlLines(body);
      todo.forEach(function (t) {
        const line = htmlLines[t.found.index];
        if (!line) return;
        if (t.found.marker.key ? brollRekeyHtmlLine(line, t.id) : brollWrapHtmlLine(body, line, t.id)) n++;
      });
      if (n) row.visualText = ports.sanitize(body.innerHTML);
    } else {
      const anchored = anchorBrollCell(cell, todo);
      n = anchored.anchored;
      if (n) row.visualText = toHtml(anchored.cell);
    }
    total += n;
  });
  return total;
}
