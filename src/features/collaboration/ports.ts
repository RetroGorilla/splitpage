import type { Preferences } from "../../application/preferences/preferences.ts";
import type { CollaborationReads, CollaborationState } from "../../application/collaboration/state.ts";
import type { FileCopyReads } from "../../application/collaboration/file-copy.ts";
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
  readonly share: (address: string, signal: AbortSignal, switching: () => void, password?: string) => Promise<ShareAttemptResult>;
  readonly copy: (text: string) => Promise<void>;
  readonly settings: () => void;
}

export interface SharedPopoverPorts {
  readonly collaboration: CollaborationReads;
  readonly membership: () => { readonly role: "guest" | "owner"; readonly link: string | null; readonly passwordRequired?: boolean } | null;
  readonly canManage: () => Promise<boolean>;
  readonly manage: (operation: "promote" | "reset" | "stop" | "check-link" | "set-password" | "remove-password", password?: string) => Promise<void>;
  readonly saveCopy: () => void;
  readonly copy: (link: string) => Promise<void>;
  readonly leave: () => Promise<void>;
  readonly open: () => void;
  readonly confirm: (message: string) => boolean;
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
  readonly check: (request: JoinRequest, signal: AbortSignal, password?: string) => Promise<
    JoinPreview | { readonly kind: "failed"; readonly reason: string } | { readonly kind: "focused" }
  >;
  readonly settled: () => void;
}

export interface LeaveDialogPorts {
  readonly owner?: boolean;
  readonly saveCopy: () => Promise<boolean>;
  readonly leave: () => Promise<boolean | "cancelled">;
}

export interface FileCopyBannerPorts extends FileCopyReads {
  readonly retry: () => Promise<void>;
  readonly overwrite: () => Promise<void>;
  readonly saveAs: () => Promise<void>;
  readonly stop: () => Promise<void>;
}
