import { STATE_FIELDS as FIELD_POLICIES, missingStateFields as missingFieldsIn } from "../document/fields.ts";
import type { StateField } from "../document/fields.ts";
import { LIST_MERGERS } from "./lists.ts";

export const STATE_FIELDS = FIELD_POLICIES.map(function (f) {
  const entry: StateField & { mergeList?: (typeof LIST_MERGERS)[string] | undefined } = Object.assign({}, f);
  if (LIST_MERGERS[f.key]) entry.mergeList = LIST_MERGERS[f.key];
  return entry;
});

export function missingStateFields(s: unknown) {
  return missingFieldsIn(s, STATE_FIELDS);
}

