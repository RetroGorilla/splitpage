import { newBrollShot } from "../../core/document/broll.ts";
import type { IdSource } from "../../core/document/ports.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { applyBrollRecords, brollInCell, brollSeedLocation, brollSeedRef, hasBrollRecordWork, planBrollRecords } from "../../core/production/broll.ts";
import type { UnkeyedScope } from "../../core/production/broll.ts";
import type { ProductionIndexOwner } from "../../core/production/index.ts";
import type { ProductionRow } from "../../core/production/ports.ts";
import { addBrollRecord, brollRecord } from "../../core/production/records.ts";
import type { Run } from "../../core/text/runs.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { RecordsPlan } from "../session/ports.ts";
import type { TextServices } from "../text/services.ts";

export type BrollText = Pick<TextServices, "htmlToPlainText" | "productionReaders">;

export interface BrollSeed {
  readonly audioRef: string;
  readonly location: string;
}

export function brollSeedOf(row: ProductionRow | null | undefined, text: BrollText): BrollSeed {
  return { audioRef: brollSeedRef(row, text.htmlToPlainText), location: brollSeedLocation(row, text.productionReaders) };
}

export function recordPastedBroll(doc: ValidatedDocument | null, rowId: string, cell: readonly Run[], ids: readonly string[] | null | undefined, text: BrollText, idSource: IdSource): void {
  if (!doc || !ids || !ids.length) return;
  const row = doc.rows[rowIndexOf(doc, rowId)] || null;
  brollInCell(cell).forEach(function (found) {
    if (!found.id || ids.indexOf(found.id) === -1 || brollRecord(doc, found.id)) return;
    addBrollRecord(doc, newBrollShot(idSource.id("bs"), {
      id: found.id, name: found.name, desc: found.desc,
      ...brollSeedOf(row, text)
    }));
  });
}

export interface RecordsReconcilerPorts {
  readonly held: () => ValidatedDocument | null;
  readonly viewed: () => ValidatedDocument | null;
  readonly production: Pick<ProductionIndexOwner, "recordsPlan">;
  readonly text: BrollText;
  readonly ids: IdSource;
}

export type RecordsReconciler = (doc: ValidatedDocument, changes: ChangeSet) => RecordsPlan | null;

function unkeyedScope(changes: ChangeSet): UnkeyedScope {
  if (changes.whole) return null;
  const inserted: Record<string, true> = Object.create(null);
  changes.rowsInserted.forEach(function (id) { inserted[id] = true; });
  return function (rowId) { return !!inserted[rowId]; };
}

export function createRecordsReconciler(ports: RecordsReconcilerPorts): RecordsReconciler {
  return function (doc, changes) {
    if (!doc || doc !== ports.held()) return null;
    const tags = ports.production.recordsPlan(doc, ports.viewed());
    const shots = planBrollRecords(doc, ports.text.productionReaders, ports.ids, ports.text.htmlToPlainText, unkeyedScope(changes));
    const fields: string[] = [];
    if (tags && tags.apply) fields.push("productionTags");
    if (hasBrollRecordWork(shots)) fields.push("brollShots");
    if (!fields.length && !tags) return null;
    return {
      fields: fields,
      apply: function (into) {
        if (tags && tags.apply) tags.apply(into);
        applyBrollRecords(into.brollShots, shots);
      },
      commit: tags ? tags.commit : undefined
    };
  };
}
