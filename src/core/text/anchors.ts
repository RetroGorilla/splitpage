import { commentIds } from "./runs.ts";
import type { CellDecoder } from "./ports.ts";

export type AnchorRow = { id?: unknown; visualText?: unknown; audioText?: unknown };

export type AnchoredComment = { kind?: unknown; field?: unknown; anchorId?: unknown; id?: unknown; rowId?: unknown };

export type AnchorState = {
  comments?: (AnchoredComment | null | undefined)[] | null | undefined;
  rows?: readonly (AnchorRow | null | undefined)[] | null | undefined;
};

type AnchorPlace = { rowId: unknown; field: "visualText" | "audioText" };

export function syncCommentAnchors(state: AnchorState | null | undefined, cellOf: CellDecoder): number {
  const comments = state && state.comments;
  if (!Array.isArray(comments) || !comments.length) return 0;
  const where: Record<string, AnchorPlace> = Object.create(null);
  ((state as AnchorState).rows || []).forEach(function (row) {
    if (!row) return;
    (["visualText", "audioText"] as const).forEach(function (field) {
      const html = row[field];
      if (typeof html !== "string" || html.indexOf("cmt-anchor") === -1) return;
      commentIds(cellOf(html)).forEach(function (id) {
        if (!where[id]) where[id] = { rowId: row.id, field: field };
      });
    });
  });
  let moved = 0;
  comments.forEach(function (c) {
    if (!c || typeof c !== "object" || c.kind === "conflict" || c.field === "title") return;
    const at = where[(c.anchorId || c.id) as string];
    if (!at || (c.rowId === at.rowId && c.field === at.field)) return;
    c.rowId = at.rowId;
    c.field = at.field;
    moved++;
  });
  return moved;
}
