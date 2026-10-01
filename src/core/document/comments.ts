import { normalizeTagName } from "./tags.ts";

export interface FilterableComment {
  resolved?: unknown;
  assignee?: string | null | undefined;
}

export interface PlacedComment {
  rowId?: string | null | undefined;
  field?: string | null | undefined;
  createdAt?: string | null | undefined;
}

export interface CommentReplyTime {
  createdAt?: string | null | undefined;
}

export interface ActiveComment {
  createdAt?: string | null | undefined;
  replies?: readonly CommentReplyTime[] | null | undefined;
}

export function commentMatchesFilterMode(c: FilterableComment, mode: unknown): boolean {
  if (mode === "resolved") return !!c.resolved;
  if (mode === "all") return true;
  return !c.resolved;
}

export function commentMatchesAssigneeFilter(c: FilterableComment, assignee: string | null | undefined, myName: () => string): boolean {
  if (!assignee) return true;
  if (assignee === "__unassigned__") return !c.assignee;
  if (assignee === "me") {
    const me = normalizeTagName(myName());
    return !!me && normalizeTagName(c.assignee || "") === me;
  }
  return normalizeTagName(c.assignee || "") === normalizeTagName(assignee);
}

export function compareCommentPositions(a: PlacedComment, b: PlacedComment, rowIndex: (rowId: string | null | undefined) => number): number {
  let ai = rowIndex(a.rowId); if (ai === -1) ai = Infinity;
  let bi = rowIndex(b.rowId); if (bi === -1) bi = Infinity;
  if (ai !== bi) return ai - bi;
  const af = a.field === "audioText" ? 1 : 0, bf = b.field === "audioText" ? 1 : 0;
  if (af !== bf) return af - bf;
  return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}

export function commentLastActivity(c: ActiveComment): string {
  let t = c.createdAt || "";
  (c.replies || []).forEach(function (r) {
    if ((r.createdAt || "") > t) t = r.createdAt as string;
  });
  return t;
}

export function commentRecentOrder(a: ActiveComment, b: ActiveComment): number {
  return commentLastActivity(b).localeCompare(commentLastActivity(a));
}
