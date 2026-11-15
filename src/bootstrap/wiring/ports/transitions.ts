import type { DocumentDestination, DocumentOpeningActivity, HistoryPort } from "../../../application/transitions/ports.ts";
import type { Transitions } from "../../../application/transitions/transitions.ts";
import { documentOpenings, documentTransitions, keepSnapshot, openDocument } from "../transition-owners.ts";
import type { DocumentOpening } from "../../../application/transitions/sources.ts";

export const opening: DocumentOpening = { open: (source) => openDocument(source) };
export const openingStatus: Pick<DocumentOpeningActivity, "openingPending"> = { openingPending: documentOpenings.openingPending };
export const openingActivity: Pick<DocumentOpeningActivity, "track"> = { track: documentOpenings.track };

export const history: HistoryPort = { keep: (label, doc) => keepSnapshot(label, doc) };

export const transitions: Transitions<DocumentDestination> = {
  open: (opening) => documentTransitions().open(opening),
  startNew: (arrival) => documentTransitions().startNew(arrival),
  restore: (restoration) => documentTransitions().restore(restoration),
  recover: (recovery) => documentTransitions().recover(recovery),
  copyId: () => documentTransitions().copyId()
};
