import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { MergedStates } from "../../core/merge-states.ts";
import type { LineShotIds } from "../../core/production/broll.ts";
import { applyIncomingMerge } from "./apply-merge.ts";
import type { ApplyMergeOptions, ApplyMergePorts, MergeKind, MergeOutcome } from "./apply-merge.ts";
import { mergeIncoming } from "./merge-incoming.ts";
import type { NoticeKind } from "../effects/ports.ts";

export interface MergeReportOptions {
  readonly kind?: MergeKind | undefined;
  readonly noAutoSave?: boolean | undefined;
  readonly alreadySaved?: boolean | undefined;
  readonly undo?: boolean | "saved" | undefined;
}

export interface MergeOutcomeView {
  readonly banner: (result: MergedStates, undo: boolean | "saved" | undefined) => void;
  readonly absorbed: (kind: MergeKind) => void;
  readonly autoSave: (paused: boolean) => void;
  readonly toast: (text: string, tone: NoticeKind, sticky: boolean) => void;
}

export interface DocumentMergePorts<Ctx> extends Omit<ApplyMergePorts<Ctx>, "merge" | "view"> {
  readonly states: (base: ValidatedDocument | null, mine: ValidatedDocument, theirs: ValidatedDocument) => MergedStates;
  readonly entry: (raw: unknown, lines?: LineShotIds) => ValidatedDocument;
  readonly view: MergeOutcomeView;
}

export interface DocumentMerge {
  readonly states: (base: ValidatedDocument | null, mine: ValidatedDocument, theirs: ValidatedDocument) => MergedStates;
  readonly apply: (opts?: ApplyMergeOptions | null) => MergeOutcome | Promise<MergeOutcome>;
  readonly report: (result: MergedStates, opts?: MergeReportOptions | null) => void;
}

export function createDocumentMerge<Ctx>(ports: DocumentMergePorts<Ctx>): DocumentMerge {
  function report(result: MergedStates, opts?: MergeReportOptions | null): void {
    const o = opts || {};
    ports.view.banner(result, o.undo);
    if (o.alreadySaved) return;
    ports.view.absorbed(o.kind || "server");
    ports.view.autoSave(!!o.noAutoSave);
  }

  const applying: ApplyMergePorts<Ctx> = {
    ...ports,
    merge: function (input) {
      return mergeIncoming(input, ports.isDocument, { entry: ports.entry, merge: ports.states });
    },
    view: {
      report: function (result, opts) { report(result, opts); },
      absorbedDirty: function (kind) { ports.view.absorbed(kind); },
      toast: function (text, tone, sticky) { ports.view.toast(text, tone, sticky); }
    }
  };

  return Object.freeze({
    states: function (base: ValidatedDocument | null, mine: ValidatedDocument, theirs: ValidatedDocument) { return ports.states(base, mine, theirs); },
    apply: function (opts?: ApplyMergeOptions | null) { return applyIncomingMerge(opts || { theirs: undefined }, applying); },
    report: report
  });
}
