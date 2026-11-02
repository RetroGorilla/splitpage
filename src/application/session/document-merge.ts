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
  readonly undo?: boolean | undefined;
}

export interface MergeOutcomeView {
  readonly banner: (result: MergedStates, undo: boolean | undefined) => void;
  readonly absorbed: (kind: MergeKind) => void;
  readonly autoSave: (paused: boolean) => void;
  readonly toast: (text: string, tone: NoticeKind, sticky: boolean) => void;
}

export interface DocumentMergePorts<Ctx> extends Omit<ApplyMergePorts<Ctx, ValidatedDocument, ValidatedDocument, ValidatedDocument | null>, "merge" | "view"> {
  readonly states: (base: ValidatedDocument | null, mine: ValidatedDocument, theirs: ValidatedDocument) => MergedStates;
  readonly entry: (raw: unknown, lines?: LineShotIds) => ValidatedDocument;
  readonly view: MergeOutcomeView;
}

export interface DocumentMerge {
  readonly states: (base: ValidatedDocument | null, mine: ValidatedDocument, theirs: ValidatedDocument) => MergedStates;
  readonly apply: <T extends ValidatedDocument | null>(opts?: ApplyMergeOptions<T, ValidatedDocument> | null) => MergeOutcome<ValidatedDocument | T> | Promise<MergeOutcome<ValidatedDocument | T>>;
  readonly report: (result: MergedStates, opts?: MergeReportOptions | null) => void;
}

export function createDocumentMerge<Ctx>(ports: DocumentMergePorts<Ctx>): DocumentMerge {
  function report(result: MergedStates, opts?: MergeReportOptions | null): void {
    const o = opts || {};
    ports.view.banner(result, o.undo);
    if (o.alreadySaved) return;
    ports.view.absorbed(o.kind || "disk");
    ports.view.autoSave(!!o.noAutoSave);
  }

  const applying: ApplyMergePorts<Ctx, ValidatedDocument, ValidatedDocument, ValidatedDocument | null> = {
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
    apply: function <T extends ValidatedDocument | null>(opts?: ApplyMergeOptions<T, ValidatedDocument> | null): MergeOutcome<ValidatedDocument | T> | Promise<MergeOutcome<ValidatedDocument | T>> {
      if (!opts) return { state: applying.current(), result: null, snapshot: null };
      return applyIncomingMerge(opts, applying);
    },
    report: report
  });
}
