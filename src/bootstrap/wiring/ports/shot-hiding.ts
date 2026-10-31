import type { ShotHiding } from "../../../application/shot-hiding.ts";
import { shotHiding as owner } from "../shot-hiding.ts";
import { sectionView } from "../editor-owners.ts";
import { currentDocument } from "../session-owner.ts";

export const shotHiding: Pick<ShotHiding, "reveal"> = {
  reveal: (id) => { const doc = currentDocument(); if (doc) sectionView().reveal(doc, id); owner().reveal(id); }
};
