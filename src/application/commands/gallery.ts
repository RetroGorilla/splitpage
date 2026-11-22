import type { DocumentRow } from "../../core/document/validated.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DeepReadonly, Plan } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";
import type { RecordCommandRun } from "./shared-records.ts";

export type GalleryEdit = (row: DocumentRow) => unknown;

export interface SharedGalleryCommands {
  readonly editNative?: (rowId: string, message: string, edit: GalleryEdit) => RecordCommandRun | null;
}

const STAMPS: readonly string[] = Object.freeze(["updatedAt", "updatedBy"]);

function copyOf<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedFields(before: DeepReadonly<DocumentRow>, after: DocumentRow): string[] {
  const keys = Object.keys(before).concat(Object.keys(after)).filter(function (k, i, all) {
    return all.indexOf(k) === i && STAMPS.indexOf(k) === -1 && k !== "id";
  });
  return keys.filter(function (k) { return !same(before[k], after[k]); }).sort();
}

function galleryChanges(rowId: string, fields: readonly string[]): ChangeSet {
  return changeSet({
    cells: fields.concat(STAMPS).map(function (field) { return { rowId: rowId, field: field }; })
  });
}

function galleryPlan(rowId: string, draft: DocumentRow, fields: readonly string[], stamps: StampPorts): Plan {
  return {
    changes: galleryChanges(rowId, fields),
    apply: function (live) {
      const target = live.rows.find(function (r) { return r.id === rowId; });
      if (!target) throw new Error("scene " + rowId + " left the document before its gallery changed");
      fields.forEach(function (field) {
        if (draft[field] === undefined) Reflect.deleteProperty(target, field);
        else target[field] = copyOf(draft[field]);
      });
      target.updatedAt = stamps.clock.nowIso();
      target.updatedBy = stamps.editor.name();
    }
  };
}

export function galleryCommand(rowId: string, edit: GalleryEdit, stamps: StampPorts): Command {
  return {
    name: "gallery-edit",
    needs: "edit",
    plan: function (doc) {
      const row = doc.rows.find(function (r) { return r.id === rowId; });
      if (!row) return null;
      const draft = copyOf(row) as DocumentRow;
      if (!edit(draft)) return null;
      const fields = changedFields(row, draft);
      if (!fields.length) return null;
      return galleryPlan(rowId, draft, fields, stamps);
    }
  };
}
