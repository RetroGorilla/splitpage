import type { SharedContentRef, SharedJsonFields, SharedRecordCreate } from "./operations.ts";
import { normalizeTagName, registryKey } from "../document/tags.ts";
import type { IdSource } from "../document/ports.ts";
import { planOwnerSync, snapshotOwners } from "../production/owners.ts";
import type { OwnerState } from "../production/owners.ts";
import { addPerson, peopleOf } from "../production/records.ts";
import type { LiveRecords } from "../production/records.ts";
import { missingRegistryTags, newRegistryTag } from "../production/tags.ts";
import type { RegistryList } from "../production/tags.ts";
import type { FieldHtml, ProductionReaders } from "../production/ports.ts";

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

export interface SharedPeopleCellEdit {
  readonly rowId: string;
  readonly before: FieldHtml;
  readonly after: FieldHtml;
  readonly state: OwnerState;
}

// why: an @Name new to the script gets a person from the copy whose edit typed it, as a normal script does on commit;
// a person made only so a pairing can name a tag's owner is left to the owner rule.
export function sharedPeopleIntroducedByText(
  edit: SharedPeopleCellEdit,
  readers: Pick<ProductionReaders, "whoInField">,
  ids: IdSource,
  author: { readonly id: string; readonly by: string }
): readonly SharedRecordCreate[] {
  const withCell = (cell: FieldHtml): OwnerState => ({ ...edit.state,
    rows: edit.state.rows.map(row => row.id === edit.rowId ? { ...row, visualText: cell } : row) });
  const was = snapshotOwners(withCell(edit.before), readers), now = withCell(edit.after);
  const plan = planOwnerSync(was, now, readers, { rows: now.rows.filter(row => row.id === edit.rowId), removed: [] });
  const live: LiveRecords = { productionTags: [], brollShots: [], people: peopleOf(edit.state).slice() };
  const created: SharedRecordCreate[] = [];
  for (const name of plan.people) {
    if (was.names.has(normalizeTagName(name))) continue;
    const count = peopleOf(live).length;
    addPerson(live, name, ids);
    const person = peopleOf(live)[count];
    if (!person) continue;
    created.push({ kind: "record-create", id: (author.id + ":person:" + created.length) as SharedContentRef, by: author.by,
      target: { collection: "people", record: person.id as SharedContentRef }, fields: { name: person.name } });
  }
  return created;
}
