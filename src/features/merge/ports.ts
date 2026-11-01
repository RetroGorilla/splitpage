import type { DocumentLocation } from "../../application/location/document-location.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { PictureStore } from "../../application/media/picture-store.ts";
import type { ApplyStashedWork } from "../../application/recovery/stashed-work.ts";
import type { FileConflicts } from "../../application/save/file-conflict.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { MergedStates } from "../../core/merge-states.ts";
import type { TextMergeContext } from "../../core/merge/text-field.ts";
import type { DraftParsedFile } from "../../application/recovery/drafts-ports.ts";

type MergeParsedFile = Pick<Extract<DraftParsedFile, { state: ValidatedDocument }>, "state"> & Partial<Pick<Extract<DraftParsedFile, { state: ValidatedDocument }>, "docIdEmbedded">> & { readonly error?: undefined } | { readonly error: "unreadable" | "not-splitpage" };

export interface MergeFileOptions {
  readonly noAsk: boolean;
}

export interface MergeReviewPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly session: { readonly mergeBase: () => unknown };
  readonly place: Pick<DocumentPlace, "fileHome">;
  readonly homes: Pick<DocumentLocation, "amendHome">;
  readonly conflicts: Pick<FileConflicts, "close">;
  readonly pictures: Pick<PictureStore, "imgHtml">;
  readonly text: Pick<TextServices, "htmlToPlainText">;
  readonly entry: { readonly migrate: (raw: unknown) => ValidatedDocument };
  readonly files: { readonly parse: (file: unknown, opts: MergeFileOptions) => Promise<MergeParsedFile | null> };
  readonly recovery: { readonly applyStashedWork: ApplyStashedWork<ValidatedDocument, MergedStates> };
  readonly textMergeContext: (base: unknown, mine: unknown, theirs: unknown) => TextMergeContext;
}

export interface MergeReviewControl {
  readonly offer: (currentFile: unknown, home: unknown) => Promise<void>;
  readonly reset: () => void;
  readonly open: () => void;
  readonly cancel: () => void;
  readonly confirm: () => void;
}

export interface MergeReviewMount extends MergeReviewControl {
  readonly dispose: () => void;
}
