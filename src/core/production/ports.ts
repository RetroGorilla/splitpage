import type { CellDecoder } from "../text/ports.ts";

export type FieldHtml = string | null | undefined;

export type FieldTag = { catId: string; name: string; text: string };

export type BrollItem = { id: string; name: string; desc: string };

export type ProductionReaders = {
  cellOf: CellDecoder;
  tagsInField: (html: FieldHtml) => FieldTag[];
  cueNamesInField: (html: FieldHtml) => string[];
  brollInField: (html: FieldHtml) => BrollItem[];
  brollPropsInField: (html: FieldHtml) => string[][];
  wordCount: (html: FieldHtml) => number;
};

export type FieldText = (html: FieldHtml) => string;

export type ProductionRow = { id: string; visualText?: FieldHtml; audioText?: FieldHtml };
