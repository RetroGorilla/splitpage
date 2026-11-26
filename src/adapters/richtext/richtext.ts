import type { Seal } from "../../core/document/freeze.ts";
import type { IdSource, ImageSource } from "../../core/document/ports.ts";
import { withoutLoneSurrogates } from "../../core/document/text-policy.ts";
import type { StoredImageRef } from "../../core/document/text-policy.ts";
import { toHtml } from "../../core/text/html.ts";
import type { DecodeOptions } from "../../core/text/ports.ts";
import { withoutWho } from "../../core/text/who.ts";
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
  sanitizeStored: (html: unknown) => string;
  decode: (html: unknown, opts?: DecodeOptions | null) => Run[];
  createCellReader: (seal: Seal, opts?: DecodeOptions | null) => CellReader;
  storedHtmlFromDom: <T>(html: T) => T | string;
  htmlToMarkdown: (html: unknown) => string;
  videoCardElement: (href: string) => HTMLAnchorElement;
  videoCardHtml: (href: string) => string;
  imageRefOf: (node: Element) => StoredImageRef | null;
}

const STORED_IMG_ATTRS: ReadonlySet<string> = new Set(["class", "data-blob", "data-w", "data-h", "data-mime"]);

function mapAttributeValues(html: string, map: (value: string) => string): string {
  return html.replace(/<[a-z][a-z0-9-]*(?: [a-z0-9-]+="[^"]*")+>/g, tag => tag.replace(/"[^"]*"/g, map));
}

export function createRichText(ports: RichTextPorts): RichText {
  const Parser = ports.DOMParser;
  const images = ports.images;
  const ids = ports.ids;
  let escapesAttributeAngles: boolean | undefined;

  function serializedMarkup(html: string, doc: Document): string {
    if (escapesAttributeAngles === undefined) {
      const probe = doc.createElement("span");
      probe.setAttribute("title", "<>");
      escapesAttributeAngles = probe.outerHTML.includes("&lt;&gt;");
    }
    return escapesAttributeAngles ? html : mapAttributeValues(html, value => value.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
  }

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
    return withoutLoneSurrogates(serializedMarkup(out.innerHTML, doc));
  }

  function sanitizeStored(html: unknown): string {
    const clean = sanitize(html);
    if (typeof html !== "string" || html === clean || !/&[lg]t;/.test(clean)) return clean;
    // why: A saved script can keep its old attribute bytes only if every other byte is already sanitised.
    const legacy = mapAttributeValues(clean, value => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
    return html === legacy ? html : clean;
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
    const text = String(html);
    const shown = text.indexOf("who-anchor") === -1 ? text : toHtml(withoutWho(decode(text, { media: true })));
    return walkToMd(inertBody(shown)).replace(/\n{3,}/g, "\n\n").trim();
  }

  let cardDoc: Document | null = null;

  function cardElement(href: string): HTMLAnchorElement {
    if (!cardDoc) cardDoc = inertBody("").ownerDocument;
    return videoCardElement(cardDoc, href);
  }

  return {
    inertBody: inertBody,
    sanitize: sanitize,
    sanitizeStored: sanitizeStored,
    decode: decode,
    createCellReader: function (seal, opts) { return createCellReader(function (html) { return decode(html, opts); }, seal); },
    storedHtmlFromDom: storedHtmlFromDom,
    htmlToMarkdown: htmlToMarkdown,
    videoCardElement: cardElement,
    videoCardHtml: function (href) {
      const card = cardElement(href);
      return serializedMarkup(card.outerHTML, card.ownerDocument);
    },
    imageRefOf: function (node) { return imageRefOf(node, images); }
  };
}
