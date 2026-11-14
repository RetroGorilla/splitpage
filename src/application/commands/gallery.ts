import type { DocumentRow } from "../../core/document/validated.ts";
import type { SharedContentRef, SharedOperation } from "../../core/collab/operations.ts";
import { sharedGalleryOperations } from "../../core/collab/gallery-operations.ts";
import type { SharedPictureRecord } from "../../core/collab/gallery-operations.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DeepReadonly, Plan } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";

export type GalleryEdit = (row: DocumentRow) => unknown;

export interface SharedGalleryPorts {
  readonly author: () => { readonly id: string; readonly by: string } | null;
  readonly pictures: (beat: string) => readonly SharedPictureRecord[];
  readonly beatStamp: (beat: SharedContentRef, author: { readonly id: string; readonly by: string }) => SharedOperation;
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

export function galleryCommand(rowId: string, edit: GalleryEdit, stamps: StampPorts, shared?: SharedGalleryPorts): Command {
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
      const plan = galleryPlan(rowId, draft, fields, stamps);
      const author = shared ? shared.author() : null;
      if (!shared || !author) return plan;
      const result = sharedGalleryOperations({ beat: rowId, before: row, after: draft, records: shared.pictures(rowId), author });
      if ("refused" in result) return { refused: result.refused };
      return { ...plan, shared: { operations: [...result.operations, shared.beatStamp(rowId as SharedContentRef, { id: author.id + "_stamp_0", by: author.by })] } };
    }
  };
}
