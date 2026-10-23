import { createDocumentMerge } from "../application/session/document-merge.ts";
import type { DocumentMerge, DocumentMergePorts, MergeReportOptions } from "../application/session/document-merge.ts";
import type { ApplyMergeOptions, MergeOutcome } from "../application/session/apply-merge.ts";
import type { ValidatedDocument } from "../core/document/validated.ts";
import type { MergedStates } from "../core/merge-states.ts";
import type { OperationContext } from "../application/session/operation.ts";
import { showToast } from "./effects-bridge.ts";
import { autoSavePolicy, haltAutoSave } from "./save-bridge.ts";
import { noteAbsorbedDirty } from "./session-bridge.ts";

export type LegacyMergePorts = Omit<DocumentMergePorts<OperationContext>, "view">;

export interface MergeBannerView {
  readonly show: (result: MergedStates, opts: { readonly undo?: boolean | "saved" }) => unknown;
}

const PAUSED = "Autosave is paused — changes recovered for you are on screen but not in your file yet. " +
  "Press Save once you have looked them over.";

let running: DocumentMerge | null = null;
let banner: MergeBannerView | null = null;

function merge(): DocumentMerge {
  if (!running) throw new Error("The document merge is not started yet");
  return running;
}

export function startMerge(ports: LegacyMergePorts): () => void {
  if (running) throw new Error("The document merge is already started; stop it first");
  const mine = createDocumentMerge<OperationContext>({
    ...ports,
    view: {
      banner: function (result, undo) { if (banner) banner.show(result, undo === undefined ? {} : { undo: undo }); },
      absorbed: function (kind) { noteAbsorbedDirty(kind); },
      autoSave: function (paused) {
        if (paused) haltAutoSave(PAUSED);
        else autoSavePolicy().dueNow();
      },
      toast: function (text, tone, sticky) { showToast(text, tone, sticky); }
    }
  });
  running = mine;
  return function () {
    if (running === mine) running = null;
  };
}

export function mergeStarted(): boolean {
  return running !== null;
}

export function documentMerge(): DocumentMerge {
  return merge();
}

export function mergeStates(base: ValidatedDocument | null, mine: ValidatedDocument, theirs: ValidatedDocument): MergedStates {
  return merge().states(base, mine, theirs);
}

export function applyMerge(opts?: ApplyMergeOptions | null): MergeOutcome | Promise<MergeOutcome> {
  return merge().apply(opts);
}

export function reportMerge(result: MergedStates, opts?: MergeReportOptions | null): void {
  merge().report(result, opts);
}

export function installMergeBanner(view: MergeBannerView): () => void {
  banner = view;
  return function () {
    if (banner === view) banner = null;
  };
}
