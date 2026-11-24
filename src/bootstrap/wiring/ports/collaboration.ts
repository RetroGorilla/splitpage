import type { CollaborationReads } from "../../../application/collaboration/state.ts";
import { collaborationSnapshot, onCollaborationChange } from "../collaboration-owner.ts";

export const collaboration: CollaborationReads = {
  snapshot: () => collaborationSnapshot(),
  onChange: (listener) => onCollaborationChange(listener)
};
