import type * as Y from "yjs";

export type PaintedUnit = string | Readonly<Record<string, unknown>>;
export type ScreenUnit = { readonly painted: number } | { readonly local: string };

export interface LocalRun { readonly anchor: number; readonly text: string }
export interface LocalPlan { readonly runs: readonly LocalRun[]; readonly deleted: readonly number[] }
export type CommitStatus = "written" | "unchanged" | "moved" | "recovery";
export interface CommitOutcome { readonly status: CommitStatus; readonly text: string }

interface DocUnit { readonly painted: number | null; live: boolean }
type Entry = { readonly painted: number; deleted: boolean } | { readonly local: string };
interface DeltaStep { insert?: unknown; retain?: number; delete?: number }
interface TextOp { at: number; order: number; insert?: string }

const high = (unit: string | undefined): boolean => unit !== undefined && unit.length === 1 && unit.charCodeAt(0) >= 0xd800 && unit.charCodeAt(0) <= 0xdbff;

export function paintedUnits(text: Y.Text): PaintedUnit[] {
  const units: PaintedUnit[] = [];
  for (const step of text.toDelta() as { insert: unknown }[]) {
    if (typeof step.insert === "string") units.push(...step.insert.split(""));
    else units.push(step.insert as Readonly<Record<string, unknown>>);
  }
  return units;
}

export function applyOps(text: Y.Text, ops: TextOp[]): void {
  ops.sort((a, b) => a.at - b.at || a.order - b.order);
  let shift = 0, deleteAt = -1, deleteCount = 0;
  for (const op of ops) {
    if (op.insert !== undefined) {
      if (deleteCount > 0) text.delete(deleteAt, deleteCount);
      deleteCount = 0;
      text.insert(op.at + shift, op.insert);
      shift += op.insert.length;
      continue;
    }
    const at = op.at + shift;
    if (deleteCount > 0 && deleteAt === at) deleteCount++;
    else {
      if (deleteCount > 0) text.delete(deleteAt, deleteCount);
      deleteAt = at; deleteCount = 1;
    }
    shift--;
  }
  if (deleteCount > 0) text.delete(deleteAt, deleteCount);
}

// why: the composing cell's screen stays as painted while the document takes remote updates at once (owner rule T04);
// every delta is folded into the painted units the way y-codemirror.next's observer turns a delta into editor changes
export class Composition {
  readonly text: Y.Text;
  readonly painted: readonly PaintedUnit[];
  private readonly units: DocUnit[];
  private readonly entries: Entry[];
  private readonly observer: (event: Y.YTextEvent) => void;
  private readonly locate: () => Y.Text | undefined;
  private open = true;
  folded = 0;

  constructor(text: Y.Text, locate: () => Y.Text | undefined = () => text) {
    this.text = text;
    this.locate = locate;
    this.painted = paintedUnits(text);
    this.units = this.painted.map((_, index) => ({ painted: index, live: true }));
    this.entries = this.painted.map((_, index) => ({ painted: index, deleted: false }));
    this.observer = event => { this.folded++; this.fold(event.delta as DeltaStep[]); };
    text.observe(this.observer);
  }

  private fold(delta: readonly DeltaStep[]): void {
    let at = 0;
    for (const step of delta) {
      if (step.retain !== undefined) {
        let count = step.retain;
        while (count > 0) { if (this.unit(at).live) count--; at++; }
      } else if (step.delete !== undefined) {
        let count = step.delete;
        while (count > 0) {
          while (!this.unit(at).live) at++;
          this.unit(at).live = false; at++; count--;
        }
      } else if (step.insert !== undefined) {
        const length = typeof step.insert === "string" ? step.insert.length : 1;
        this.units.splice(at, 0, ...Array.from({ length }, () => ({ painted: null, live: true })));
        at += length;
      }
    }
  }

  private unit(at: number): DocUnit {
    const unit = this.units[at];
    if (unit === undefined) throw new Error("delta runs past the folded units");
    return unit;
  }

  screen(): ScreenUnit[] {
    return this.entries.flatMap<ScreenUnit>(entry => "local" in entry ? [{ local: entry.local }] : entry.deleted ? [] : [{ painted: entry.painted }]);
  }

  private entryAt(screenIndex: number): number {
    let seen = 0;
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index] as Entry;
      if ("painted" in entry && entry.deleted) continue;
      if (seen === screenIndex) return index;
      seen++;
    }
    throw new Error(`screen index ${screenIndex} out of range`);
  }

  private screenUnit(screen: readonly ScreenUnit[], index: number): string | undefined {
    const unit = screen[index];
    if (unit === undefined) return undefined;
    if ("local" in unit) return unit.local;
    const painted = this.painted[unit.painted];
    return typeof painted === "string" ? painted : undefined;
  }

  private assertBoundary(screen: readonly ScreenUnit[], at: number): void {
    if (at < 0 || at > screen.length) throw new Error(`screen index ${at} out of range`);
    if (high(this.screenUnit(screen, at - 1))) throw new Error(`screen index ${at} cuts a surrogate pair`);
  }

  insert(at: number, text: string): void {
    this.assertOpen();
    this.assertBoundary(this.screen(), at);
    const position = at === 0 ? 0 : this.entryAt(at - 1) + 1;
    this.entries.splice(position, 0, ...text.split("").map(local => ({ local })));
  }

  delete(from: number, to: number): void {
    this.assertOpen();
    const screen = this.screen();
    this.assertBoundary(screen, from);
    this.assertBoundary(screen, to);
    const doomed = Array.from({ length: to - from }, (_, offset) => this.entryAt(from + offset));
    for (const index of doomed.sort((a, b) => b - a)) {
      const entry = this.entries[index] as Entry;
      if ("local" in entry) this.entries.splice(index, 1); else entry.deleted = true;
    }
  }

  replace(from: number, to: number, text: string): void {
    this.delete(from, to);
    this.insert(from, text);
  }

  plan(): LocalPlan {
    const runs: LocalRun[] = [], deleted: number[] = [];
    let anchor = -1, run = "";
    for (const entry of this.entries) {
      if ("local" in entry) { run += entry.local; continue; }
      if (run) runs.push({ anchor, text: run });
      run = "";
      anchor = entry.painted;
      if (entry.deleted) deleted.push(entry.painted);
    }
    if (run) runs.push({ anchor, text: run });
    return { runs, deleted };
  }

  liveUnits(): number {
    return this.units.filter(unit => unit.live).length;
  }

  private assertOpen(): void {
    if (!this.open) throw new Error("composition already ended");
  }

  private close(): void {
    this.assertOpen();
    this.text.unobserve(this.observer);
    this.open = false;
  }

  cancel(): void {
    this.close();
  }

  // why: Yjs deletes items integrated into a deleted type, so a write through a stale cell reference vanishes silently;
  // the cell is looked up again by its owner's id and the text goes to the live cell or back to the caller
  commit(origin: unknown): CommitOutcome {
    const plan = this.plan();
    this.close();
    const typed = plan.runs.map(run => run.text).join(""), live = this.locate();
    if (live !== this.text) {
      if (live === undefined || typed === "") return { status: "recovery", text: typed };
      live.doc?.transact(() => live.insert(live.length, typed), origin);
      return { status: "moved", text: typed };
    }
    const position = new Map<number, number>();
    this.units.forEach((unit, index) => { if (unit.painted !== null) position.set(unit.painted, index); });
    const liveBefore = (end: number): number => this.units.slice(0, end).filter(unit => unit.live).length;
    const ops: TextOp[] = plan.runs.map((run, order) => ({ at: run.anchor < 0 ? 0 : liveBefore((position.get(run.anchor) ?? 0) + 1), order, insert: run.text }));
    for (const painted of plan.deleted) {
      const index = position.get(painted) ?? -1;
      if (this.units[index]?.live) ops.push({ at: liveBefore(index), order: Number.MAX_SAFE_INTEGER });
    }
    if (ops.length === 0) return { status: "unchanged", text: typed };
    this.text.doc?.transact(() => applyOps(this.text, ops), origin);
    return { status: "written", text: typed };
  }
}
