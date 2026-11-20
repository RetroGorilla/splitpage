import * as Y from "yjs";
import { normalizeBrollProps } from "../../../core/document/broll.ts";
import { noFreeze } from "../../../core/document/freeze.ts";
import { ensureTagIds, registryKey } from "../../../core/document/tags.ts";
import type { DocumentShape } from "../../../core/document/validated.ts";
import { applyBrollRecords, planBrollRecordsInState } from "../../../core/production/broll.ts";
import type { FieldHtml } from "../../../core/production/ports.ts";
import { createProductionReaders } from "../../../core/production/readers.ts";
import { missingRegistryTags } from "../../../core/production/tags.ts";
import { toPlainText } from "../../../core/text/projections.ts";
import type { Run } from "../../../core/text/runs.ts";
import type { NativeRoots } from "./roots.ts";

interface RegistryCellRow {
  readonly id: string;
  readonly audioText: string;
  readonly visualText: string;
  readonly narration: readonly Run[];
  readonly visual: readonly Run[];
}

function production(rows: readonly RegistryCellRow[]) {
  const cells = new Map<string, readonly Run[]>();
  for (const row of rows) {
    cells.set(row.audioText, row.narration);
    cells.set(row.visualText, row.visual);
  }
  const cellOf = (html: FieldHtml): readonly Run[] => cells.get(html ?? "") ?? [];
  return { readers: createProductionReaders(cellOf, noFreeze), plainTextOf: (html: FieldHtml) => toPlainText(cellOf(html)) };
}

export function nativeTagNamesInRows(rows: readonly RegistryCellRow[]): ReadonlySet<string> {
  const { readers } = production(rows);
  return new Set(missingRegistryTags(rows, [], readers).map(tag => registryKey(tag.cat, tag.name)));
}

export function nativeShotLinePlan(document: DocumentShape, rows: readonly RegistryCellRow[]) {
  const { readers, plainTextOf } = production(rows);
  return planBrollRecordsInState(document, readers, { id: () => "", docId: () => document.docId }, plainTextOf, () => false);
}

function hasRemoved(root: Y.Map<Y.Map<unknown>>): boolean {
  for (const record of root.values()) if (record instanceof Y.Map && record.get("removed") === true) return true;
  return false;
}

export function projectNativeRegistries(document: DocumentShape, roots: NativeRoots, rows: () => readonly RegistryCellRow[]): void {
  const tagsRemoved = hasRemoved(roots.tags), shotsRemoved = hasRemoved(roots.shots);
  if (tagsRemoved || shotsRemoved) {
    const visible = rows();
    if (tagsRemoved) {
      const { readers } = production(visible);
      document.productionTags.push(...missingRegistryTags(document.rows, document.productionTags, readers));
      ensureTagIds(document.productionTags);
    }
    // why: a surviving keyed line seeds its default shot on core reload; unkeyed lines have their own command path
    if (shotsRemoved) applyBrollRecords(document.brollShots, nativeShotLinePlan(document, visible));
  }
  const people = new Set(document.people.map(person => person.id));
  for (const record of [...document.productionTags, ...document.brollShots]) {
    if (record?.owner && !people.has(record.owner)) record.owner = "";
  }
  for (const shot of document.brollShots) if (shot.props?.length) {
    shot.props = normalizeBrollProps(shot.props, document.productionTags);
  }
}
