import type { CollaborationState } from "../../application/collaboration/state.ts";
import type { OfflineBeatReading, OfflineClashEntry } from "../../application/collaboration/offline-clashes.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";

export interface OfflineReviewPorts {
  readonly collaboration: Pick<CollaborationState, "snapshot" | "onChange" | "dismissOfflineClashes">;
  readonly document: Pick<DocumentReader, "onChange" | "numbering">;
  readonly readBeat: (id: string) => OfflineBeatReading | null;
  readonly revealBeat: (id: string) => void;
  readonly putBack: (entry: OfflineClashEntry) => boolean;
}
