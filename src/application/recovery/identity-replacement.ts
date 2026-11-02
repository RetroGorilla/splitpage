import { cloneState } from "../../core/document/clone.ts";
import { sha256Hex } from "../../core/document/ids.ts";
import { normalizeSections } from "../../core/document/sections.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { rowContentEqual } from "../../core/merge/rows.ts";
import { toHtml } from "../../core/text/html.ts";
import type { CellDecoder } from "../../core/text/ports.ts";

function loadRow(id: string): boolean {
  return /^r-(?:load-[0-9a-f]{24}-[0-9]+|[0-9a-f]{24})(?:-[0-9]+)*$/.test(id);
}

export function prepareIdentityReplacement(
  base: ValidatedDocument | null,
  mine: ValidatedDocument,
  disk: ValidatedDocument,
  decode: CellDecoder
): { base: ValidatedDocument | null; mine: ValidatedDocument; disk: ValidatedDocument } {
  const baseIds = new Set(base?.rows.map(row => row.id));
  const diskIds = new Set(disk.rows.map(row => row.id));
  if (!disk.rows.some(row => loadRow(row.id) && !baseIds.has(row.id))) return { base, mine, disk };
  const baseRows = new Map(base?.rows.map(row => [row.id, row]));
  const baseComments = new Map(base?.comments.map(comment => [comment.id, comment]));
  const hasLoadBase = base?.rows.some(row => loadRow(row.id));
  const noted = new Set(mine.comments.filter(comment =>
    JSON.stringify(comment) !== JSON.stringify(baseComments.get(comment.id))).map(comment => comment.rowId));
  const retained = new Set(mine.rows.filter(row => !diskIds.has(row.id) &&
    (loadRow(row.id) || (!hasLoadBase && /^r[a-z0-9]{8,}$/.test(row.id))) &&
    (!rowContentEqual(baseRows.get(row.id), row) || noted.has(row.id))).map(row => row.id));
  if (!retained.size) return { base, mine, disk };

  const preparedBase = base ? cloneState(base) : null;
  const preparedMine = cloneState(mine);
  const reserved = new Set<string>();
  for (const doc of [base, mine, disk]) {
    if (!doc) continue;
    for (const record of [...doc.people, ...doc.productionTags, ...doc.brollShots, ...(normalizeSections(doc.sections) || [])]) {
      if (record?.id) reserved.add(record.id);
    }
    for (const row of doc.rows) {
      reserved.add(row.id);
      for (const field of ["audioText", "visualText"] as const) {
        for (const run of decode(row[field] || "")) for (const id of run.marks.cmt || []) reserved.add(id);
      }
    }
    for (const comment of doc.comments) {
      reserved.add(comment.id);
      if (comment.anchorId) reserved.add(comment.anchorId);
      (comment.replies || []).forEach(reply => reserved.add(reply.id));
    }
  }
  const anchors = new Map<string, string>();
  function fresh(prefix: string, key: string): string {
    const wanted = prefix + "-recovery-" + sha256Hex(key).slice(0, 24);
    let id = wanted, suffix = 0;
    while (reserved.has(id)) id = wanted + "-" + (++suffix);
    reserved.add(id);
    return id;
  }
  function anchor(rowId: string, id: string): string {
    const key = rowId + "\u0000" + id;
    let value = anchors.get(key);
    if (!value) { value = fresh("a", key); anchors.set(key, value); }
    return value;
  }
  function remapRows(doc: ValidatedDocument): void {
    for (const row of doc.rows) {
      if (!retained.has(row.id)) continue;
      for (const field of ["audioText", "visualText"] as const) {
        const cell = decode(row[field] || "");
        if (!cell.some(run => run.marks.cmt?.length)) continue;
        row[field] = toHtml(cell.map(run => ({ ...run, marks: { ...run.marks,
          ...(run.marks.cmt ? { cmt: run.marks.cmt.map(id => anchor(row.id, id)) } : {}) } })));
      }
    }
  }
  // why: Retained scene copies need separate marks, or first-mark reconciliation moves the other copy's comments.
  remapRows(preparedMine);
  if (preparedBase) remapRows(preparedBase);
  const diskComments = new Set(disk.comments.map(comment => comment.id));
  for (const comment of preparedMine.comments) {
    if (!comment.rowId || !retained.has(comment.rowId)) continue;
    const oldId = comment.id;
    comment.anchorId = anchor(comment.rowId, comment.anchorId || oldId);
    if (diskComments.has(oldId)) comment.id = fresh("c", comment.rowId + "\u0000" + oldId);
  }
  if (preparedBase) {
    preparedBase.rows = preparedBase.rows.filter(row => !noted.has(row.id) || !retained.has(row.id));
    preparedBase.comments = preparedBase.comments.filter(comment => !comment.rowId || !retained.has(comment.rowId));
  }
  return { base: preparedBase, mine: preparedMine, disk };
}
