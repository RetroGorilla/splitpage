import type { ExportServices } from "../../application/export/services.ts";
import type { ExportDocument, ExportPerson, ExportShotEntry, ClockMode } from "../../core/document/export-document.ts";
import type { DocumentRow } from "../../core/document/validated.ts";
import type { Frozen } from "../../core/document/freeze.ts";
import type { RowStatusId } from "../../core/document/timing.ts";
import { formatDateClock } from "../../../shared/clock.js";
import { isSha256Hex, normalizeImageRef } from "../../../shared/blob-policy.js";
import { exportServices } from "../../application/export/services.ts";
import { compareCommentPositions } from "../../core/document/comments.ts";
import { normalizeTagName } from "../../core/document/tags.ts";
import { hasSetLength } from "../../core/document/timing.ts";
import { brollSortedForList } from "../../core/production/broll.ts";
import {
  groupTagsByCategory,
  rowStatus,
  tagCategory,
  tagStatus
} from "../../core/production/looks.ts";
import { formatDuration, formatTimecode, pad2, rowSeconds as rowSecondsIn } from "../../core/production/timing.ts";

type Shot = Frozen<ExportShotEntry>;
type Person = Frozen<ExportPerson>;
type Row = Frozen<DocumentRow>;
export type TableCell = string | number;
export interface SceneFacts {
  index: number;
  number: string;
  start: string;
  startSeconds: number;
  seconds: number;
  read: string;
  readSet: boolean;
  status: { id: RowStatusId; label: string };
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
  scenes: string[];
  broll: string[];
}
export interface BreakdownTable {
  head: string[];
  rows: { catId: string; status: string; cells: TableCell[] }[];
}
export interface BrollTable {
  head: string[];
  rows: { shot: boolean; flagged: boolean; cells: TableCell[] }[];
}
export interface ShotRecord {
  scene: string;
  name: string;
  status: string;
  shot: boolean;
  flagged: boolean;
  location: string;
  props: string[];
  propsWithStatus: string[];
  cuts: string;
  owner: string;
  note: string;
  desc: string;
}
export interface BrollGroup {
  key: string;
  kind: string;
  label: string;
  row?: Row | null;
  items: Shot[];
  none?: boolean;
}
export type BodyPiece = { image: string; text?: never } | { text: string; image?: never };
export interface CommentBody {
  body: string;
  pieces?: BodyPiece[];
}
export interface CommentReply extends CommentBody {
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
export interface CommentInput {
  kind?: unknown;
  field?: unknown;
  imageValue?: unknown;
  body?: unknown;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }


export function sceneFacts(doc: ExportDocument, services: ExportServices = exportServices()): SceneFacts[] {
  let at = 0;
  return (doc.scenes || []).map(function (r, i) {
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
      const scenes: string[] = [];
      const seen: Record<number, boolean> = {};
      item.mentions.forEach(function (m) {
        if (seen[m.rowIndex]) return;
        seen[m.rowIndex] = true;
        scenes.push(pad2(m.rowIndex + 1));
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
        scenes: item.orphaned ? ["not in script"] : scenes,
        broll: shotsFor[item.key] || []
      });
    });
  });
  return out;
}

export function breakdownTable(doc: ExportDocument, services: ExportServices = exportServices()): BreakdownTable {
  const starts = sceneFacts(doc, services).map(function (f) { return f.start; });
  const out: BreakdownTable = {
    head: ["Category", "Item", "Status", "Assigned to", "Mentions", "Scenes", "In script", "Notes", "B-roll shots",
           "First scene at", "Group"],
    rows: []
  };
  breakdownRows(doc).forEach(function (r) {
    const first = r.inScript === "no" ? "" : (starts[Number(r.scenes[0]) - 1] || "");
    out.rows.push({ catId: r.catId, status: r.status, cells: [
      r.categoryLabel,
      r.name,
      r.statusLabel,
      r.owner,
      r.mentions,
      r.scenes.join(" "),
      r.inScript,
      r.notes,
      r.broll.join("; "),
      first,
      r.category
    ] });
  });
  return out;
}

export function oneOf(list: readonly { id: string }[], id: unknown, fallback: string): string {
  for (const item of list) if (item.id === id) return item.id;
  return fallback;
}

export const FILTERS = [
  { id: "all",     label: "All" },
  { id: "unshot",  label: "To shoot" },
  { id: "flagged", label: "Flagged" },
  { id: "shot",    label: "Shot" }
];

export const PAGE_GROUPS = [
  { id: "location", label: "Location" },
  { id: "scene",    label: "Scene" },
  { id: "person",   label: "Person" }
];

export function matchesFilter(e: Shot, filter: string): boolean {
  if (filter === "unshot") return e.status !== "shot";
  if (filter === "shot") return e.status === "shot";
  if (filter === "flagged") return e.reshoot;
  return true;
}

export function filterCounts(entries: readonly Shot[]) {
  const n = { all: entries.length, unshot: 0, shot: 0, flagged: 0 };
  entries.forEach(function (e) {
    if (e.status === "shot") n.shot++; else n.unshot++;
    if (e.reshoot) n.flagged++;
  });
  return n;
}

export function pageSummaryText(entries: readonly Shot[]): string {
  const n = filterCounts(entries);
  return n.shot + " of " + n.all + " shot" + (n.flagged ? " · " + n.flagged + " flagged" : "");
}

export function personIn(people: readonly Person[], id: string): Person | null {
  if (!id) return null;
  for (const person of people) {
    if (person.id === id) return person;
  }
  return null;
}

export function sceneLabel(e: Shot): string {
  return e.rowIndex === -1 ? "" : pad2(e.rowIndex + 1);
}

export function startOf(e: Shot, starts: Readonly<Record<string, number>>): string {
  return e.rowId && starts[e.rowId] !== undefined ? formatTimecode(starts[e.rowId] ?? 0) : "";
}

export function capturedStarts(doc: ExportDocument, services: ExportServices = exportServices()): Record<string, number> {
  let t = 0;
  const out: Record<string, number> = {};
  Object.setPrototypeOf(out, null);
  doc.scenes.forEach(function (row) { out[row.id] = t; t += rowSecondsIn(row, doc.document, services.productionReaders); });
  return out;
}

export function shotRecordForFile(e: Shot, people: readonly Person[]): ShotRecord {
  const who = personIn(people, e.owner);
  return {
    scene: e.rowId ? sceneLabel(e) : "",
    name: e.name || "Untitled shot",
    status: e.status === "shot" ? "Shot" : "To shoot",
    shot: e.status === "shot",
    flagged: !!e.reshoot,
    location: e.location || "",
    props: e.props.map(function (p) { return p.name; }),
    propsWithStatus: e.props.map(function (p) {
      const st = tagStatus(p.status);
      return p.name + (st ? " (" + st.label.toLowerCase() + ")" : "");
    }),
    cuts: e.audioRef || "",
    owner: who ? who.name : "",
    note: e.notes || "",
    desc: e.desc || ""
  };
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
    out.rows.push({ shot: r.shot, flagged: r.flagged, cells: [r.scene, r.name, r.status, r.flagged ? "yes" : "", r.location,
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
    groups: brollGroups(shown, groupId, { rows: doc.scenes, people: doc.people }).map(function (g) {
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

export function brollGroups(entries: readonly Shot[], by: string, from: { rows: readonly Row[]; people: readonly Person[] }): BrollGroup[] {
  const rows = from.rows;
  const people = from.people;
  const sorted = brollSortedForList(entries);
  if (by === "flat") return [{ key: "all", kind: "flat", label: "", items: sorted }];
  const groups: BrollGroup[] = [];
  const byKey: Record<string, BrollGroup> = {};
  sorted.forEach(function (e) {
    let key: string, label: string;
    let kind = by;
    let row: Row | null = null;
    if (by === "scene") {
      if (e.rowIndex === -1) { key = "added"; label = "Added here"; kind = "added"; }
      else { key = "r:" + e.rowId; label = "Scene " + pad2(e.rowIndex + 1); row = rows[e.rowIndex] || null; }
    } else if (by === "location") {
      key = e.location ? "l:" + normalizeTagName(e.location) : "none";
      label = e.location || "No location";
    } else {
      const who = personIn(people, e.owner);
      key = who ? "p:" + who.id : "none";
      label = who ? who.name : "Unassigned";
    }
    let group = byKey[key];
    if (!group) {
      group = { key: key, kind: kind, label: label, row: row, items: [], none: key === "none" };
      byKey[key] = group;
      groups.push(group);
    }
    group.items.push(e);
  });
  if (by !== "scene") {
    groups.sort(function (a, b) {
      if (a.none !== b.none) return a.none ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  }
  return groups;
}

function capturedRowIndex(doc: ExportDocument) {
  const at = new Map<string, number>();
  doc.scenes.forEach(function (row, i) { if (!at.has(row.id)) at.set(row.id, i); });
  return function (id: unknown): number { return typeof id === "string" ? (at.get(id) ?? -1) : -1; };
}

function capturedLocationLabel(rowIndex: number, field: string): string {
  if (field === "title") return "Document title";
  const rowLabel = rowIndex === -1 ? "Deleted row" : ("Row " + pad2(rowIndex + 1));
  return rowLabel + " · " + (field === "audioText" ? "Audio" : "Visual");
}

export function formatTimestampAbsolute(iso: string | null | undefined, clockMode?: ClockMode): string {
  try {
    const d = new Date(iso === null ? 0 : iso === undefined ? NaN : iso);
    if (isNaN(d.getTime())) return "";
    return formatDateClock(d, { year: true }, clockMode);
  } catch (e) { return ""; }
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

export function bodyPieces(html: unknown, services: ExportServices = exportServices()): BodyPiece[] {
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

export function commentBodyPieces(c: CommentInput, services: ExportServices = exportServices()): BodyPiece[] {
  if (c.kind === "conflict" && c.field === "visualImage") {
    const ref = normalizeImageRef(c.imageValue);
    return ref ? [{ image: ref.sha256 }] : [];
  }
  return bodyPieces(c.body, services);
}

export const COMMENT_IMAGE_TEXT = "[image]";

export function commentBodyText(entry: CommentBody): string {
  const pieces = (entry && entry.pieces) || [];
  if (!pieces.some(function (p) { return p.image; })) return entry.body;
  return pieces.map(function (p) { return p.image ? COMMENT_IMAGE_TEXT : p.text; }).join("\n");
}
