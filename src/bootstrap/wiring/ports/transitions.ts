import type { DocumentDestination, HistoryPort } from "../../../application/transitions/ports.ts";
import type { Transitions } from "../../../application/transitions/transitions.ts";
import { documentTransitions, keepSnapshot, openDocument } from "../../../legacy/transition-bridge.ts";
import type { DocumentOpening } from "../../../application/transitions/sources.ts";

export const opening: DocumentOpening = { open: (source) => openDocument(source) };

export const history: HistoryPort = { keep: (label, doc) => keepSnapshot(label, doc) };

export const transitions: Transitions<DocumentDestination> = {
  open: (opening) => documentTransitions().open(opening),
  startNew: (arrival) => documentTransitions().startNew(arrival),
  restore: (restoration) => documentTransitions().restore(restoration),
  recover: (recovery) => documentTransitions().recover(recovery),
  copyId: () => documentTransitions().copyId()
};
