import type { CellRewrite, RewritePlanner } from "./document-edit.ts";
import type { DocumentView } from "../session/document-session.ts";
import type { TextServices } from "../text/services.ts";
import { normalizeTagName } from "../../core/document/tags.ts";
import { holdsMedia, retagCell } from "../../core/production/tags.ts";
import { namedTagId } from "../../core/text/runs.ts";

type RetagText = Pick<TextServices<HTMLElement>, "cellOf" | "productionReaders" | "inertBody" | "sanitizeHtml">;

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

function retagInHtml(text: RetagText, html: string, cat: string, target: string, toName: string | null): string {
  const body = text.inertBody(html);
  Array.prototype.forEach.call(body.querySelectorAll(".tag-anchor"), function (el: Element) {
    if (el.getAttribute("data-tag-cat") !== cat) return;
    if (normalizeTagName(el.getAttribute("data-tag-name")) !== target) return;
    if (toName !== null) { el.setAttribute("data-tag-name", toName); return; }
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  });
  return text.sanitizeHtml(body.innerHTML);
}

function copies(doc: DocumentView): CellCopy[] {
  return doc.rows.map(function (row) { return { id: row.id, visualText: row.visualText, audioText: row.audioText }; });
}

function retagOne(text: RetagText, rows: CellCopy[], tag: TagName, toName: string | null): { mentions: number; rewrites: CellRewrite[] } {
  const target = normalizeTagName(tag.name);
  const toId = toName === null ? null : namedTagId(tag.cat, toName);
  const out = { mentions: 0, rewrites: [] as CellRewrite[] };
  rows.forEach(function (row) {
    TAGGED_FIELDS.forEach(function (field) {
      const html = htmlOf(row[field]);
      const mentions = text.productionReaders.tagsInField(html).filter(function (t) {
        return t.catId === tag.cat && normalizeTagName(t.name) === target;
      }).length;
      if (!mentions) return;
      out.mentions += mentions;
      const next = holdsMedia(html) ? retagInHtml(text, html, tag.cat, target, toName) : retagCell(html, tag.cat, target, toId, text);
      row[field] = next;
      out.rewrites.push({ rowId: row.id, field: field, html: next });
    });
  });
  return out;
}

function retagAll(text: RetagText, doc: DocumentView, tags: readonly TagName[], toName: string | null): { mentions: number; rewrites: CellRewrite[] } {
  const rows = copies(doc);
  const latest = new Map<string, CellRewrite>();
  let mentions = 0;
  tags.forEach(function (tag) {
    const found = retagOne(text, rows, tag, toName);
    mentions += found.mentions;
    found.rewrites.forEach(function (r) { latest.set(r.rowId + "\u0000" + r.field, r); });
  });
  return { mentions: mentions, rewrites: Array.from(latest.values()) };
}

export function retagRewrites(text: RetagText, tags: readonly TagName[], toName: string | null): RewritePlanner {
  return function (doc) { return retagAll(text, doc, tags, toName).rewrites; };
}

export function retagMentions(text: RetagText, doc: DocumentView | null, tags: readonly TagName[]): number {
  return doc ? retagAll(text, doc, tags, null).mentions : 0;
}
