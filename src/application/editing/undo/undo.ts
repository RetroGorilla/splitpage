import type { CommandRefusal, Replay, ReplayPlan } from "../../session/document-session.ts";
import type { StampPorts } from "../../session/ports.ts";
import { applySteps } from "../../../core/text/steps.ts";
import type { Step, StepRow } from "../../../core/text/steps.ts";
import type { ValidatedDocument } from "../../../core/document/validated.ts";
import type { FlowSelectionPair } from "../../../core/flow/flow.ts";
import { changedBetween, cosmetic as cosmeticFor, createUndoHistory, diffStates, planSteps, replayChanges, writePlanned } from "./history.ts";
import type { CellMark, HtmlRunDecoder, PreparedReplay, ReplayResult, StepResult, UndoEntry, UndoState } from "./history.ts";

export type UndoDirection = "undo" | "redo";

export type ReplayOutcome =
  | { readonly kind: "applied" | "committed" | "noop" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: unknown };

export type ReplayRunner = (replay: Replay) => ReplayOutcome;

export interface UndoHooks {
  readonly afterApply?: (steps: readonly Step[], dir: UndoDirection) => void;
  readonly onRefused?: (reason: string, dir: UndoDirection) => void;
}

export type AmendOutcome = "applied" | "unchanged" | "refused";

export type RowsFix = (rows: StepRow[]) => unknown;

export type UndoResult = StepResult | { ok: false; reason: string };

const HELD: UndoResult = Object.freeze({ ok: false, empty: true });

export interface UndoPorts {
  readonly held: () => ValidatedDocument | null;
  readonly epoch: () => number;
  readonly runs: HtmlRunDecoder;
  readonly now: () => number;
  readonly cleared: (count: number) => void;
}

export interface Undo {
  readonly configure: (hooks: UndoHooks) => () => void;
  readonly routeReplays: (run: ReplayRunner, stamps: StampPorts | null, amend?: ReplayRunner) => () => void;
  readonly adopt: (doc: UndoState | null | undefined) => void;
  readonly track: () => void;
  readonly flush: () => void;
  readonly noteEdit: (selection?: FlowSelectionPair) => void;
  readonly noteRemote: (next: UndoState | null | undefined) => void;
  readonly absorbRemote: () => void;
  readonly reset: () => void;
  readonly undo: () => UndoResult;
  readonly redo: () => UndoResult;
  readonly settleAfterApply: (paragraphStarts?: readonly string[]) => void;
  readonly foldIntoEdit: (entry: UndoEntry | null | undefined, touches: (step: Step) => boolean, change: (draft: UndoState) => boolean) => boolean;
  readonly amendRows: (fix: RowsFix) => AmendOutcome;
  readonly hold: () => () => void;
  readonly breakCoalescing: () => void;
  readonly sizes: () => { undo: number; redo: number };
  readonly last: () => UndoEntry | null;
  readonly nextRedo: () => UndoEntry | null;
  readonly lifetime: () => number;
  readonly mark: () => number;
  readonly serial: () => number;
  readonly compositionMark: (rowId: string, key: string) => CellMark;
  readonly dropEmptySince: (mark: CellMark, cancelled?: boolean) => boolean;
}

interface Replays {
  readonly run: ReplayRunner;
  readonly amend: ReplayRunner;
  readonly stamps: StampPorts | null;
}

function clone<T>(v: T): T { return v === undefined ? v : JSON.parse(JSON.stringify(v)) as T; }

function asState(doc: ValidatedDocument): UndoState { return doc as unknown as UndoState; }

export function createUndo(ports: UndoPorts): Undo {
  const runs = ports.runs;
  const history = createUndoHistory(runs);
  let lifetime = 0;
  let base: UndoState | null = null;
  let tracked: UndoState | null = null;
  let flushQueued = false;
  let queuedSelection: FlowSelectionPair | undefined;
  let applying = false;
  const holds = new Map<number, number>();
  const hooks: { afterApply: UndoHooks["afterApply"] | null; onRefused: UndoHooks["onRefused"] | null } = { afterApply: null, onRefused: null };
  const UNROUTED: Replays = Object.freeze({ run: replayUnwired, amend: replayUnwired, stamps: null });
  let replays: Replays = UNROUTED;

  function configure(opts: UndoHooks): () => void {
    const was = { afterApply: hooks.afterApply, onRefused: hooks.onRefused };
    if (opts.afterApply) hooks.afterApply = opts.afterApply;
    if (opts.onRefused) hooks.onRefused = opts.onRefused;
    return function () {
      if (opts.afterApply && hooks.afterApply === opts.afterApply) hooks.afterApply = was.afterApply;
      if (opts.onRefused && hooks.onRefused === opts.onRefused) hooks.onRefused = was.onRefused;
    };
  }

  function routeReplays(run: ReplayRunner, stamps: StampPorts | null, amend?: ReplayRunner): () => void {
    const mine: Replays = Object.freeze({ run: run, amend: amend || run, stamps: stamps });
    replays = mine;
    return function () {
      if (replays === mine) replays = UNROUTED;
    };
  }

  function replayUnwired(task: Replay): ReplayOutcome {
    const live = ports.held();
    if (!live) return { kind: "noop" };
    const plan = task.plan(live);
    if (!plan) return { kind: "noop" };
    if ("refused" in plan) return { kind: "rejected", reason: plan.refused };
    plan.apply(live);
    plan.settle();
    return { kind: "applied" };
  }

  function held(): UndoState | null {
    const doc = ports.held();
    return doc && asState(doc);
  }

  function restart(doc: UndoState | null | undefined): void {
    queuedSelection = undefined;
    history.clear();
    lifetime++;
    tracked = doc || null;
    base = tracked ? clone(tracked) : null;
  }

  function adopt(doc: UndoState | null | undefined): void {
    if (applying || (doc || null) === tracked) return;
    flushQueued = false;
    restart(doc);
  }

  function cosmetic(step: Step): boolean {
    return cosmeticFor(runs, step);
  }

  function flush(): void {
    const reported = flushQueued;
    const selection = queuedSelection;
    queuedSelection = undefined;
    flushQueued = false;
    if (applying) return;
    const live = held();
    if (!live || live !== tracked || !base) { restart(live); return; }
    const steps = diffStates(base, live);
    const content = steps.filter(function (s) { return !cosmetic(s); });
    if (reported && content.length) history.record(content, ports.now(), selection);
    try { base = applySteps(base, steps); } catch (e) { base = clone(live); }
  }

  function noteEdit(selection?: FlowSelectionPair): void {
    if (applying || flushQueued) return;
    queuedSelection = selection;
    flushQueued = true;
    if (selection) { flush(); return; }
    void Promise.resolve().then(flush);
  }

  function noteRemote(next: UndoState | null | undefined): void {
    flush();
    if (!next) { restart(null); return; }
    if (base) history.forget(changedBetween(base, next));
    tracked = next;
    base = clone(next);
  }

  function absorbRemote(): void {
    const live = held();
    if (!live || live !== tracked || !base) { restart(live); return; }
    history.forget(changedBetween(base, live));
    base = clone(live);
    lifetime++;
  }

  function stamp(state: UndoState, steps: readonly Step[]): void {
    const stamps = replays.stamps;
    if (!stamps) return;
    steps.forEach(function (st) {
      if (st.op !== "rowField" || st.key === "paragraphStart") return;
      const row = state.rows.find(function (r) { return r.id === st.rowId; });
      if (!row) return;
      row["updatedAt"] = stamps.clock.nowIso();
      row["updatedBy"] = stamps.editor.name();
    });
  }

  function replayTask(dir: UndoDirection, seen: { prepared: PreparedReplay | null; result: ReplayResult | null }): Replay {
    return {
      name: dir,
      plan: function (doc): ReplayPlan | CommandRefusal | null {
        const state = asState(doc);
        const p = history.prepare(dir, state);
        seen.prepared = p;
        if (!p) return null;
        if (p.refused !== undefined) return { refused: p.refused };
        return {
          changes: p.changes,
          apply: function (live) {
            p.write();
            stamp(asState(live), p.steps);
          },
          settle: function () {
            const next = clone(state);
            seen.result = p.finish();
            base = next;
            tracked = state;
          }
        };
      }
    };
  }

  function run(dir: UndoDirection): UndoResult {
    flush();
    if (!held()) return { ok: false, empty: true };
    const seen: { prepared: PreparedReplay | null; result: ReplayResult | null } = { prepared: null, result: null };
    let outcome: ReplayOutcome;
    applying = true;
    try {
      outcome = replays.run(replayTask(dir, seen));
    } finally {
      applying = false;
    }
    const p = seen.prepared;
    if (outcome.kind === "failed") throw outcome.error;
    if (outcome.kind === "applied" || outcome.kind === "committed") {
      const r = seen.result as ReplayResult;
      if (hooks.afterApply) hooks.afterApply(r.steps, dir);
      if (r.cleared) ports.cleared(r.cleared);
      return r;
    }
    if (p && p.refused !== undefined) {
      p.drop();
      base = clone(held());
      if (hooks.onRefused) hooks.onRefused(p.refused, dir);
      return { ok: false, reason: p.refused, steps: p.steps };
    }
    if (outcome.kind === "rejected") return { ok: false, reason: outcome.reason };
    return { ok: false, empty: true };
  }

  function settleAfterApply(paragraphStarts?: readonly string[]): void {
    const live = held();
    if (!live || live !== tracked) return;
    if (paragraphStarts) history.initializeParagraphs(paragraphStarts);
    base = clone(live);
  }

  function foldTask(entry: UndoEntry | null | undefined, touches: (step: Step) => boolean, change: (draft: UndoState) => boolean): Replay {
    return {
      name: "fold",
      plan: function (doc): ReplayPlan | CommandRefusal | null {
        const state = asState(doc);
        function hits(e: UndoEntry): boolean { return e.steps.some(touches); }
        const where = history.standing(entry, hits);
        if (where.any && (!where.hit || where.later)) return { refused: "the edit it belongs to is no longer the latest about it" };
        const draft = clone(state);
        if (!change(draft)) return null;
        const steps = diffStates(state, draft);
        if (!steps.length) return null;
        const planned = planSteps(runs, state, steps);
        if (!planned.ok) return { refused: planned.reason };
        return {
          changes: replayChanges(runs, steps, planned),
          apply: function (live) {
            writePlanned(asState(live), planned);
            stamp(asState(live), steps);
          },
          settle: function () {
            let next: UndoState;
            try { next = applySteps(base as UndoState, steps); } catch (e) { next = clone(state); }
            if (where.any) history.amend(entry as UndoEntry, steps.filter(function (s) { return !cosmetic(s); }));
            base = next;
          }
        };
      }
    };
  }

  function foldIntoEdit(entry: UndoEntry | null | undefined, touches: (step: Step) => boolean, change: (draft: UndoState) => boolean): boolean {
    flush();
    const live = held();
    if (!live || live !== tracked || !base) return false;
    let outcome: ReplayOutcome;
    applying = true;
    try {
      outcome = replays.amend(foldTask(entry, touches, change));
    } finally {
      applying = false;
    }
    if (outcome.kind === "failed") throw outcome.error;
    return outcome.kind === "applied" || outcome.kind === "committed";
  }

  function amendTask(fix: RowsFix): Replay {
    return {
      name: "amend-rows",
      plan: function (doc): ReplayPlan | CommandRefusal | null {
        const state = asState(doc);
        const draft = clone(state);
        fix(draft.rows);
        const steps = diffStates(state, draft);
        if (!steps.length) return null;
        const planned = planSteps(runs, state, steps);
        if (!planned.ok) return { refused: planned.reason };
        return {
          changes: replayChanges(runs, steps, planned),
          apply: function (live) { writePlanned(asState(live), planned); },
          settle: function () { base = clone(state); }
        };
      }
    };
  }

  function amendRows(fix: RowsFix): AmendOutcome {
    flush();
    const live = held();
    if (!live || live !== tracked || !base) return "refused";
    let outcome: ReplayOutcome;
    applying = true;
    try {
      outcome = replays.amend(amendTask(fix));
    } finally {
      applying = false;
    }
    if (outcome.kind === "failed") throw outcome.error;
    return outcome.kind === "rejected" ? "refused" : outcome.kind === "noop" ? "unchanged" : "applied";
  }

  function hold(): () => void {
    const epoch = ports.epoch();
    holds.set(epoch, (holds.get(epoch) || 0) + 1);
    let open = true;
    return function () {
      if (!open) return;
      open = false;
      const count = holds.get(epoch) || 0;
      if (count > 1) holds.set(epoch, count - 1);
      else holds.delete(epoch);
    };
  }

  function isHeld(): boolean {
    return holds.has(ports.epoch());
  }

  return {
    configure: configure,
    routeReplays: routeReplays,
    adopt: adopt,
    track: function () { adopt(held()); },
    flush: flush,
    noteEdit: noteEdit,
    noteRemote: noteRemote,
    absorbRemote: absorbRemote,
    reset: function () { restart(held()); },
    undo: function () { return isHeld() ? HELD : run("undo"); },
    redo: function () { return isHeld() ? HELD : run("redo"); },
    settleAfterApply: settleAfterApply,
    foldIntoEdit: foldIntoEdit,
    amendRows: amendRows,
    hold: hold,
    breakCoalescing: function () {
      flush();
      history.breakCoalescing();
    },
    sizes: function () { return history.sizes(); },
    last: function () { flush(); return history.top(); },
    nextRedo: function () { flush(); return history.nextRedo(); },
    lifetime: function () { flush(); return lifetime; },
    mark: function () { flush(); history.breakCoalescing(); return history.mark(); },
    serial: function () { flush(); return history.mark(); },
    compositionMark: function (rowId, key) {
      flush();
      const live = held();
      const rows = (live && live.rows) || [];
      let value: unknown;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && row.id === rowId) value = row[key];
      }
      return history.markCell(rowId, key, value);
    },
    dropEmptySince: function (mark, cancelled) { flush(); return history.dropEmptySince(mark, cancelled); }
  };
}
