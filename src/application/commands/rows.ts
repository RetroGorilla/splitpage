import type { DocumentRow } from "../../core/document/validated.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";
import { toPlainText } from "../../core/text/projections.ts";
import type { TextServices } from "../text/services.ts";
import { sectionsAfterRemoval, sectionsInOrder, writeSections } from "../../core/document/sections.ts";

function indexOf(rows: DocumentView["rows"], rowId: string): number {
  return rows.findIndex(function (r) { return r.id === rowId; });
}

function liveIndex(rows: DocumentRow[], rowId: string, doing: string): number {
  const at = rows.findIndex(function (r) { return r.id === rowId; });
  if (at === -1) throw new Error("scene " + rowId + " left the document before it was " + doing);
  return at;
}

function reorderedChange(sections = false): ChangeSet {
  return changeSet({ rowsMoved: true, docFields: sections ? ["sections"] : [], derive: CELL_TEXT_DERIVES, saveNow: true });
}

export function addBeatCommand(afterId: string | null, createdId: string, ports: StampPorts): Command {
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

export function deleteBeatCommand(rowId: string): Command {
  return {
    name: "delete-scene",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (indexOf(doc.rows, rowId) === -1) return null;
      const hadSections = !!sectionsInOrder(doc);
      const sections = sectionsAfterRemoval(doc, new Set([rowId]));
      return {
        changes: changeSet({ rowsRemoved: [rowId], docFields: hadSections ? ["sections"] : [], derive: CELL_TEXT_DERIVES }),
        apply: function (live) {
          live.rows.splice(liveIndex(live.rows, rowId, "deleted"), 1);
          if (hadSections) writeSections(live, sections);
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

export function moveBeatCommand(rowId: string, targetId: string, after: boolean, intoSection?: string): Command {
  return {
    name: "move-scene",
    needs: "edit",
    plan: function (doc): Plan | null {
      const from = indexOf(doc.rows, rowId), to = indexOf(doc.rows, targetId);
      if (from === -1 || to === -1 || from === to) return null;
      const ids = idsOf(doc);
      const order = orderAfterMove(ids, rowId, targetId, after);
      const original = sectionsInOrder(doc);
      const sections = sectionsAfterRemoval(doc, new Set([rowId]))?.map(section =>
        section.id === intoSection ? { ...section, firstSceneId: rowId } : section);
      if (sameOrder(ids, order) && (!intoSection || JSON.stringify(sections) === JSON.stringify(original))) return null;
      return {
        changes: reorderedChange(!!original),
        apply: function (live) {
          reorderTo(live.rows, order);
          if (original) {
            writeSections(live, sections);
            writeSections(live, sectionsInOrder(live));
          }
        }
      };
    }
  };
}

export function swapBeatsCommand(rowId: string, dir: -1 | 1): Command {
  return {
    name: "swap-scenes",
    needs: "edit",
    plan: function (doc, capability) {
      const at = indexOf(doc.rows, rowId);
      const other = at + dir;
      if (at === -1 || other < 0 || other >= doc.rows.length) return null;
      return moveBeatCommand(rowId, (doc.rows[other] as DocumentView["rows"][number]).id, dir > 0).plan(doc, capability);
    }
  };
}

const NBSP = "\u00a0";

function hasItems(value: unknown): boolean {
  return !!value && !!(value as { readonly length?: unknown }).length;
}

export function isBlankBeat(
  doc: Pick<DocumentView, "comments">,
  row: DocumentView["rows"][number] | null | undefined,
  text: Pick<TextServices, "cellOf">
): boolean {
  if (!row) return false;
  const plainOf = (html: unknown): string => toPlainText(text.cellOf(html || "")).replaceAll(NBSP, " ");
  if (plainOf(row.visualText).trim() || plainOf(row.audioText).trim()) return false;
  if (row["imageRef"] || hasItems(row["moreImages"]) || hasItems(row["imageLinks"])) return false;
  if (typeof row["lengthSeconds"] === "number") return false;
  return !(doc.comments || []).some(function (c) { return c && c["rowId"] === row.id; });
}
