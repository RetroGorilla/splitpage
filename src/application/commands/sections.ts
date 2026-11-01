import { cappedText } from "../../core/document/text-policy.ts";
import { sectionGroups, sectionsInOrder, writeSections } from "../../core/document/sections.ts";
import type { DocumentSection } from "../../core/document/sections.ts";
import { changeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";

function sectionEdit(name: string, update: (doc: DocumentView) => readonly DocumentSection[] | null): Command {
  return {
    name, needs: "edit",
    plan(doc): Plan | null {
      const next = update(doc);
      if (next === null || JSON.stringify(next) === JSON.stringify(sectionsInOrder(doc) ?? [])) return null;
      return {
        changes: changeSet({ docFields: ["sections"], derive: CELL_TEXT_DERIVES, saveNow: true }),
        apply(live) { writeSections(live, next); }
      };
    }
  };
}

export function addSectionCommand(firstSceneId: string, id: string, name: string): Command {
  return sectionEdit("add-section", doc => {
    const sections = sectionsInOrder(doc) ?? [];
    const clean = cappedText(name, 200);
    if (!clean || !/^[A-Za-z0-9_-]+$/.test(id) || !doc.rows.some(row => row.id === firstSceneId) ||
      sections.some(section => section.id === id || section.firstSceneId === firstSceneId)) return null;
    return sectionsInOrder({ rows: doc.rows, sections: [...sections, { id, name: clean, firstSceneId }] }) ?? [];
  });
}

export function renameSectionCommand(id: string, name: string): Command {
  return sectionEdit("rename-section", doc => {
    const clean = cappedText(name, 200);
    if (!clean) return null;
    return (sectionsInOrder(doc) ?? []).map(section => section.id === id ? { ...section, name: clean } : section);
  });
}

export function removeSectionCommand(id: string): Command {
  return sectionEdit("remove-section", doc => (sectionsInOrder(doc) ?? []).filter(section => section.id !== id));
}

export function moveSectionCommand(id: string, targetId: string, after: boolean): Command {
  return {
    name: "move-section", needs: "edit",
    plan(doc): Plan | null {
      const groups = sectionGroups(doc);
      const moving = groups.find(group => group.section.id === id);
      const target = groups.find(group => group.section.id === targetId);
      if (!moving || !target || moving === target) return null;
      const movedIds = doc.rows.slice(moving.start, moving.end).map(row => row.id);
      const movingSet = new Set(movedIds);
      const remaining = doc.rows.filter(row => !movingSet.has(row.id)).map(row => row.id);
      const anchor = doc.rows[after ? target.end - 1 : target.start]?.id;
      if (!anchor) return null;
      const at = remaining.indexOf(anchor) + (after ? 1 : 0);
      remaining.splice(at, 0, ...movedIds);
      if (remaining.every((rowId, i) => rowId === doc.rows[i]?.id)) return null;
      return {
        changes: changeSet({ rowsMoved: true, docFields: ["sections"], derive: CELL_TEXT_DERIVES, saveNow: true }),
        apply(live) {
          const byId = new Map(live.rows.map(row => [row.id, row]));
          live.rows.splice(0, live.rows.length, ...remaining.map(rowId => {
            const row = byId.get(rowId);
            if (!row) throw new Error("scene left the section before it was moved");
            return row;
          }));
          writeSections(live, sectionsInOrder(live));
        }
      };
    }
  };
}
