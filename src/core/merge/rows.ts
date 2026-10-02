import { normalizeImageRef } from "../../../shared/blob-policy.js";
import { GALLERY_FIELDS, ROW_FIELDS } from "../document/fields.ts";
import { galleryFieldKey, mergeGalleryField } from "../document/gallery.ts";
import type { GallerySide } from "../document/gallery.ts";
import type { Clock, IdSource } from "../document/ports.ts";
import { escapeHtml, storedImageHtml } from "../document/text-policy.ts";
import { hasSetLength } from "../document/timing.ts";
import { mergeTextField } from "./text-field.ts";
import type { TextMergeContext } from "./text-field.ts";

export interface Identified {
  id: string;
}

export interface MergeRow extends Identified {
  status?: unknown;
  lengthSeconds?: unknown;
  imageRef?: unknown;
  imageName?: unknown;
  imageAnnotation?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
  [key: string]: unknown;
}

export interface MergeReply extends Identified {
  createdAt?: string | null | undefined;
  [key: string]: unknown;
}

export interface MergeComment extends Identified {
  body?: unknown;
  resolved?: unknown;
  resolvedBy?: unknown;
  resolvedAt?: string | null | undefined;
  assignee?: unknown;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  replies?: MergeReply[] | null | undefined;
  [key: string]: unknown;
}

export interface RowSide {
  rows: MergeRow[];
  comments?: MergeComment[] | null | undefined;
}

export interface MergeConflict {
  rowId: string | null;
  field: string;
  mine: unknown;
  theirs: unknown;
}

export interface MergeStats {
  rowsFromThem: number;
  rowsFromMe: number;
  rowsAddedByMe: number;
  rowsAddedByThem: number;
}

export interface RowMergeContext {
  text: TextMergeContext;
  conflicts: MergeConflict[];
  stats: MergeStats;
  clock: Clock;
  editor: () => string;
}

export interface CardPorts {
  ids: IdSource;
  clock: Clock;
  editor: () => string;
}

function jsonCopy<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

export function byId<T extends Identified>(list: readonly T[] | null | undefined): Record<string, T> {
  const map: Record<string, T> = {};
  (list || []).forEach(function (item) { map[item.id] = item; });
  return map;
}

export function rowFieldKey(row: Readonly<Record<string, unknown>> | null | undefined, f: string): unknown {
  if (!row) return null;
  if (GALLERY_FIELDS[f]) return galleryFieldKey(row, f);
  if (f === "imageRef") {
    const r = row.imageRef as { sha256?: unknown } | null | undefined;
    return r && typeof r === "object" && typeof r.sha256 === "string" ? r.sha256 : null;
  }
  return row[f] || null;
}

export function rowContentEqual(a: Readonly<Record<string, unknown>> | null | undefined, b: Readonly<Record<string, unknown>> | null | undefined): boolean {
  if (!a || !b) return false;
  return ROW_FIELDS.every(function (f) { return rowFieldKey(a, f) === rowFieldKey(b, f); }) &&
    setLengthOf(a) === setLengthOf(b);
}

function setLengthOf(row: { lengthSeconds?: unknown }): number | null {
  return hasSetLength(row) ? row.lengthSeconds : null;
}

export function commentContentEqual(a: MergeComment | null | undefined, b: MergeComment | null | undefined): boolean {
  if (!a || !b) return false;
  if ((a.body || "") !== (b.body || "")) return false;
  if (!!a.resolved !== !!b.resolved) return false;
  if ((a.assignee || "") !== (b.assignee || "")) return false;
  if (JSON.stringify(a.replies || []) !== JSON.stringify(b.replies || [])) return false;
  return true;
}

export function mergeRows(base: RowSide | null | undefined, mine: RowSide, theirs: RowSide, ctx: RowMergeContext): MergeRow[] {
  const conflicts = ctx.conflicts, stats = ctx.stats;
  const baseRows = byId(base && base.rows), mineRows = byId(mine.rows), theirRows = byId(theirs.rows);
  const merged: MergeRow[] = [];
  const placed: Record<string, boolean> = {};

  function mergeRow(b: MergeRow | undefined, m: MergeRow, t: MergeRow): MergeRow {
    const out = jsonCopy(t);
    let tookMine = false, tookTheirs = false;
    ROW_FIELDS.forEach(function (f) {
      if (GALLERY_FIELDS[f]) {
        if (galleryFieldKey(m, f) === galleryFieldKey(t, f)) return;
        const g = mergeGalleryField(f, b as GallerySide | undefined, m as GallerySide, t as GallerySide);
        const probe: Record<string, unknown> = {};
        probe[f] = g;
        const gk = galleryFieldKey(probe, f);
        if (gk !== galleryFieldKey(t, f)) {
          if (g) out[f] = g; else Reflect.deleteProperty(out, f);
          tookMine = true;
        }
        if (gk !== galleryFieldKey(m, f)) tookTheirs = true;
        return;
      }
      if (f !== "imageRef") {
        const r = mergeTextField(b ? (b[f] == null ? "" : b[f]) : undefined, m[f], t[f], ctx.text);
        if (r.html !== (t[f] == null ? "" : String(t[f]))) out[f] = r.html;
        if (r.outcome === "mine" || r.outcome === "merged" || r.withMine) tookMine = true;
        if (r.outcome === "theirs" || r.outcome === "merged" || r.outcome === "conflict") tookTheirs = true;
        if (r.outcome === "conflict") conflicts.push({ rowId: t.id, field: f, mine: m[f] || null, theirs: t[f] || null });
        return;
      }
      const mv = rowFieldKey(m, f), tv = rowFieldKey(t, f), bv = b ? rowFieldKey(b, f) : null;
      if (mv === tv) return;
      if (b && mv === bv) { tookTheirs = true; return; }
      if (b && tv === bv) {
        out[f] = m[f] == null ? null : jsonCopy(m[f]);
        if (m.imageName) out.imageName = m.imageName; else delete out.imageName;
        if (m.imageAnnotation) out.imageAnnotation = jsonCopy(m.imageAnnotation);
        else delete out.imageAnnotation;
        tookMine = true;
        return;
      }
      tookTheirs = true;
      conflicts.push({ rowId: t.id, field: f, mine: m[f] || null, theirs: t[f] || null });
    });
    const rank: Record<string, number> = { todo: 0, ready: 1, shot: 2 };
    out.status = (rank[m.status as string] || 0) >= (rank[t.status as string] || 0) ? m.status : t.status;
    const ml = setLengthOf(m), tl = setLengthOf(t), bl = b ? setLengthOf(b) : null;
    if (ml !== tl) {
      const useMine = b ? (tl === bl) : (tl === null);
      const len = useMine ? ml : tl;
      if (len === null) delete out.lengthSeconds; else out.lengthSeconds = len;
      if (useMine) tookMine = true; else tookTheirs = true;
    }
    if (tookMine) {
      out.updatedAt = ctx.clock.nowIso();
      out.updatedBy = ctx.editor();
      stats.rowsFromMe++;
    } else if (b ? tookTheirs : !rowContentEqual({}, t)) {
      stats.rowsFromThem++;
    }
    return out;
  }

  theirs.rows.forEach(function (t) {
    const b = baseRows[t.id], m = mineRows[t.id];
    if (!m) {
      if (b && rowContentEqual(b, t)) return;
      merged.push(jsonCopy(t));
      placed[t.id] = true;
      return;
    }
    merged.push(mergeRow(b, m, t));
    placed[t.id] = true;
  });

  mine.rows.forEach(function (m, idxInMine) {
    if (placed[m.id] || theirRows[m.id]) return;
    const b = baseRows[m.id];
    if (b && rowContentEqual(b, m)) return;
    if (!b) stats.rowsAddedByMe++;
    let anchorIdx = -1;
    for (let k = idxInMine - 1; k >= 0; k--) {
      const prevId = (mine.rows[k] as MergeRow).id;
      for (let j = 0; j < merged.length; j++) {
        if ((merged[j] as MergeRow).id === prevId) { anchorIdx = j; break; }
      }
      if (anchorIdx !== -1) break;
    }
    const copy = jsonCopy(m);
    if (anchorIdx === -1) merged.unshift(copy);
    else merged.splice(anchorIdx + 1, 0, copy);
    placed[m.id] = true;
  });

  theirs.rows.forEach(function (t) { if (!baseRows[t.id] && !mineRows[t.id]) stats.rowsAddedByThem++; });

  return merged;
}

export function mergeComments(base: RowSide | null | undefined, mine: RowSide, theirs: RowSide): MergeComment[] {
  const baseC = byId(base && base.comments), mineC = byId(mine.comments), theirC = byId(theirs.comments);
  const mergedComments: MergeComment[] = [];
  const seen: Record<string, boolean> = {};
  function newer(a: MergeComment, b2: MergeComment): MergeComment {
    return (a.updatedAt || a.createdAt || "") >= (b2.updatedAt || b2.createdAt || "") ? a : b2;
  }
  Object.keys(theirC).concat(Object.keys(mineC)).forEach(function (id) {
    if (seen[id]) return;
    seen[id] = true;
    const m = mineC[id], t = theirC[id], b = baseC[id];
    let pick: MergeComment;
    if (m && t) {
      pick = jsonCopy(newer(m, t));
      pick.resolved = !!(m.resolved || t.resolved);
      if (m.resolved && t.resolved) {
        if ((t.resolvedAt || "") >= (m.resolvedAt || "")) {
          pick.resolvedBy = t.resolvedBy || null; pick.resolvedAt = t.resolvedAt || null;
        } else {
          pick.resolvedBy = m.resolvedBy || null; pick.resolvedAt = m.resolvedAt || null;
        }
      } else if (m.resolved) {
        pick.resolvedBy = m.resolvedBy || null; pick.resolvedAt = m.resolvedAt || null;
      } else if (t.resolved) {
        pick.resolvedBy = t.resolvedBy || null; pick.resolvedAt = t.resolvedAt || null;
      } else {
        pick.resolvedBy = null; pick.resolvedAt = null;
      }
      if (!pick.assignee) pick.assignee = m.assignee || t.assignee || "";
    }
    else if (t && !m) { if (b && commentContentEqual(b, t)) return; pick = jsonCopy(t); }
    else { if (b && commentContentEqual(b, m)) return; pick = jsonCopy(m as MergeComment); }
    if (m && t) {
      const replies = byId(m.replies);
      (t.replies || []).forEach(function (r) { replies[r.id] = r; });
      pick.replies = jsonCopy(Object.keys(replies).map(function (k) { return replies[k] as MergeReply; })
        .sort(function (x, y) { return (x.createdAt || "").localeCompare(y.createdAt || ""); }));
    }
    mergedComments.push(pick);
  });
  return mergedComments;
}

export function conflictComment(c: MergeConflict, ports: CardPorts): MergeComment {
  const image = c.field === "imageRef";
  const label = c.field === "audioText" ? "Audio" : c.field === "visualText" ? "Visual" :
    c.field === "title" ? "Title" : "Visual image";
  const isEmpty = !c.mine;
  const bodyHtml = image ? storedImageHtml(c.mine)
    : c.field === "title" ? escapeHtml(c.mine || "")
    : (c.mine || "");
  return {
    id: ports.ids.id("c"),
    rowId: c.rowId,
    field: image ? "visualImage" : c.field,
    imageValue: image ? (normalizeImageRef(c.mine) || null) : undefined,
    anchorId: null,
    quotedText: "",
    author: ports.editor(),
    body: bodyHtml,
    resolved: false,
    createdAt: ports.clock.nowIso(),
    updatedAt: ports.clock.nowIso(),
    kind: "conflict",
    conflictField: label,
    emptyValue: isEmpty,
    titleValue: c.field === "title" ? (c.mine || "") : undefined,
    replies: []
  };
}
