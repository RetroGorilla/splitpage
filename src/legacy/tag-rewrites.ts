import type { CellRewrite, RewritePlanner } from "../application/commands/document-edit.ts";
import type { DocumentView } from "../application/session/document-session.ts";
import { normalizeTagName } from "../core/document/tags.ts";
import { holdsMedia, retagCell } from "../core/production/tags.ts";
import { namedTagId } from "../core/text/runs.ts";
import { productionReaders } from "./document-ports.ts";
import { inertBody, sanitizeHtml } from "./richtext.ts";

export interface TagName {
  readonly cat: string;
  readonly name: string;
}

interface CellCopy {
  readonly id: string;
  visualText: unknown;
  audioText: unknown;
  [field: string]: unknown;
}

const TAGGED_FIELDS = ["visualText", "audioText"] as const;

function htmlOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function retagInHtml(html: string, cat: string, target: string, toName: string | null): string {
  const body = inertBody(html);
  Array.prototype.forEach.call(body.querySelectorAll(".tag-anchor"), function (el: Element) {
    if (el.getAttribute("data-tag-cat") !== cat) return;
    if (normalizeTagName(el.getAttribute("data-tag-name")) !== target) return;
    if (toName !== null) { el.setAttribute("data-tag-name", toName); return; }
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  });
  return sanitizeHtml(body.innerHTML);
}

function copies(doc: DocumentView): CellCopy[] {
  return doc.rows.map(function (row) { return { id: row.id, visualText: row.visualText, audioText: row.audioText }; });
}

function retagOne(rows: CellCopy[], tag: TagName, toName: string | null): { mentions: number; rewrites: CellRewrite[] } {
  const target = normalizeTagName(tag.name);
  const toId = toName === null ? null : namedTagId(tag.cat, toName);
  const out = { mentions: 0, rewrites: [] as CellRewrite[] };
  rows.forEach(function (row) {
    TAGGED_FIELDS.forEach(function (field) {
      const html = htmlOf(row[field]);
      const mentions = productionReaders.tagsInField(html).filter(function (t) {
        return t.catId === tag.cat && normalizeTagName(t.name) === target;
      }).length;
      if (!mentions) return;
      out.mentions += mentions;
      const next = holdsMedia(html) ? retagInHtml(html, tag.cat, target, toName) : retagCell(html, tag.cat, target, toId, productionReaders);
      row[field] = next;
      out.rewrites.push({ rowId: row.id, field: field, html: next });
    });
  });
  return out;
}

function retagAll(doc: DocumentView, tags: readonly TagName[], toName: string | null): { mentions: number; rewrites: CellRewrite[] } {
  const rows = copies(doc);
  const latest = new Map<string, CellRewrite>();
  let mentions = 0;
  tags.forEach(function (tag) {
    const found = retagOne(rows, tag, toName);
    mentions += found.mentions;
    found.rewrites.forEach(function (r) { latest.set(r.rowId + "\u0000" + r.field, r); });
  });
  return { mentions: mentions, rewrites: Array.from(latest.values()) };
}

export function retagRewrites(tags: readonly TagName[], toName: string | null): RewritePlanner {
  return function (doc) { return retagAll(doc, tags, toName).rewrites; };
}

export function retagMentions(doc: DocumentView | null, tags: readonly TagName[]): number {
  return doc ? retagAll(doc, tags, null).mentions : 0;
}
