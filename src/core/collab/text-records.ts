import type { SharedContentRef, SharedJsonFields, SharedRecordCreate } from "./operations.ts";
import { registryKey } from "../document/tags.ts";
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
