import { isSha256Hex, normalizeImageRef } from "../../../shared/blob-policy.js";
import { BROLL_MARKER_RE } from "../../core/document/broll.ts";
import type { IdSource, ImageSource } from "../../core/document/ports.ts";
import { tagCategoryId } from "../../core/document/tags.ts";
import { cappedText, safeHref, safeId, safeImageSrc, storedImageAttributes } from "../../core/document/text-policy.ts";
import type { StoredImageRef } from "../../core/document/text-policy.ts";

export interface SplitBudget {
  left: number;
}

export interface SanitizeContext {
  readonly doc: Document;
  readonly images: ImageSource;
  readonly ids: IdSource;
  readonly split: SplitBudget;
  readonly inLink?: boolean;
}

const SPLIT_UNITS_PER_INPUT_UNIT = 8;

const FREE_SPLIT_UNITS = 4096;

export function splitBudget(inputLength: number): SplitBudget {
  return { left: SPLIT_UNITS_PER_INPUT_UNIT * inputLength + FREE_SPLIT_UNITS };
}

type InlineStyle = {
  readonly fontWeight?: string;
  readonly fontStyle?: string;
  readonly textDecorationLine?: string;
  readonly textDecoration?: string;
  readonly backgroundColor?: string;
};

function styleOf(node: Element): InlineStyle {
  return (node as Partial<ElementCSSInlineStyle>).style || {};
}

function hasClass(node: Element, name: string): boolean {
  return !!node.classList && node.classList.contains(name);
}

const SPAN_MARK_CLASSES: readonly string[] = ["tag-anchor", "broll-key", "stage-dir", "audio-cue"];

const CUE_OUTRANKED: readonly string[] = ["tag-anchor", "broll-key", "stage-dir"];

const splitPoints = new WeakSet<Node>();

function holdsSplitPoint(node: Node): boolean {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (splitPoints.has(c) || holdsSplitPoint(c)) return true;
  }
  return false;
}

interface SplitStep {
  readonly node: Node;
  readonly chain: readonly Element[];
  readonly point: boolean;
}

function scanSplit(link: Element): SplitStep[] {
  const steps: SplitStep[] = [];
  function visit(parent: Node, chain: readonly Element[]): void {
    Array.from(parent.childNodes).forEach(function (child) {
      if (splitPoints.has(child)) { steps.push({ node: child, chain, point: true }); return; }
      if (child.nodeType === 1 && holdsSplitPoint(child)) { visit(child, chain.concat(child as Element)); return; }
      if (child.nodeType === 3 && !(child as Text).data) return;
      steps.push({ node: child, chain, point: false });
    });
  }
  visit(link, []);
  return steps;
}

function markKey(el: Element): string {
  return JSON.stringify([el.tagName, Array.from(el.attributes, function (a) { return [a.name, a.value]; })]);
}

function collapseChains(steps: readonly SplitStep[]): SplitStep[] {
  const collapsed = new Map<readonly Element[], readonly Element[]>();
  const keys = new Map<Element, string>();
  function keyOf(el: Element): string {
    let key = keys.get(el);
    if (key === undefined) { key = markKey(el); keys.set(el, key); }
    return key;
  }
  function collapse(chain: readonly Element[]): readonly Element[] {
    let result = collapsed.get(chain);
    if (!result) {
      const seen = new Set<string>();
      result = chain.filter(function (el) {
        const key = keyOf(el);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      collapsed.set(chain, result);
    }
    return result;
  }
  return steps.map(function (step) { return { node: step.node, chain: collapse(step.chain), point: step.point }; });
}

function attributeValueBound(value: string): number {
  let n = value.length;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 34 || c === 38 || c === 60 || c === 62 || c === 160) n += 5;
  }
  return n;
}

function shellBound(el: Element): number {
  let n = 2 * el.localName.length + 5;
  Array.from(el.attributes).forEach(function (a) { n += a.name.length + 4 + attributeValueBound(a.value); });
  return n;
}

interface SplitPlan {
  readonly bound: number;
  readonly kept: readonly number[];
}

function planSplit(link: Element, steps: readonly SplitStep[], boundOf: (el: Element) => number): SplitPlan {
  let bound = 0;
  let open: Element[] | null = null;
  const kept: number[] = [];
  for (const step of steps) {
    const chain = step.chain;
    if (step.point) {
      open = null;
      kept.push(0);
      for (const el of chain) bound += boundOf(el);
      continue;
    }
    if (!open) { open = []; bound += boundOf(link); }
    let n = 0;
    while (n < open.length && n < chain.length && open[n] === chain[n]) n++;
    kept.push(n);
    open.length = n;
    for (let i = n; i < chain.length; i++) {
      const el = chain[i] as Element;
      open.push(el);
      bound += boundOf(el);
    }
  }
  return { bound: bound, kept: kept };
}

function unwrapSplitPoints(steps: readonly SplitStep[]): void {
  steps.forEach(function (step) {
    if (!step.point) return;
    const point = step.node as Element;
    const parent = point.parentNode as Node;
    if (isLinkPiece(point)) {
      while (point.firstChild) parent.insertBefore(point.firstChild, point);
    }
    parent.removeChild(point);
  });
}

function nestShells(chain: readonly Element[]): Element[] {
  const shells: Element[] = [];
  chain.forEach(function (c, i) {
    const shell = c.cloneNode(false) as Element;
    if (i > 0) (shells[i - 1] as Element).appendChild(shell);
    shells.push(shell);
  });
  return shells;
}

function isLinkPiece(node: Element): boolean {
  return node.tagName === "A" && !hasClass(node, "video-embed-card");
}

function wrapPoint(point: Element, chain: readonly Element[]): Node {
  if (!chain.length) return point;
  const shells = nestShells(chain);
  const innermost = shells[shells.length - 1] as Element;
  if (isLinkPiece(point)) {
    while (point.firstChild) innermost.appendChild(point.firstChild);
    point.appendChild(shells[0] as Element);
    return point;
  }
  innermost.appendChild(point);
  return shells[0] as Element;
}

function buildSplit(link: Element, steps: readonly SplitStep[], kept: readonly number[]): Node[] {
  const result: Node[] = [];
  let piece: Element | null = null;
  let open: Element[] = [];
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s] as SplitStep;
    if (step.point) {
      if (piece) result.push(piece);
      piece = null;
      result.push(wrapPoint(step.node as Element, step.chain));
      continue;
    }
    if (!piece) { piece = link.cloneNode(false) as Element; open = []; }
    open.length = kept[s] as number;
    for (let i = open.length; i < step.chain.length; i++) {
      const shell = (step.chain[i] as Element).cloneNode(false) as Element;
      (open[i - 1] || piece).appendChild(shell);
      open.push(shell);
    }
    (open[open.length - 1] || piece).appendChild(step.node);
  }
  if (piece) result.push(piece);
  return result;
}

function splitLinkAround(link: Element, budget: SplitBudget): Node[] {
  if (!holdsSplitPoint(link)) return [link];
  const bounds = new Map<Element, number>();
  const boundOf = function (el: Element): number {
    let n = bounds.get(el);
    if (n === undefined) { n = shellBound(el); bounds.set(el, n); }
    return n;
  };
  let steps = scanSplit(link);
  let plan = planSplit(link, steps, boundOf);
  if (plan.bound > budget.left) {
    steps = collapseChains(steps);
    plan = planSplit(link, steps, boundOf);
    if (plan.bound > budget.left) {
      unwrapSplitPoints(steps);
      return [link];
    }
  }
  budget.left -= plan.bound;
  return buildSplit(link, steps, plan.kept);
}

function imageDimAttr(v: string | null): number {
  return typeof v === "string" && /^[1-9][0-9]{0,6}$/.test(v) ? parseInt(v, 10) : NaN;
}

export function imageRefOf(node: Element, images: ImageSource): StoredImageRef | null {
  const sha = node.getAttribute("data-blob");
  if (isSha256Hex(sha)) {
    return images.known(sha as string) || normalizeImageRef({
      sha256: sha,
      width: imageDimAttr(node.getAttribute("data-w")),
      height: imageDimAttr(node.getAttribute("data-h")),
      mime: node.getAttribute("data-mime")
    }) || { sha256: sha as string };
  }
  const src = safeImageSrc(node.getAttribute("src") || "");
  return src ? images.fromDataUrl(src) : null;
}

export function storedImageElement(doc: Document, ref: StoredImageRef): HTMLImageElement {
  const img = doc.createElement("img");
  storedImageAttributes(ref).forEach(function (attr) {
    img.setAttribute(attr[0], attr[1]);
  });
  return img;
}

export function videoCardElement(doc: Document, href: string): HTMLAnchorElement {
  const a = doc.createElement("a");
  a.className = "video-embed-card";
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener");
  let host;
  try { host = new URL(href).hostname.replace(/^www\./, ""); } catch { host = href; }
  const play = doc.createElement("span");
  play.className = "vec-play";
  play.textContent = "▶";
  const label = doc.createElement("span");
  label.textContent = "Watch video";
  const hostSpan = doc.createElement("span");
  hostSpan.className = "vec-host";
  hostSpan.textContent = "· " + host;
  a.appendChild(play);
  a.appendChild(label);
  a.appendChild(hostSpan);
  return a;
}

function wrapNodes(doc: Document, nodesArr: Node[], tagName: string): Node[] {
  const w = doc.createElement(tagName);
  nodesArr.forEach(function (n) { w.appendChild(n); });
  return [w];
}

export function walkSanitize(srcParent: Node, destParent: Node, ctx: SanitizeContext): void {
  const doc = ctx.doc;
  const kids = Array.from(srcParent.childNodes);
  kids.forEach(function (node) {
    if (node.nodeType === 3) {
      destParent.appendChild(doc.createTextNode((node as Text).data));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;

    if (tag === "DIV" || tag === "P") {
      const first = el.firstChild;
      const isBlankPara = el.childNodes.length === 1 &&
        !!first && first.nodeType === 1 && (first as Element).tagName === "BR";
      if (!isBlankPara) walkSanitize(el, destParent, ctx);
      destParent.appendChild(doc.createElement("br"));
      return;
    }
    if (tag === "BR") { destParent.appendChild(doc.createElement("br")); return; }

    if (tag === "STRONG" || tag === "B") {
      const bStyle = styleOf(el);
      const bWeight = bStyle.fontWeight;
      const bWeightNum = parseInt(String(bWeight), 10);
      const boldCancelled = bWeight === "normal" || bWeight === "400" ||
        (!isNaN(bWeightNum) && bWeightNum < 600);
      if (boldCancelled) { walkSanitize(el, destParent, ctx); return; }
      const st = doc.createElement("strong"); walkSanitize(el, st, ctx); destParent.appendChild(st); return;
    }
    if (tag === "EM" || tag === "I") { const em = doc.createElement("em"); walkSanitize(el, em, ctx); destParent.appendChild(em); return; }
    if (tag === "U") { const u = doc.createElement("u"); walkSanitize(el, u, ctx); destParent.appendChild(u); return; }
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") { const s = doc.createElement("s"); walkSanitize(el, s, ctx); destParent.appendChild(s); return; }
    if (tag === "MARK") { const m = doc.createElement("mark"); walkSanitize(el, m, ctx); destParent.appendChild(m); return; }
    if (tag === "IMG") {
      const ref = imageRefOf(el, ctx.images);
      if (ref) destParent.appendChild(storedImageElement(doc, ref));
      return;
    }
    if (tag === "A" && hasClass(el, "video-embed-card")) {
      const vhref = safeHref(el.getAttribute("href") || "");
      if (vhref) {
        const card = videoCardElement(doc, vhref);
        if (ctx.inLink) splitPoints.add(card);
        destParent.appendChild(card);
      }
      return;
    }
    if (tag === "SPAN" && hasClass(el, "cmt-anchor") && SPAN_MARK_CLASSES.some(function (c) { return hasClass(el, c); })) {
      const peeledSpan = doc.createElement("span");
      peeledSpan.className = "cmt-anchor";
      peeledSpan.setAttribute("data-cmt", safeId(el.getAttribute("data-cmt") || "", "c", ctx.ids));
      if (hasClass(el, "audio-cue") && !CUE_OUTRANKED.some(function (c) { return hasClass(el, c); })) {
        const cueSpan = doc.createElement("span");
        cueSpan.className = "audio-cue";
        walkSanitize(el, peeledSpan, ctx);
        cueSpan.appendChild(peeledSpan);
        destParent.appendChild(cueSpan);
        return;
      }
      const rest = el.cloneNode(true) as Element;
      rest.classList.remove("cmt-anchor");
      const restHolder = doc.createElement("span");
      restHolder.appendChild(rest);
      walkSanitize(restHolder, peeledSpan, ctx);
      destParent.appendChild(peeledSpan);
      return;
    }
    if (tag === "SPAN" && hasClass(el, "tag-anchor")) {
      const tcat = tagCategoryId(el.getAttribute("data-tag-cat"));
      const tname = cappedText(el.getAttribute("data-tag-name"), 80);
      if (!tcat || !tname) { walkSanitize(el, destParent, ctx); return; }
      const tagSpan = doc.createElement("span");
      tagSpan.className = "tag-anchor";
      tagSpan.setAttribute("data-tag-cat", tcat);
      tagSpan.setAttribute("data-tag-name", tname);
      tagSpan.setAttribute("contenteditable", "false");
      walkSanitize(el, tagSpan, ctx);
      destParent.appendChild(tagSpan);
      return;
    }
    if (tag === "SPAN" && hasClass(el, "broll-key")) {
      const brollText = (el.textContent || "").trim();
      if (!BROLL_MARKER_RE.test(brollText)) { walkSanitize(el, destParent, ctx); return; }
      const brollSpan = doc.createElement("span");
      brollSpan.className = "broll-key";
      brollSpan.setAttribute("data-broll-id", safeId(el.getAttribute("data-broll-id") || "", "bs", ctx.ids));
      brollSpan.setAttribute("contenteditable", "false");
      brollSpan.appendChild(doc.createTextNode(brollText));
      destParent.appendChild(brollSpan);
      return;
    }
    if (tag === "SPAN" && hasClass(el, "cmt-anchor")) {
      const cmtId = safeId(el.getAttribute("data-cmt") || "", "c", ctx.ids);
      const anchorSpan = doc.createElement("span");
      anchorSpan.className = "cmt-anchor";
      anchorSpan.setAttribute("data-cmt", cmtId);
      walkSanitize(el, anchorSpan, ctx);
      destParent.appendChild(anchorSpan);
      return;
    }
    if (tag === "SPAN" && hasClass(el, "stage-dir")) {
      const dirSpan = doc.createElement("span");
      dirSpan.className = "stage-dir";
      walkSanitize(el, dirSpan, ctx);
      destParent.appendChild(dirSpan);
      return;
    }
    if (tag === "SPAN" && hasClass(el, "audio-cue")) {
      const cueSpan = doc.createElement("span");
      cueSpan.className = "audio-cue";
      walkSanitize(el, cueSpan, ctx);
      destParent.appendChild(cueSpan);
      return;
    }
    if (tag === "A") {
      const href = safeHref(el.getAttribute("href") || "");
      if (href) {
        const a = doc.createElement("a");
        a.setAttribute("href", href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener");
        walkSanitize(el, a, { ...ctx, inLink: true });
        splitLinkAround(a, ctx.split).forEach(function (piece) {
          if (ctx.inLink) splitPoints.add(piece);
          destParent.appendChild(piece);
        });
      } else {
        walkSanitize(el, destParent, ctx);
      }
      return;
    }
    if (tag === "SPAN") {
      const stObj = styleOf(el);
      const holder = doc.createElement("span");
      walkSanitize(el, holder, ctx);
      let current: Node[] = Array.from(holder.childNodes);
      const isBold = stObj.fontWeight === "bold" || stObj.fontWeight === "700" || (parseInt(String(stObj.fontWeight), 10) >= 600);
      const isItalic = stObj.fontStyle === "italic";
      const deco = (stObj.textDecorationLine || stObj.textDecoration || "");
      const isUnderline = deco.indexOf("underline") !== -1;
      const isStrike = deco.indexOf("line-through") !== -1;
      const bg = stObj.backgroundColor;
      const isHighlight = !!bg && bg !== "transparent" && bg.indexOf("rgba(0, 0, 0, 0)") === -1;
      if (isStrike) current = wrapNodes(doc, current, "s");
      if (isUnderline) current = wrapNodes(doc, current, "u");
      if (isItalic) current = wrapNodes(doc, current, "em");
      if (isBold) current = wrapNodes(doc, current, "strong");
      if (isHighlight) current = wrapNodes(doc, current, "mark");
      current.forEach(function (n) { destParent.appendChild(n); });
      return;
    }
    walkSanitize(el, destParent, ctx);
  });
}
