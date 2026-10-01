import { DEFAULT_WPM } from "./timing.ts";

export const SCHEMA_VERSION = 2;

export const STRATEGY_IDS = [
  "title",
  "doc-id",
  "rows",
  "comments",
  "list-union-with-base",
  "changed-side-wins",
  "max-plus-one",
  "theirs-wins",
  "person-colors",
  "target-length",
  "constant"
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

export interface StateField {
  key: string;
  def?: () => unknown;
  normalize?: (value: unknown) => unknown;
  merge: StrategyId;
  undo: boolean;
}

export const STATE_FIELDS: readonly StateField[] = [
  { key: "title",          def: function () { return ""; }, merge: "title", undo: true },
  { key: "docId",          merge: "doc-id", undo: false },
  { key: "rows",           def: function () { return []; }, merge: "rows", undo: false },
  { key: "comments",       def: function () { return []; }, merge: "comments", undo: true },
  { key: "people",         def: function () { return []; }, merge: "list-union-with-base", undo: true },
  { key: "productionTags", def: function () { return []; }, merge: "list-union-with-base", undo: true },
  { key: "brollShots",     def: function () { return []; }, merge: "list-union-with-base", undo: true },
  { key: "wordsPerMinute", def: function () { return DEFAULT_WPM; }, merge: "changed-side-wins", undo: true },
  { key: "rev",            def: function () { return 0; }, merge: "max-plus-one", undo: false },
  { key: "lastEditedBy",   merge: "theirs-wins", undo: false },
  { key: "lastEditedAt",   merge: "theirs-wins", undo: false },
  { key: "personColors",   merge: "person-colors", undo: false },
  { key: "targetSeconds",  merge: "target-length", undo: true },
  { key: "schema",         merge: "constant", undo: false }
];

export const ROW_FIELDS: readonly string[] = ["visualText", "imageRef", "audioText", "imageLinks", "moreImages"];

export const GALLERY_FIELDS: Readonly<Record<string, boolean>> = { imageLinks: true, moreImages: true };

export function missingStateFields(s: unknown): string[] {
  return STATE_FIELDS.filter(function (f) {
    return f.def && (!s || !(f.key in (s as object)));
  }).map(function (f) { return f.key; });
}
