import { randomIds } from "../adapters/identity/ids.ts";
import { createRichText } from "../adapters/richtext/richtext.ts";
import type { CellReader, RichText } from "../adapters/richtext/richtext.ts";
import type { Frozen } from "../core/document/freeze.ts";
import type { StoredImageRef } from "../core/document/text-policy.ts";
import type { DecodeOptions } from "../core/text/ports.ts";
import type { Run } from "../core/text/runs.ts";
import { registryImages } from "../js/02c-blobs.js";
import { cacheSeal } from "./cache-freeze.ts";

let shared: RichText | null = null;
let readCell: CellReader | null = null;

function richText(): RichText {
  if (!shared) shared = createRichText({ DOMParser: DOMParser, images: registryImages, ids: randomIds });
  return shared;
}

export function inertBody(html: unknown): HTMLElement {
  return richText().inertBody(html);
}

export function sanitizeHtml(html: unknown): string {
  return richText().sanitize(html);
}

export function imageRefOf(node: Element): StoredImageRef | null {
  return richText().imageRefOf(node);
}

export function storedHtmlFromDom<T>(html: T): T | string {
  return richText().storedHtmlFromDom(html);
}

export function htmlToMarkdown(html: unknown): string {
  return richText().htmlToMarkdown(html);
}

export function buildVideoCardEl(href: string): HTMLAnchorElement {
  return richText().videoCardElement(href);
}

export function videoCardHtml(href: string): string {
  return richText().videoCardHtml(href);
}

export function fromHtml(html: unknown, opts?: DecodeOptions | null): Run[] {
  return richText().decode(html, opts);
}

export function cellOf(html: unknown): Frozen<Run[]> {
  if (!readCell) readCell = richText().createCellReader(cacheSeal);
  return readCell(html);
}
