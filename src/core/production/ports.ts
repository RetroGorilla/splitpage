import type { Frozen } from "../document/freeze.ts";
import type { CellDecoder } from "../text/ports.ts";

export type FieldHtml = string | null | undefined;

export type FieldTag = { catId: string; name: string; text: string };

export type BrollItem = { id: string; name: string; desc: string };

export type ProductionReaders = {
  cellOf: CellDecoder;
  tagsInField: (html: FieldHtml) => Frozen<FieldTag[]>;
  cueNamesInField: (html: FieldHtml) => Frozen<string[]>;
  brollInField: (html: FieldHtml) => Frozen<BrollItem[]>;
  brollPropsInField: (html: FieldHtml) => Frozen<string[][]>;
  wordCount: (html: FieldHtml) => number;
};

export type FieldText = (html: FieldHtml) => string;

export type ProductionRow = { id: string; visualText?: FieldHtml; audioText?: FieldHtml };
