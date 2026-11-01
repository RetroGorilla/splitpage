import { normalizePersonColors } from "./person-colors.ts";
import { normalizeSections } from "./sections.ts";
import { cappedName } from "./text-policy.ts";
import { DEFAULT_WPM, normalizeTargetLength, normalizeWordsPerMinute } from "./timing.ts";
import { normalizeTitleOrigin, normalizeTitleVersion } from "./file-title.ts";

export const SCHEMA_VERSION = 2;

export const STRATEGY_IDS = [
  "title",
  "doc-id",
  "rows",
  "comments",
  "list-union-with-base",
  "changed-side-wins",
  "optional-changed-side-wins",
  "max-plus-one",
  "theirs-wins",
  "person-colors",
  "target-length",
  "sections",
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

export const EDITOR_NAME_MAX = 30;

export function normalizeEditorName(v: unknown): string | undefined {
  return typeof v === "string" ? cappedName(v, EDITOR_NAME_MAX) || undefined : undefined;
}

const FIELDS: StateField[] = [
  { key: "title",          def: function () { return ""; }, merge: "title", undo: true },
  { key: "titleOrigin", normalize: normalizeTitleOrigin, merge: "optional-changed-side-wins", undo: true },
  { key: "titleVersion", normalize: normalizeTitleVersion, merge: "optional-changed-side-wins", undo: true },
  { key: "docId",          merge: "doc-id", undo: false },
  { key: "rows",           def: function () { return []; }, merge: "rows", undo: false },
  { key: "comments",       def: function () { return []; }, merge: "comments", undo: true },
  { key: "people",         def: function () { return []; }, merge: "list-union-with-base", undo: true },
  { key: "productionTags", def: function () { return []; }, merge: "list-union-with-base", undo: true },
  { key: "brollShots",     def: function () { return []; }, merge: "list-union-with-base", undo: true },
  { key: "wordsPerMinute", def: function () { return DEFAULT_WPM; }, normalize: normalizeWordsPerMinute, merge: "changed-side-wins", undo: true },
  { key: "rev",            def: function () { return 0; }, merge: "max-plus-one", undo: false },
  { key: "lastEditedBy",   normalize: normalizeEditorName, merge: "theirs-wins", undo: false },
  { key: "lastEditedAt",   merge: "theirs-wins", undo: false },
  { key: "personColors",   normalize: function (v) { return normalizePersonColors(v) || undefined; }, merge: "person-colors", undo: false },
  { key: "targetSeconds",  normalize: normalizeTargetLength, merge: "target-length", undo: true },
  { key: "sections",       normalize: normalizeSections, merge: "sections", undo: true },
  { key: "schema",         merge: "constant", undo: false }
];

export const STATE_FIELDS: readonly StateField[] = Object.freeze(FIELDS.map(function (f) { return Object.freeze(f); }));

export const NO_UNDO_KEYS: Readonly<Record<string, true>> = Object.freeze(noUndoKeys());

function noUndoKeys(): Record<string, true> {
  const out: Record<string, true> = {};
  STATE_FIELDS.forEach(function (f) { if (!f.undo) out[f.key] = true; });
  return out;
}

export const ROW_FIELDS: readonly string[] = Object.freeze(["visualText", "imageRef", "audioText", "imageLinks", "moreImages"]);

export const GALLERY_FIELDS: Readonly<Record<string, boolean>> = Object.freeze({ imageLinks: true, moreImages: true });

export function missingStateFields(s: unknown, fields: readonly StateField[] = STATE_FIELDS): string[] {
  return fields.filter(function (f) {
    return f.def && (!s || !(f.key in (s as object)));
  }).map(function (f) { return f.key; });
}
