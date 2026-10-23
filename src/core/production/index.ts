import type { Frozen } from "../document/freeze.ts";
import type { DocumentShape, ValidatedDocument } from "../document/validated.ts";
import type { TagCategoryLook } from "./looks.ts";
import type { ProductionEntry, ProductionIndex } from "./tags.ts";

export type PresentedProductionEntry = Omit<Frozen<ProductionEntry>, "catId"> & { readonly cat: TagCategoryLook };

export interface TagRecordsPlan {
  readonly apply: ((into: DocumentShape) => number) | null;
  readonly commit: () => void;
}

export interface ProductionIndexOwner {
  readonly entries: (doc: ValidatedDocument | null | undefined) => PresentedProductionEntry[];
  readonly current: (doc: ValidatedDocument | null | undefined) => ProductionIndex | null;
  readonly derived: () => number;
  readonly resetDerived: () => void;
  readonly recordsPlan: (doc: ValidatedDocument | null | undefined, viewed: ValidatedDocument | null | undefined) => TagRecordsPlan | null;
}

