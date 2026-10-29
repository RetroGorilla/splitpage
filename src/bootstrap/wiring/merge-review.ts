import { startLocalMerge as mountMergeReview } from "../../features/merge/local-merge.js";
import type { MergeReviewControl, MergeReviewMount, MergeReviewPorts } from "../../features/merge/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { parseProjectFileState } from "../../adapters/formats/project-file.ts";
import { textMergeContext } from "./session-merge.ts";
import { migrateRows } from "../../legacy/document-ports.ts";
import { applyStashedWork } from "./recovery-owners.ts";
import { mergeBase } from "../../legacy/session-bridge.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { homes as portHomes, place as portPlace } from "./ports/location.ts";
import { pictures as portPictures } from "./ports/pictures.ts";
import { fileConflicts as portFileConflicts } from "./ports/saving.ts";
import { text as portText } from "./ports/text.ts";

const mergeReview = owned<MergeReviewMount>();

function mergeReviewPorts(): MergeReviewPorts {
  return {
    document: portDocument,
    session: { mergeBase: () => mergeBase() },
    place: portPlace,
    homes: portHomes,
    conflicts: portFileConflicts,
    pictures: portPictures,
    text: portText,
    entry: { migrate: (raw) => migrateRows(raw) },
    files: { parse: (file, opts) => parseProjectFileState(file as Parameters<typeof parseProjectFileState>[0], opts) },
    recovery: { applyStashedWork: applyStashedWork },
    textMergeContext: (base, mine, theirs) => textMergeContext(base, mine, theirs)
  };
}

export function mountMergeReviewFeature(): MergeReviewMount {
  return mergeReview.replace(() => mountMergeReview(mergeReviewPorts()));
}

export const stopMergeReviewFeature = mergeReview.stop;

export const currentMergeReview: () => MergeReviewControl | null = mergeReview.owner;

export function offerFileMerge(currentFile: unknown, home: unknown): Promise<void> {
  return mergeReview.owner()?.offer(currentFile, home) ?? Promise.resolve();
}

export function resetMergeOffer(): void {
  mergeReview.owner()?.reset();
}
