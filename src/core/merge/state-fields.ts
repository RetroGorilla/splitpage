import { STATE_FIELDS as FIELD_POLICIES, missingStateFields as missingFieldsIn } from "../document/fields.ts";
import type { StateField } from "../document/fields.ts";
import { idMap } from "../document/id-map.ts";
import { LIST_MERGERS } from "./lists.ts";
import type { ListMerger } from "./lists.ts";

export const STATE_FIELDS = FIELD_POLICIES.map(function (f) {
  const entry: StateField & { mergeList?: (typeof LIST_MERGERS)[string] | undefined } = Object.assign({}, f);
  if (LIST_MERGERS[f.key]) entry.mergeList = LIST_MERGERS[f.key];
  return entry;
});

export const FIELD_LIST_MERGERS: Readonly<Record<string, ListMerger>> = Object.freeze(fieldListMergers());

function fieldListMergers(): Record<string, ListMerger> {
  const out = idMap<ListMerger>();
  FIELD_POLICIES.forEach(function (f) {
    const merger = LIST_MERGERS[f.key];
    if (merger) out[f.key] = merger;
  });
  return out;
}

export function missingStateFields(s: unknown) {
  return missingFieldsIn(s, STATE_FIELDS);
}

