import { sceneFirstBeatId, scenesInOrder } from "../../core/document/scenes.ts";
import type { DocumentScene } from "../../core/document/scenes.ts";
import type { DocumentRow } from "../../core/document/validated.ts";
import type { DocumentView } from "../session/document-session.ts";

export interface ParagraphFlagChange {
  readonly rowId: string;
  readonly start: boolean;
}

export function paragraphMembership(doc: DocumentView): Map<string, string> {
  const anchors = new Set(scenesInOrder(doc)?.map(sceneFirstBeatId));
  const membership = new Map<string, string>();
  let first = "";
  doc.rows.forEach((row, at) => {
    if (at === 0 || row.paragraphStart === true || anchors.has(row.id)) first = row.id;
    membership.set(row.id, first);
  });
  return membership;
}

export function paragraphFlagsAfterOrder(
  doc: DocumentView, order: readonly string[], scenes: readonly DocumentScene[] | undefined, moved?: string
): ParagraphFlagChange[] {
  const membership = paragraphMembership(doc);
  const anchors = new Set(scenes?.map(sceneFirstBeatId));
  const byId = new Map(doc.rows.map(row => [row.id, row]));
  if (moved) {
    const at = order.indexOf(moved);
    const before = membership.get(order[at - 1] ?? ""), after = membership.get(order[at + 1] ?? "");
    if (before && before === after && !anchors.has(moved)) membership.set(moved, before);
  }
  return order.flatMap((rowId, at) => {
    const row = byId.get(rowId);
    if (!row) return [];
    const implicit = at === 0 || anchors.has(rowId);
    const start = membership.get(rowId) !== membership.get(order[at - 1] ?? "");
    const flag = implicit ? row.paragraphStart === true : start;
    return flag === (row.paragraphStart === true) ? [] : [{ rowId, start: flag }];
  });
}

export function paragraphCells(changes: readonly ParagraphFlagChange[]) {
  return changes.map(({ rowId }) => ({ rowId, field: "paragraphStart" }));
}

export function applyParagraphFlags(rows: DocumentRow[], changes: readonly ParagraphFlagChange[]): void {
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const change of changes) {
    const row = byId.get(change.rowId);
    if (!row) throw new Error("beat " + change.rowId + " left the paragraph before it was updated");
    if (change.start) row.paragraphStart = true;
    else delete row.paragraphStart;
  }
}
