import type { Preferences } from "../../application/preferences/preferences.ts";
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

export type JoinRequest = { readonly kind: "paste"; readonly link: string } |
  { readonly kind: "browser"; readonly invitation: { readonly script: string; readonly token: string } | false };

export interface JoinPreview {
  readonly kind: "ready";
  readonly title: string;
  readonly beats: number;
  readonly pictures: number;
  readonly join: (signal: AbortSignal, progress: (remaining: number) => void) => Promise<string | null>;
}

export interface JoinDialogPorts {
  readonly identity: Pick<Preferences, "myColor" | "setCommentAuthor" | "setMyColor">;
  readonly editor: () => string;
  readonly check: (request: JoinRequest, signal: AbortSignal) => Promise<JoinPreview | { readonly kind: "failed"; readonly reason: string }>;
  readonly settled: () => void;
}

export interface LeaveDialogPorts {
  readonly saveCopy: () => Promise<boolean>;
  readonly leave: () => Promise<boolean>;
}
