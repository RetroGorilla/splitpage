import type { Seal } from "../../core/document/freeze.ts";
import type { IdSource, ImageSource } from "../../core/document/ports.ts";
import { withoutLoneSurrogates } from "../../core/document/text-policy.ts";
import type { StoredImageRef } from "../../core/document/text-policy.ts";
import type { DecodeOptions } from "../../core/text/ports.ts";
import type { Run } from "../../core/text/runs.ts";
import { createCellReader, decodeBody } from "./decode.ts";
import type { CellReader } from "./decode.ts";
import { walkToMd } from "./markdown.ts";
import { boundedBody, boundedMarkup } from "./parse-bound.ts";
import { imageRefOf, splitBudget, videoCardElement, walkSanitize } from "./sanitize.ts";

export type { CellReader } from "./decode.ts";

export interface RichTextPorts {
  readonly DOMParser: new () => DOMParser;
  readonly images: ImageSource;
  readonly ids: IdSource;
}

export interface RichText {
  inertBody: (html: unknown) => HTMLElement;
  sanitize: (html: unknown) => string;
  decode: (html: unknown, opts?: DecodeOptions | null) => Run[];
  createCellReader: (seal: Seal, opts?: DecodeOptions | null) => CellReader;
  storedHtmlFromDom: <T>(html: T) => T | string;
  htmlToMarkdown: (html: unknown) => string;
  videoCardElement: (href: string) => HTMLAnchorElement;
  videoCardHtml: (href: string) => string;
  imageRefOf: (node: Element) => StoredImageRef | null;
}

const STORED_IMG_ATTRS: ReadonlySet<string> = new Set(["class", "data-blob", "data-w", "data-h", "data-mime"]);

export function createRichText(ports: RichTextPorts): RichText {
  const Parser = ports.DOMParser;
  const images = ports.images;
  const ids = ports.ids;

  function parsedBody(text: string): HTMLElement {
    return new Parser().parseFromString("<!doctype html><body>" + text, "text/html").body;
  }

  function inertBody(html: unknown): HTMLElement {
    const text = html == null ? "" : String(html);
    return boundedBody(parsedBody(boundedMarkup(text)), text.length);
  }

  function sanitize(html: unknown): string {
    const text = html == null ? "" : String(html);
    const body = inertBody(text);
    const doc = body.ownerDocument;
    const out = doc.createElement("div");
    walkSanitize(body, out, { doc: doc, images: images, ids: ids, split: splitBudget(text.length) });
    return withoutLoneSurrogates(out.innerHTML);
  }

  function decode(html: unknown, opts?: DecodeOptions | null): Run[] {
    return decodeBody(parsedBody(sanitize(html == null ? "" : String(html))), opts);
  }

  function storedHtmlFromDom<T>(html: T): T | string {
    if (typeof html !== "string" || html.indexOf("data-blob") === -1) return html;
    const body = inertBody(html);
    const imgs = body.querySelectorAll("img[data-blob]");
    if (!imgs.length) return html;
    imgs.forEach(function (img) {
      Array.from(img.attributes).forEach(function (a) {
        if (!STORED_IMG_ATTRS.has(a.name)) img.removeAttribute(a.name);
      });
    });
    return body.innerHTML;
  }

  function htmlToMarkdown(html: unknown): string {
    if (!html) return "";
    return walkToMd(inertBody(html)).replace(/\n{3,}/g, "\n\n").trim();
  }

  let cardDoc: Document | null = null;

  function cardElement(href: string): HTMLAnchorElement {
    if (!cardDoc) cardDoc = inertBody("").ownerDocument;
    return videoCardElement(cardDoc, href);
  }

  return {
    inertBody: inertBody,
    sanitize: sanitize,
    decode: decode,
    createCellReader: function (seal, opts) { return createCellReader(function (html) { return decode(html, opts); }, seal); },
    storedHtmlFromDom: storedHtmlFromDom,
    htmlToMarkdown: htmlToMarkdown,
    videoCardElement: cardElement,
    videoCardHtml: function (href) { return cardElement(href).outerHTML; },
    imageRefOf: function (node) { return imageRefOf(node, images); }
  };
}
