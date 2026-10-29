import type { NoticePort } from "../effects/ports.ts";
import type { DocumentPlace } from "../location/document-place.ts";
import type { DocumentReader } from "../session/document-reader.ts";
import type { OperationContext } from "../session/operation.ts";
import type { DocumentDestination } from "../transitions/ports.ts";
import type { Transitions } from "../transitions/transitions.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { MergedStates } from "../../core/merge-states.ts";
import type { CaptureTimers } from "./capture-schedule.ts";
import type { DraftResume } from "./draft-resume.ts";
import type { DraftWriter } from "./draft-writer.ts";
import type { DesktopDraftStore, KeyedDraftStore } from "./ports.ts";
import type { ApplyStashedWork } from "./stashed-work.ts";

export interface BrowserDrafts {
  readonly store: KeyedDraftStore;
  readonly writer: DraftWriter;
}

export interface DraftFlush {
  readonly ok?: boolean;
  readonly code?: string;
  readonly obsolete?: boolean;
}

export interface DraftFile {
  readonly name: string;
}

export interface DraftFileHandle {
  readonly getFile: () => Promise<DraftFile>;
}

export type DraftParsedFile =
  | { readonly state: ValidatedDocument; readonly kind: unknown; readonly docIdEmbedded: boolean; readonly error?: undefined }
  | { readonly error: "unreadable" | "not-splitpage" };

export type DraftOpening = {
  readonly kind: "file";
  readonly file: unknown;
  readonly handle: unknown;
  readonly parsed: { readonly state: unknown; readonly kind: unknown };
  readonly options: { readonly skipSnapshot: boolean; readonly silent: boolean };
};

export interface DraftRecovery {
  readonly started: () => boolean;
  readonly draftResume: () => DraftResume;
  readonly browserDrafts: () => BrowserDrafts;
  readonly desktopDrafts: () => DesktopDraftStore;
  readonly captureRestore: () => OperationContext;
  readonly stillRestoring: (ctx: OperationContext) => boolean;
  readonly applyStashedWork: ApplyStashedWork<ValidatedDocument, MergedStates>;
  readonly useBrowserDraftFactory: (factory: unknown) => BrowserDrafts;
}

export interface DraftsPorts {
  readonly running: () => boolean;
  readonly clock: { readonly now: () => number };
  readonly timers: CaptureTimers;
  readonly report: (error: unknown) => void;
  readonly document: Pick<DocumentReader, "current">;
  readonly session: { readonly mergeBase: () => unknown; readonly noteAbsorbedDirty: (reason: string) => void };
  readonly place: Pick<DocumentPlace, "home" | "fileHome" | "importHome" | "writtenOut">;
  readonly markWrittenOut: (on: boolean) => void;
  readonly saves: { readonly unsaved: () => boolean; readonly editSeq: () => number };
  readonly notices: Pick<NoticePort, "show">;
  readonly entry: { readonly migrate: (raw: unknown) => ValidatedDocument };
  readonly identity: { readonly copyHistory: (fromId: string, toId: string) => void; readonly sync: () => void };
  readonly transitions: Pick<Transitions<DocumentDestination>, "recover" | "restore">;
  readonly documents: { readonly open: (opening: DraftOpening) => Promise<unknown> };
  readonly resetProductionPanel: () => void;
  readonly pictures: {
    readonly persist: (refs: readonly string[]) => Promise<string[]>;
    readonly inline: (json: string, failed: readonly string[]) => string;
  };
  readonly files: {
    readonly handle: (entry: unknown) => DraftFileHandle;
    readonly parse: (file: unknown) => Promise<DraftParsedFile | null>;
  };
  readonly recovery: DraftRecovery;
  readonly browserDraft: {
    readonly key: (base: string, docId: string) => string;
    readonly base: (serverUrl: unknown) => string;
  };
  readonly lock: {
    readonly writerId: () => string;
    readonly hold: () => void;
    readonly release: () => void;
    readonly isLive: (writerId: string) => Promise<boolean>;
  };
  readonly documentState: { readonly notify: () => void };
}

export interface DraftsMount {
  readonly flush: (opts?: { readonly keep?: boolean } | null) => Promise<DraftFlush>;
  readonly noteChange: () => void;
  readonly taker: () => (() => Promise<unknown>) | null;
  readonly applyTaken: (taken: unknown) => Promise<string>;
  readonly holdLock: () => void;
  readonly releaseLock: () => void;
  readonly testing: Readonly<Record<string, unknown>>;
  readonly dispose: () => void;
}
