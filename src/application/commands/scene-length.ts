import { hasSetLength } from "../../core/document/timing.ts";
import type { LengthHolder } from "../../core/document/timing.ts";
import type { DocumentRow } from "../../core/document/validated.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DeepReadonly, DocumentView } from "../session/document-session.ts";
import type { Clock } from "../session/ports.ts";

export interface EditorPort {
  readonly name: () => string;
}

export interface StampPorts {
  readonly clock: Clock;
  readonly editor: EditorPort;
}

export interface SceneAt {
  readonly index: number;
  readonly row: DeepReadonly<DocumentRow>;
}

export const SCENE_LENGTH_DERIVES: readonly string[] = Object.freeze(["production", "broll"]);

function rowCopy(row: DeepReadonly<DocumentRow>): DeepReadonly<DocumentRow> {
  return Object.freeze(JSON.parse(JSON.stringify(row)) as DocumentRow);
}

function lengthChanges(rowId: string): ChangeSet {
  return changeSet({
    cells: [
      { rowId: rowId, field: "lengthSeconds" },
      { rowId: rowId, field: "updatedAt" },
      { rowId: rowId, field: "updatedBy" }
    ],
    derive: SCENE_LENGTH_DERIVES,
    saveNow: true
  });
}

export function sceneAt(rowId: string): (doc: DocumentView | null) => SceneAt | null {
  return function (doc) {
    if (!doc) return null;
    const index = doc.rows.findIndex(function (r) { return r.id === rowId; });
    const row = doc.rows[index];
    return row ? Object.freeze({ index: index, row: rowCopy(row) }) : null;
  };
}

export function sceneLengthCommand(rowId: string, seconds: number | null | undefined, stamps: StampPorts): Command {
  const after = seconds == null ? null : seconds;
  return {
    name: "set-scene-length",
    needs: "edit",
    plan: function (doc) {
      const row = doc.rows.find(function (r) { return r.id === rowId; });
      if (!row) return null;
      const held: LengthHolder = { lengthSeconds: row.lengthSeconds };
      const before = hasSetLength(held) ? held.lengthSeconds : null;
      if (before === after) return null;
      return {
        changes: lengthChanges(rowId),
        apply: function (live) {
          const target = live.rows.find(function (r) { return r.id === rowId; });
          if (!target) throw new Error("scene " + rowId + " left the document before its length was set");
          if (after === null) Reflect.deleteProperty(target, "lengthSeconds");
          else target.lengthSeconds = after;
          target.updatedAt = stamps.clock.nowIso();
          target.updatedBy = stamps.editor.name();
        }
      };
    }
  };
}
