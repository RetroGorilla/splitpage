import type { DocumentRow } from "../../core/document/validated.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";

export const ROW_ORDER_DERIVES: readonly string[] = CELL_TEXT_DERIVES;

function indexOf(rows: DocumentView["rows"], rowId: string): number {
  return rows.findIndex(function (r) { return r.id === rowId; });
}

function liveIndex(rows: DocumentRow[], rowId: string, doing: string): number {
  const at = rows.findIndex(function (r) { return r.id === rowId; });
  if (at === -1) throw new Error("scene " + rowId + " left the document before it was " + doing);
  return at;
}

const REORDERED: ChangeSet = changeSet({ rowsMoved: true, derive: ROW_ORDER_DERIVES, saveNow: true });

export function addSceneCommand(afterId: string | null, createdId: string, ports: StampPorts): Command {
  return {
    name: "add-scene",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (afterId !== null && indexOf(doc.rows, afterId) === -1) return null;
      return {
        changes: changeSet({ rowsInserted: [createdId] }),
        apply: function (live) {
          const created: DocumentRow = {
            id: createdId, visualText: "", imageRef: null, audioText: "",
            status: "todo", updatedAt: ports.clock.nowIso(), updatedBy: ports.editor.name()
          };
          if (afterId === null) live.rows.push(created);
          else live.rows.splice(liveIndex(live.rows, afterId, "given a scene below it") + 1, 0, created);
        }
      };
    }
  };
}

export function deleteSceneCommand(rowId: string): Command {
  return {
    name: "delete-scene",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (indexOf(doc.rows, rowId) === -1) return null;
      return {
        changes: changeSet({ rowsRemoved: [rowId], derive: CELL_TEXT_DERIVES }),
        apply: function (live) {
          live.rows.splice(liveIndex(live.rows, rowId, "deleted"), 1);
        }
      };
    }
  };
}

function orderAfterMove(ids: readonly string[], rowId: string, targetId: string, after: boolean): string[] {
  const rest = ids.filter(function (id) { return id !== rowId; });
  const dest = rest.indexOf(targetId);
  rest.splice(after ? dest + 1 : dest, 0, rowId);
  return rest;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(function (id, i) { return id === b[i]; });
}

function reorderTo(live: DocumentRow[], order: readonly string[]): void {
  const byId = new Map(live.map(function (r) { return [r.id, r]; }));
  const next = order.map(function (id) {
    const row = byId.get(id);
    if (!row) throw new Error("scene " + id + " left the document before the scenes were reordered");
    return row;
  });
  if (next.length !== live.length) throw new Error("the scenes changed before they were reordered");
  live.splice(0, live.length, ...next);
}

function idsOf(doc: DocumentView): string[] {
  return doc.rows.map(function (r) { return r.id; });
}

export function moveSceneCommand(rowId: string, targetId: string, after: boolean): Command {
  return {
    name: "move-scene",
    needs: "edit",
    plan: function (doc): Plan | null {
      const from = indexOf(doc.rows, rowId), to = indexOf(doc.rows, targetId);
      if (from === -1 || to === -1 || from === to) return null;
      const ids = idsOf(doc);
      const order = orderAfterMove(ids, rowId, targetId, after);
      if (sameOrder(ids, order)) return null;
      return {
        changes: REORDERED,
        apply: function (live) { reorderTo(live.rows, order); }
      };
    }
  };
}

export function swapScenesCommand(rowId: string, dir: -1 | 1): Command {
  return {
    name: "swap-scenes",
    needs: "edit",
    plan: function (doc): Plan | null {
      const at = indexOf(doc.rows, rowId);
      const other = at + dir;
      if (at === -1 || other < 0 || other >= doc.rows.length) return null;
      const order = idsOf(doc);
      const moving = order[at] as string;
      order[at] = order[other] as string;
      order[other] = moving;
      return {
        changes: REORDERED,
        apply: function (live) { reorderTo(live.rows, order); }
      };
    }
  };
}
