import { brollGroups, shotRecordForFile, oneOf, FILTERS, PAGE_GROUPS, matchesFilter, pageSummaryText, startOf } from "../../core/production/broll-view.ts";
import type { ExportServices } from "../../application/export/services.ts";
import type { ExportDocument, ClockMode } from "../../core/document/export-document.ts";
import type { RowStatusId } from "../../core/document/timing.ts";
import { formatTimestampAbsolute } from "../../../shared/clock.ts";
import { isSha256Hex, normalizeImageRef } from "../../../shared/blob-policy.ts";
import { exportServices } from "../../application/export/services.ts";
import { compareCommentPositions } from "../../core/document/comments.ts";
import { normalizeTagName } from "../../core/document/tags.ts";
import { hasSetLength } from "../../core/document/timing.ts";
import { sectionGroups } from "../../core/document/sections.ts";
import { brollSortedForList } from "../../core/production/broll.ts";
import {
  groupTagsByCategory,
  rowStatus,
  tagCategory,
  tagStatus
} from "../../core/production/looks.ts";
import { formatDuration, formatTimecode, pad2, rowSeconds as rowSecondsIn } from "../../core/production/timing.ts";

export type TableCell = string | number;
export interface BeatFacts {
  index: number;
  number: string;
  start: string;
  startSeconds: number;
  seconds: number;
  read: string;
  readSet: boolean;
  status: { id: RowStatusId; label: string };
}
export interface ScriptSectionFacts {
  readonly id: string;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly total: string;
}
export interface BreakdownRow {
  catId: string;
  category: string;
  categoryLabel: string;
  name: string;
  mentions: number;
  owner: string;
  status: string;
  statusLabel: string;
  notes: string;
  inScript: string;
  beats: string[];
  broll: string[];
}
interface BreakdownTable {
  head: string[];
  rows: { catId: string; status: string; cells: TableCell[] }[];
}
interface BrollTable {
  head: string[];
  rows: { shot: boolean; flagged: boolean; cells: TableCell[] }[];
}
export type BodyPiece = { image: string; text?: never } | { text: string; image?: never };
export interface CommentBody {
  body: string;
  pieces?: BodyPiece[];
}
interface CommentReply extends CommentBody {
  author: string;
  when: string;
}
export interface CommentEntry extends CommentReply {
  id: string;
  rowIndex: number;
  field: string;
  location: string;
  quoted: string;
  resolved: boolean;
  resolvedBy: string;
  assignee: string;
  replies: CommentReply[];
}
export interface CommentOptions {
  pieces?: boolean;
  clockMode?: ClockMode | undefined;
}
interface CommentInput {
  kind?: unknown;
  field?: unknown;
  imageValue?: unknown;
  body?: unknown;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }


export function beatFacts(doc: ExportDocument, services: ExportServices = exportServices()): BeatFacts[] {
  let at = 0;
  return (doc.beats || []).map(function (r, i) {
    const sec = rowSecondsIn(r, doc.document, services.productionReaders);
    const st = rowStatus(r.status) || rowStatus("todo");
    if (!st) throw new Error("Missing row status");
    const out = {
      index: i,
      number: pad2(i + 1),
      start: formatTimecode(at),
      startSeconds: at,
      seconds: sec,
      read: formatDuration(sec),
      readSet: hasSetLength({ lengthSeconds: r.lengthSeconds }),
      status: { id: st.id, label: st.label }
    };
    at += sec;
    return out;
  });
}

export function scriptSectionFacts(doc: ExportDocument, beats: readonly BeatFacts[]): ScriptSectionFacts[] {
  return sectionGroups({ rows: doc.beats, sections: doc.document.sections }).map(group => ({
    id: group.section.id, name: group.section.name, start: group.start, end: group.end,
    total: formatDuration(beats.slice(group.start, group.end).reduce((sum, beat) => sum + beat.seconds, 0))
  }));
}

function capturedEntries(doc: ExportDocument) {
  return doc.production.map(function (e) {
    const cat = tagCategory(e.catId);
    if (!cat) throw new Error("Unknown tag category: " + e.catId);
    return { ...e, cat };
  });
}

function capturedShotsByProp(doc: ExportDocument): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  brollSortedForList(doc.broll).forEach(function (e) {
    e.props.forEach(function (p) {
      const k = "prop " + normalizeTagName(p.name);
      const list = out[k] || (out[k] = []);
      list.push(e.name || "Untitled shot");
    });
  });
  return out;
}

function capturedPerson(doc: ExportDocument, id: string) {
  if (!id) return null;
  for (const person of doc.people) {
    if (person.id === id) return person;
  }
  return null;
}

export function breakdownRows(doc: ExportDocument): BreakdownRow[] {
  const out: BreakdownRow[] = [];
  const shotsFor = capturedShotsByProp(doc);
  groupTagsByCategory(capturedEntries(doc)).forEach(function (g) {
    g.items.forEach(function (item) {
      const beats: string[] = [];
      const seen: Record<number, boolean> = {};
      item.mentions.forEach(function (m) {
        if (seen[m.rowIndex]) return;
        seen[m.rowIndex] = true;
        beats.push(pad2(m.rowIndex + 1));
      });
      const owner = capturedPerson(doc, item.owner);
      const st = tagStatus(item.status) || tagStatus("needed");
      if (!st) throw new Error("Missing tag status");
      out.push({
        catId: g.cat.id,
        category: g.cat.plural,
        categoryLabel: g.cat.label,
        name: item.name,
        mentions: item.mentions.length,
        owner: owner ? owner.name : "",
        status: st.id,
        statusLabel: st.label,
        notes: item.notes || "",
        inScript: item.orphaned ? "no" : "yes",
        beats: item.orphaned ? ["not in script"] : beats,
        broll: shotsFor[item.key] || []
      });
    });
  });
  return out;
}

export function breakdownTable(doc: ExportDocument, services: ExportServices = exportServices()): BreakdownTable {
  const starts = beatFacts(doc, services).map(function (f) { return f.start; });
  const out: BreakdownTable = {
    head: ["Category", "Item", "Status", "Assigned to", "Mentions", "Scenes", "In script", "Notes", "B-roll shots",
           "First scene at", "Group"],
    rows: []
  };
  breakdownRows(doc).forEach(function (r) {
    const first = r.inScript === "no" ? "" : (starts[Number(r.beats[0]) - 1] || "");
    out.rows.push({ catId: r.catId, status: r.status, cells: [
      r.categoryLabel,
      r.name,
      r.statusLabel,
      r.owner,
      r.mentions,
      r.beats.join(" "),
      r.inScript,
      r.notes,
      r.broll.join("; "),
      first,
      r.category
    ] });
  });
  return out;
}

function capturedStarts(doc: ExportDocument, services: ExportServices = exportServices()): Record<string, number> {
  let t = 0;
  const out: Record<string, number> = {};
  Object.setPrototypeOf(out, null);
  doc.beats.forEach(function (row) { out[row.id] = t; t += rowSecondsIn(row, doc.document, services.productionReaders); });
  return out;
}

export function brollTable(doc: ExportDocument, services: ExportServices = exportServices()): BrollTable {
  const out: BrollTable = {
    head: ["Scene", "Shot", "Status", "Flagged", "Location", "Props", "Cuts against", "Assigned to", "Note", "Description",
           "Scene start"],
    rows: []
  };
  const starts = capturedStarts(doc, services);
  brollSortedForList(doc.broll).forEach(function (e) {
    const r = shotRecordForFile(e, doc.people);
    out.rows.push({ shot: r.shot, flagged: r.flagged, cells: [r.beat, r.name, r.status, r.flagged ? "yes" : "", r.location,
      r.props.join("; "), r.cuts, r.owner, r.note, r.desc, startOf(e, starts)] });
  });
  return out;
}

export function brollShotListForPrint(doc: ExportDocument, as?: unknown, services: ExportServices = exportServices()) {
  const filterValue = as && typeof as === "object" && "filter" in as ? as.filter : undefined;
  const groupValue = as && typeof as === "object" && "group" in as ? as.group : undefined;
  const filterId = oneOf(FILTERS, filterValue, "all");
  const groupId = oneOf(PAGE_GROUPS, groupValue, "scene");
  const entries = doc.broll;
  const shown = entries.filter(function (e) { return matchesFilter(e, filterId); });
  const filter = FILTERS.filter(function (f) { return f.id === filterId; })[0];
  const group = PAGE_GROUPS.find(function (g) { return g.id === groupId; });
  if (!group) throw new Error("Missing b-roll grouping");
  const starts = capturedStarts(doc, services);
  return {
    title: doc.title || "Untitled Script",
    summary: pageSummaryText(entries),
    scope: (filter && filter.id !== "all" ? filter.label + ", " : "") + "by " + group.label.toLowerCase(),
    groups: brollGroups(shown, groupId, { rows: doc.beats, people: doc.people }).map(function (g) {
      return {
        label: g.label,
        kind: g.kind,
        none: !!g.none,
        start: g.row && starts[g.row.id] !== undefined ? formatTimecode(starts[g.row.id] ?? 0) : "",
        done: g.items.filter(function (e) { return e.status === "shot"; }).length,
        total: g.items.length,
        items: g.items.map(function (e) {
          return { ...shotRecordForFile(e, doc.people), start: startOf(e, starts) };
        })
      };
    })
  };
}

function capturedRowIndex(doc: ExportDocument) {
  const at = new Map<string, number>();
  doc.beats.forEach(function (row, i) { if (!at.has(row.id)) at.set(row.id, i); });
  return function (id: unknown): number { return typeof id === "string" ? (at.get(id) ?? -1) : -1; };
}

function capturedLocationLabel(rowIndex: number, field: string): string {
  if (field === "title") return "Document title";
  const rowLabel = rowIndex === -1 ? "Deleted row" : ("Row " + pad2(rowIndex + 1));
  return rowLabel + " · " + (field === "audioText" ? "Audio" : "Visual");
}

export function commentEntries(doc: ExportDocument, opts?: CommentOptions | null, services: ExportServices = exportServices()): CommentEntry[] {
  const pieces = !!(opts && opts.pieces);
  const clockMode = opts?.clockMode;
  const rowIndexOf = capturedRowIndex(doc);
  const list = (doc.comments || []).slice();
  list.sort(function (a, b) {
    return compareCommentPositions({ rowId: text(a.rowId), field: text(a.field), createdAt: a.createdAt },
      { rowId: text(b.rowId), field: text(b.field), createdAt: b.createdAt }, rowIndexOf);
  });
  return list.map(function (c) {
    const rowIndex = rowIndexOf(c.rowId);
    const entry: CommentEntry = {
      id: c.id,
      rowIndex: c.field === "title" ? -1 : rowIndex,
      field: text(c.field),
      location: capturedLocationLabel(rowIndex, text(c.field)),
      author: text(c.author) || "Anonymous",
      body: services.htmlToPlainText(c.body),
      quoted: text(c.quotedText),
      resolved: !!c.resolved,
      resolvedBy: c.resolved ? text(c.resolvedBy) : "",
      assignee: text(c.assignee),
      when: formatTimestampAbsolute(c.createdAt, clockMode),
      replies: (c.replies || []).map(function (rp) {
        const reply: CommentReply = {
          author: text(rp.author) || "Anonymous",
          body: services.htmlToPlainText(rp.body),
          when: formatTimestampAbsolute(rp.createdAt, clockMode)
        };
        if (pieces) reply.pieces = bodyPieces(rp.body, services);
        return reply;
      })
    };
    if (pieces) entry.pieces = commentBodyPieces({ kind: c.kind, field: c.field, imageValue: c.imageValue, body: c.body }, services);
    return entry;
  });
}

function bodyPieces(html: unknown, services: ExportServices = exportServices()): BodyPiece[] {
  const out: BodyPiece[] = [];
  if (!html) return out;
  const root = services.inertBody(String(html).replace(/<br\s*\/?>/gi, "\n"));
  if (!(root instanceof Element)) throw new Error("Export inertBody must return an element");
  if (!root.querySelector("img[data-blob]")) {
    const only = services.htmlToPlainText(html);
    if (only) out.push({ text: only });
    return out;
  }
  let buf = "";
  function flush() {
    const t = buf.replace(/\u00A0/g, " ").trim();
    if (t) out.push({ text: t });
    buf = "";
  }
  (function walk(node: Node): void {
    node.childNodes.forEach(function (child) {
      if (child.nodeType === 3) { buf += child.nodeValue || ""; return; }
      if (!(child instanceof Element)) return;
      if (child.tagName === "IMG") {
        const sha = child.getAttribute("data-blob");
        if (isSha256Hex(sha)) { flush(); out.push({ image: String(sha) }); }
        return;
      }
      walk(child);
    });
  })(root);
  flush();
  return out;
}

function commentBodyPieces(c: CommentInput, services: ExportServices = exportServices()): BodyPiece[] {
  if (c.kind === "conflict" && c.field === "visualImage") {
    const ref = normalizeImageRef(c.imageValue);
    return ref ? [{ image: ref.sha256 }] : [];
  }
  return bodyPieces(c.body, services);
}

const COMMENT_IMAGE_TEXT = "[image]";

export function commentBodyText(entry: CommentBody): string {
  const pieces = (entry && entry.pieces) || [];
  if (!pieces.some(function (p) { return p.image; })) return entry.body;
  return pieces.map(function (p) { return p.image ? COMMENT_IMAGE_TEXT : p.text; }).join("\n");
}
