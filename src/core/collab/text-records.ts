import type { SharedContentRef, SharedJsonFields, SharedRecordCreate } from "./operations.ts";
import { registryKey } from "../document/tags.ts";
import { missingRegistryTags, newRegistryTag } from "../production/tags.ts";
import type { RegistryList } from "../production/tags.ts";
import type { FieldHtml, FieldText, ProductionReaders } from "../production/ports.ts";
import { anchorBrollCell, brollAnchorTodo, planBrollAnchorsInState, planBrollRecordsInState } from "../production/broll.ts";
import type { BrollState } from "../production/broll.ts";
import type { IdSource } from "../document/ports.ts";
import { toHtml } from "../text/html.ts";
import type { Run } from "../text/runs.ts";

export interface SharedTextCellEdit {
  readonly field: "audioText" | "visualText";
  readonly before: FieldHtml;
  readonly after: FieldHtml;
  readonly registry: RegistryList;
}

export function sharedTagsIntroducedByText(
  edit: SharedTextCellEdit,
  readers: ProductionReaders,
  author: { readonly id: string; readonly by: string }
): readonly SharedRecordCreate[] {
  const missing = (html: FieldHtml) => missingRegistryTags([{ id: "", [edit.field]: html }], edit.registry, readers);
  const had = new Set(missing(edit.before).map(tag => registryKey(tag.cat, tag.name)));
  const work = edit.registry.slice(), created: SharedRecordCreate[] = [];
  for (const tag of missing(edit.after)) {
    if (had.has(registryKey(tag.cat, tag.name))) continue;
    const entry = newRegistryTag(work, tag.cat, tag.name);
    if (!entry) continue;
    work.push(entry);
    const fields: SharedJsonFields = { cat: entry.cat, name: entry.name, status: entry.status };
    created.push({ kind: "record-create", id: (author.id + ":tag:" + created.length) as SharedContentRef, by: author.by,
      target: { collection: "tags", record: entry.id as SharedContentRef }, fields });
  }
  return created;
}

export interface SharedBrollCellEdit {
  readonly rowId: string;
  readonly before: FieldHtml;
  readonly after: readonly Run[];
  readonly state: BrollState;
}

export interface SharedBrollIntroduced {
  readonly cell: readonly Run[];
  readonly keyed: number;
  readonly records: readonly SharedRecordCreate[];
}

// why: a B-roll line is keyed and given a shot by the copy whose edit holds it, as a normal script does on commit;
// a key the cell already held is left to the copy that brought it.
export function sharedBrollIntroducedByText(
  edit: SharedBrollCellEdit,
  readers: ProductionReaders,
  ids: IdSource,
  plainTextOf: FieldText,
  author: { readonly id: string; readonly by: string }
): SharedBrollIntroduced {
  const withCell = (cell: readonly Run[]): BrollState => ({ ...edit.state,
    rows: edit.state.rows.map(row => row.id === edit.rowId ? { ...row, visualText: toHtml(cell) } : row) });
  const anchored = anchorBrollCell(edit.after, brollAnchorTodo(edit.after, edit.rowId, planBrollAnchorsInState(withCell(edit.after), readers, ids)));
  const had = new Set(readers.brollInField(edit.before).map(found => found.id));
  const held = new Set(readers.brollInField(toHtml(anchored.cell)).map(found => found.id));
  const shots = planBrollRecordsInState(withCell(anchored.cell), readers, ids, plainTextOf, rowId => rowId === edit.rowId).create
    .filter(shot => held.has(shot.id) && !had.has(shot.id));
  return { cell: anchored.cell, keyed: anchored.anchored, records: shots.map(({ id, ...fields }, index) => ({ kind: "record-create" as const,
    id: (author.id + ":shot:" + index) as SharedContentRef, by: author.by, target: { collection: "shots" as const, record: id as SharedContentRef },
    fields: JSON.parse(JSON.stringify(fields)) as SharedJsonFields })) };
}
