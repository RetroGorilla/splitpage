import { newBrollShot } from "../../core/document/broll.ts";
import type { IdSource } from "../../core/document/ports.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { applyBrollRecords, brollInCell, brollSeedLocation, brollSeedRef, hasBrollRecordWork, planBrollRecords } from "../../core/production/broll.ts";
import type { UnkeyedScope } from "../../core/production/broll.ts";
import type { ProductionIndexOwner } from "../../core/production/index.ts";
import { applyOwnerSync, planOwnerSync, snapshotOwners } from "../../core/production/owners.ts";
import type { OwnerEdits, OwnerSnapshot } from "../../core/production/owners.ts";
import type { ProductionRow } from "../../core/production/ports.ts";
import { addBrollRecord, brollRecord } from "../../core/production/records.ts";
import type { Run } from "../../core/text/runs.ts";
import type { BrollSeedPlace } from "../commands/clipboard.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { RecordsPlan } from "../session/ports.ts";
import type { StandaloneDocumentSession } from "../session/document-session.ts";
import type { TextServices } from "../text/services.ts";

export type BrollText = Pick<TextServices, "htmlToPlainText" | "productionReaders">;

export function brollSeedOf(row: ProductionRow | null | undefined, text: BrollText): BrollSeedPlace {
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
  readonly held: StandaloneDocumentSession["held"];
  readonly viewed: () => ValidatedDocument | null;
  readonly production: Pick<ProductionIndexOwner, "recordsPlan">;
  readonly text: BrollText;
  readonly ids: IdSource;
}

export type RecordsReconciler = {
  (doc: ValidatedDocument, changes: ChangeSet): RecordsPlan | null;
  readonly resync?: ((doc: ValidatedDocument | null, changes?: ChangeSet) => void) | undefined;
};

function unkeyedScope(changes: ChangeSet): UnkeyedScope {
  if (changes.whole) return null;
  const inserted: Record<string, true> = Object.create(null);
  changes.rowsInserted.forEach(function (id) { inserted[id] = true; });
  return function (rowId) { return !!inserted[rowId]; };
}

export function createRecordsReconciler(ports: RecordsReconcilerPorts): RecordsReconciler {
  let owners: OwnerSnapshot | null = null;
  let positions = new Map<string, number>();
  function indexed(doc: ValidatedDocument): Map<string, number> {
    return new Map(doc.rows.map(function (row, i) { return [row.id, i]; }));
  }
  function editsOf(doc: ValidatedDocument, changes: ChangeSet, index: ReadonlyMap<string, number>): OwnerEdits {
    const ids = new Set(changes.rowsInserted);
    changes.cells.forEach(function (cell) {
      if (cell.rowId && (!cell.field || cell.field === "visualText")) ids.add(cell.rowId);
    });
    const rows: ProductionRow[] = [];
    Array.from(ids).sort(function (a, b) { return (index.get(a) ?? -1) - (index.get(b) ?? -1); }).forEach(function (id) {
      const at = index.get(id), row = at === undefined ? undefined : doc.rows[at];
      if (row && row.id === id) rows.push(row);
    });
    return { rows: rows, removed: changes.rowsRemoved };
  }
  function reconcile(doc: ValidatedDocument, changes: ChangeSet): RecordsPlan | null {
    if (!doc || doc !== ports.held()) return null;
    const tags = ports.production.recordsPlan(doc, ports.viewed());
    const shots = planBrollRecords(doc, ports.text.productionReaders, ports.ids, ports.text.htmlToPlainText, unkeyedScope(changes));
    const index = changes.whole || changes.rowsMoved || changes.rowsInserted.length || changes.rowsRemoved.length ? indexed(doc) : positions;
    const who = planOwnerSync(owners, doc, ports.text.productionReaders, changes.whole ? undefined : editsOf(doc, changes, index));
    const fields: string[] = [];
    if (tags && tags.apply) fields.push("productionTags");
    if (hasBrollRecordWork(shots)) fields.push("brollShots");
    who.fields.forEach(function (f) { if (fields.indexOf(f) === -1) fields.push(f); });
    if (!fields.length && !tags) return null;
    return {
      fields: fields,
      apply: function (into) {
        if (tags && tags.apply) tags.apply(into);
        applyBrollRecords(into.brollShots, shots);
        applyOwnerSync(who, into, ports.ids);
      },
      commit: function () {
        if (tags) tags.commit();
        who.commit();
        owners = who.snapshot;
        positions = index;
      }
    };
  }
  return Object.assign(reconcile, {
    resync: function (doc: ValidatedDocument | null, changes?: ChangeSet) {
      if (!doc) { owners = null; positions.clear(); return; }
      if (!owners || owners.docId !== doc.docId || !changes || changes.whole) {
        owners = snapshotOwners(doc, ports.text.productionReaders);
        positions = indexed(doc);
        return;
      }
      if (changes.rowsMoved || changes.rowsInserted.length || changes.rowsRemoved.length) positions = indexed(doc);
      const who = planOwnerSync(owners, doc, ports.text.productionReaders, editsOf(doc, changes, positions));
      who.commit();
      owners = who.snapshot;
    }
  });
}
