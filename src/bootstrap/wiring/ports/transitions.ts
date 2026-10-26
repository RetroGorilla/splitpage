import type { DocumentDestination } from "../../../application/transitions/ports.ts";
import type { Transitions } from "../../../application/transitions/transitions.ts";
import { documentTransitions, openDocument } from "../../../legacy/transition-bridge.ts";
import type { DocumentOpening } from "../../../application/transitions/sources.ts";

export const opening: DocumentOpening = { open: (source) => openDocument(source) };

export const transitions: Transitions<DocumentDestination> = {
  open: (opening) => documentTransitions().open(opening),
  startNew: (arrival) => documentTransitions().startNew(arrival),
  restore: (restoration) => documentTransitions().restore(restoration),
  recover: (recovery) => documentTransitions().recover(recovery),
  publish: (ctx, publication) => documentTransitions().publish(ctx, publication),
  copyId: () => documentTransitions().copyId()
};
