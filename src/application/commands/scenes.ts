import { cappedText } from "../../core/document/text-policy.ts";
import { sceneGroups, scenesInOrder, writeScenes } from "../../core/document/scenes.ts";
import type { DocumentScene } from "../../core/document/scenes.ts";
import { changeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";

function sceneEdit(name: string, update: (doc: DocumentView) => readonly DocumentScene[] | null): Command {
  return {
    name, needs: "edit",
    plan(doc): Plan | null {
      const next = update(doc);
      if (next === null || JSON.stringify(next) === JSON.stringify(scenesInOrder(doc) ?? [])) return null;
      return {
        changes: changeSet({ docFields: ["sections"], derive: CELL_TEXT_DERIVES, saveNow: true }),
        apply(live) { writeScenes(live, next); }
      };
    }
  };
}

export function addSceneCommand(firstSceneId: string, id: string, name: string): Command {
  return sceneEdit("add-section", doc => {
    const scenes = scenesInOrder(doc) ?? [];
    const clean = cappedText(name, 200);
    if (!clean || !/^[A-Za-z0-9_-]+$/.test(id) || !doc.rows.some(row => row.id === firstSceneId) ||
      scenes.some(scene => scene.id === id || scene.firstSceneId === firstSceneId)) return null;
    return scenesInOrder({ rows: doc.rows, sections: [...scenes, { id, name: clean, firstSceneId }] }) ?? [];
  });
}

export function renameSceneCommand(id: string, name: string): Command {
  return sceneEdit("rename-section", doc => {
    const clean = cappedText(name, 200);
    if (!clean) return null;
    return (scenesInOrder(doc) ?? []).map(scene => scene.id === id ? { ...scene, name: clean } : scene);
  });
}

export function removeSceneCommand(id: string): Command {
  return sceneEdit("remove-section", doc => (scenesInOrder(doc) ?? []).filter(scene => scene.id !== id));
}

export function moveSceneCommand(id: string, targetId: string, after: boolean): Command {
  return {
    name: "move-section", needs: "edit",
    plan(doc): Plan | null {
      const groups = sceneGroups(doc);
      const moving = groups.find(group => group.scene.id === id);
      const target = groups.find(group => group.scene.id === targetId);
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
          writeScenes(live, scenesInOrder(live));
        }
      };
    }
  };
}
