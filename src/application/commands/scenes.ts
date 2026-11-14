import { cappedText } from "../../core/document/text-policy.ts";
import { newScene, sceneFirstBeatId, sceneGroups, scenesInOrder, writeScenes } from "../../core/document/scenes.ts";
import type { DocumentScene } from "../../core/document/scenes.ts";
import { changeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";
import { flowIdentity } from "../../core/flow/operations.ts";
import { sharedParagraphFlags, sharedStructureList, sharedStructureTrace } from "./shared-structure.ts";
import type { SharedStructurePorts } from "./shared-structure.ts";

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

export function addSceneCommand(firstBeatId: string, id: string, name: string): Command {
  return sceneEdit("add-section", doc => {
    const scenes = scenesInOrder(doc) ?? [];
    const clean = cappedText(name, 200);
    if (!clean || !/^[A-Za-z0-9_-]+$/.test(id) || !doc.rows.some(row => row.id === firstBeatId) ||
      scenes.some(scene => scene.id === id || sceneFirstBeatId(scene) === firstBeatId)) return null;
    return scenesInOrder({ rows: doc.rows, sections: [...scenes, newScene(id, clean, firstBeatId)] }) ?? [];
  });
}

export function renameSceneCommand(id: string, name: string): Command {
  return sceneEdit("rename-section", doc => {
    const clean = cappedText(name, 200);
    if (!clean) return null;
    return (scenesInOrder(doc) ?? []).map(scene => scene.id === id ? { ...scene, name: clean } : scene);
  });
}

function sharedHeadingRemoval(doc: DocumentView, scene: DocumentScene, flagged: boolean, shared: SharedStructurePorts | undefined): Pick<Plan, "shared"> {
  const by = shared?.author();
  if (!shared || !by) return {};
  const trace = sharedStructureTrace(doc, shared, by), first = sceneFirstBeatId(scene);
  trace.emit({ kind: "heading-remove", heading: flowIdentity(scene.id), observed: trace.span(scene.id, 0, scene.name.length, "heading"),
    newBeat: null, nextBeat: flowIdentity(first) });
  sharedParagraphFlags(trace, flagged ? [] : [{ rowId: first, start: true }]);
  return { shared: sharedStructureList(trace, shared, by, []) };
}

export function removeSceneCommand(id: string, shared?: SharedStructurePorts): Command {
  return {
    name: "remove-section", needs: "edit",
    plan(doc): Plan | null {
      const scenes = scenesInOrder(doc);
      const scene = scenes?.find(item => item.id === id);
      if (!scene) return null;
      const rowId = sceneFirstBeatId(scene);
      const flagged = doc.rows.find(row => row.id === rowId)?.paragraphStart === true;
      const changes = flagged ? [] : [{ rowId, field: "paragraphStart" }];
      return {
        ...sharedHeadingRemoval(doc, scene, flagged, shared),
        changes: changeSet({ cells: changes, docFields: ["sections"], derive: CELL_TEXT_DERIVES, saveNow: true }),
        apply(live) {
          const first = live.rows.find(row => row.id === rowId);
          if (!first) throw new Error("scene's first beat left before its header was removed");
          first.paragraphStart = true;
          writeScenes(live, scenes?.filter(item => item.id !== id));
        }
      };
    }
  };
}

export function moveSceneCommand(id: string, targetId: string, after: boolean): Command {
  return {
    name: "move-section", needs: "edit",
    plan(doc, capability) {
      const can = capability.moves();
      if (!can.allowed) return { refused: can.reason };
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
