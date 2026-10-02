import { isSha256Hex, normalizeImageRef } from "../../../shared/blob-policy.js";
import { BROLL_MARKER_RE } from "../../core/document/broll.ts";
import type { IdSource, ImageSource } from "../../core/document/ports.ts";
import { tagCategoryId } from "../../core/document/tags.ts";
import { plainText, safeHref, safeId, safeImageSrc, storedImageAttributes } from "../../core/document/text-policy.ts";
import type { StoredImageRef } from "../../core/document/text-policy.ts";

export interface SanitizeContext {
  readonly doc: Document;
  readonly images: ImageSource;
  readonly ids: IdSource;
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

function insideSafeLink(node: Element): boolean {
  for (let p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) {
    if ((p as Element).tagName === "A" && safeHref((p as Element).getAttribute("href") || "")) return true;
  }
  return false;
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
    if (tag === "A" && insideSafeLink(el)) { walkSanitize(el, destParent, ctx); return; }
    if (tag === "A" && hasClass(el, "video-embed-card")) {
      const vhref = safeHref(el.getAttribute("href") || "");
      if (vhref) destParent.appendChild(videoCardElement(doc, vhref));
      return;
    }
    if (tag === "SPAN" && hasClass(el, "tag-anchor")) {
      const tcat = tagCategoryId(el.getAttribute("data-tag-cat"));
      const tname = plainText(el.getAttribute("data-tag-name")).trim().slice(0, 80);
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
        walkSanitize(el, a, ctx);
        destParent.appendChild(a);
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
