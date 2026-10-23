import type { MergedStates } from "../../core/merge-states.ts";
import type { MergeInput } from "./merge-incoming.ts";

export type MergeKind = "server" | "recovery";

export interface MergeToast {
  readonly text: string | (() => string);
  readonly tone?: string;
  readonly sticky?: boolean;
}

export interface ApplyMergeOptions {
  readonly base?: unknown;
  readonly mine?: unknown;
  readonly theirs: unknown;
  readonly source?: string;
  readonly unchanged?: boolean;
  readonly mergeOnly?: boolean;
  readonly recovery?: boolean;
  readonly undoPoint?: unknown;
  readonly keepLabel?: string | null;
  readonly historyFrom?: string | null;
  readonly newBase?: unknown;
  readonly chips?: boolean;
  readonly report?: boolean;
  readonly noAutoSave?: boolean;
  readonly awaitUndoPoint?: boolean;
  readonly toast?: MergeToast | null;
}

export interface UndoPointTicket {
  readonly id: string;
  readonly docId: string;
  readonly done?: PromiseLike<unknown>;
}

export interface MergeUndoRecord {
  readonly id: string;
  readonly docId: string | null | undefined;
  readonly source: string | undefined;
}

export interface MergeOutcome {
  readonly state: unknown;
  readonly result: MergedStates | null;
  readonly snapshot: UndoPointTicket | null;
  readonly replaced?: true;
}

export interface MergeView {
  readonly chips: () => void;
  readonly report: (result: MergedStates, opts: { readonly noAutoSave: boolean; readonly kind: MergeKind }) => void;
  readonly absorbedDirty: (kind: MergeKind) => void;
  readonly toast: (text: string, tone: string, sticky: boolean) => void;
}

export interface ApplyMergePorts<Ctx> {
  readonly isDocument: (raw: unknown) => boolean;
  readonly merge: (input: MergeInput) => MergedStates;
  readonly snapshot: (label: string | undefined, doc: unknown) => UndoPointTicket | null;
  readonly current: () => unknown;
  readonly adopt: (kind: MergeKind, next: unknown, merged: boolean) => unknown;
  readonly documentId: (doc: unknown) => string | null | undefined;
  readonly noteHistoryFrom: (prevDocId: string) => void;
  readonly armUndo: (record: MergeUndoRecord | null) => void;
  readonly setBase: (next: unknown, why: string) => void;
  readonly capture: () => Ctx;
  readonly stillOwns: (ctx: Ctx) => boolean;
  readonly view: MergeView;
}

export const UNDO_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "server-conflict": "Before merging in someone else's changes",
  "server-resume": "Before merging your recovered changes",
  "stash": "Before merging your unsaved changes"
});

export function mergeKind(opts: ApplyMergeOptions): MergeKind {
  return opts.recovery || opts.source === "server-resume" ? "recovery" : "server";
}

export function applyIncomingMerge<Ctx>(opts: ApplyMergeOptions, ports: ApplyMergePorts<Ctx>): MergeOutcome | Promise<MergeOutcome> {
  if (!ports.isDocument(opts.theirs) || (!opts.unchanged && !ports.isDocument(opts.mine))) {
    return { state: ports.current(), result: null, snapshot: null };
  }

  let result: MergedStates | null = null;
  let snap: UndoPointTicket | null = null;
  if (!opts.unchanged) {
    if (opts.undoPoint) snap = ports.snapshot(UNDO_LABELS[opts.source ?? ""], opts.undoPoint);
    if (opts.keepLabel) ports.snapshot(opts.keepLabel, opts.mine);
    result = ports.merge({ base: opts.base, mine: opts.mine, theirs: opts.theirs });
  }
  let next: unknown = result ? result.merged : opts.theirs;

  function armUndoPoint(docId: string | null | undefined): void {
    if (!opts.undoPoint) return;
    ports.armUndo(snap ? { id: snap.id, docId: docId, source: opts.source } : null);
  }

  if (opts.mergeOnly) {
    armUndoPoint(snap?.docId);
    return { state: next, result: result, snapshot: snap };
  }

  const kind = mergeKind(opts);

  function adopt(): MergeOutcome {
    next = ports.adopt(kind, next, result !== null);
    if (opts.historyFrom) ports.noteHistoryFrom(opts.historyFrom);
    armUndoPoint(ports.documentId(ports.current()));
    if (opts.newBase !== undefined) {
      const base = typeof opts.newBase === "function" ? (opts.newBase as () => unknown)() : opts.newBase;
      ports.setBase(base, "merge: " + (opts.source || ""));
    }
    if (opts.chips) ports.view.chips();
    if (opts.report !== false) {
      if (result) ports.view.report(result, { noAutoSave: !!opts.noAutoSave, kind: kind });
      else ports.view.absorbedDirty(kind);
    }
    if (opts.toast) {
      const said = typeof opts.toast.text === "function" ? opts.toast.text() : opts.toast.text;
      if (said) ports.view.toast(said, opts.toast.tone || "ok", !!opts.toast.sticky);
    }
    return { state: next, result: result, snapshot: snap };
  }

  if (!opts.awaitUndoPoint) return adopt();
  const written = snap?.done ?? null;
  const ctx = ports.capture();
  return Promise.resolve(written).then(null, () => undefined).then((): MergeOutcome => {
    if (!ports.stillOwns(ctx)) return { state: ports.current(), result: null, snapshot: snap, replaced: true };
    return adopt();
  });
}
