import type { CollaborationState } from "../../application/collaboration/state.ts";
import type { OfflineBeatReading, OfflineClashEntry } from "../../application/collaboration/offline-clashes.ts";
import type { ShareAttemptResult } from "../../application/collaboration/share.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { ScreenState } from "../../application/screen.ts";

export interface OfflineReviewPorts {
  readonly collaboration: Pick<CollaborationState, "snapshot" | "onChange" | "dismissOfflineClashes">;
  readonly document: Pick<DocumentReader, "onChange" | "numbering">;
  readonly readBeat: (id: string) => OfflineBeatReading | null;
  readonly revealBeat: (id: string) => void;
  readonly putBack: (entry: OfflineClashEntry) => boolean;
}

export interface ShareDialogPorts {
  readonly address: () => Promise<string | null>;
  readonly share: (address: string, signal: AbortSignal, switching: () => void) => Promise<ShareAttemptResult>;
  readonly copy: (text: string) => Promise<void>;
  readonly settings: () => void;
}

export interface ShareActionPorts {
  readonly screen: () => ScreenState;
  readonly visible: () => boolean;
  readonly open: () => void;
}
