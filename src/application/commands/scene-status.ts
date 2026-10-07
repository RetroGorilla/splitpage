import { nextRowStatus } from "../../core/document/timing.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DocumentView } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";

export type ShotGrace = "arm" | "clear" | null;

export const SCENE_STATUS_DERIVES: readonly string[] = Object.freeze(["production"]);

function statusChanges(rowId: string): ChangeSet {
  return changeSet({
    cells: [
      { rowId: rowId, field: "status" },
      { rowId: rowId, field: "updatedAt" },
      { rowId: rowId, field: "updatedBy" }
    ],
    derive: SCENE_STATUS_DERIVES,
    saveNow: true
  });
}

export function sceneStatus(rowId: string): (doc: DocumentView | null) => unknown {
  return function (doc) {
    if (!doc) return undefined;
    const row = doc.rows.find(function (r) { return r.id === rowId; });
    return row ? row.status : undefined;
  };
}

export function shotGrace(before: unknown, after: unknown): ShotGrace {
  if (before !== "shot" && after === "shot") return "arm";
  if (before === "shot" && after !== "shot") return "clear";
  return null;
}

export function sceneStatusCommand(rowId: string, stamps: StampPorts): Command {
  return {
    name: "cycle-scene-status",
    needs: "edit",
    plan: function (doc) {
      const row = doc.rows.find(function (r) { return r.id === rowId; });
      if (!row) return null;
      const after = nextRowStatus(row.status);
      return {
        changes: statusChanges(rowId),
        apply: function (live) {
          const target = live.rows.find(function (r) { return r.id === rowId; });
          if (!target) throw new Error("scene " + rowId + " left the document before its status was set");
          target.status = after;
          target.updatedAt = stamps.clock.nowIso();
          target.updatedBy = stamps.editor.name();
        }
      };
    }
  };
}
