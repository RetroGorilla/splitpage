import type { DocumentDestination } from "../../../application/transitions/ports.ts";
import type { Transitions } from "../../../application/transitions/transitions.ts";
import { documentTransitions } from "../../../legacy/transition-bridge.ts";

export const transitions: Transitions<DocumentDestination> = {
  open: (opening) => documentTransitions().open(opening),
  startNew: (arrival) => documentTransitions().startNew(arrival),
  restore: (restoration) => documentTransitions().restore(restoration),
  recover: (recovery) => documentTransitions().recover(recovery),
  publish: (ctx, publication) => documentTransitions().publish(ctx, publication),
  copyId: () => documentTransitions().copyId()
};
