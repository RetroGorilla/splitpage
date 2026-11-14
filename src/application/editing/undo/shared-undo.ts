import { mergeSharedUndoRecords, sharedUndoGroupKey, sharedUndoPartName } from "../../../core/collab/undo-record.ts";
import type { SharedUndoRecord, SharedUndoSelection } from "../../../core/collab/undo-record.ts";
import type { UndoDirection } from "./undo.ts";

export type SharedUndoReversal =
  | { readonly ok: true; readonly effective: boolean; readonly inverse: SharedUndoRecord; readonly selection: SharedUndoSelection | null }
  | { readonly ok: false; readonly reason: string };

export interface SharedUndoPorts {
  readonly reverse: (record: SharedUndoRecord, direction: UndoDirection) => SharedUndoReversal;
  readonly supports: (part: string) => boolean;
  readonly now: () => number;
}

export type SharedUndoOutcome =
  | { readonly ok: true; readonly effective: true; readonly label: string; readonly selection: SharedUndoSelection | null }
  | { readonly ok: true; readonly effective: false; readonly label: string; readonly selection: null; readonly reason: "used-up" }
  | { readonly ok: false; readonly empty: true }
  | { readonly ok: false; readonly reason: string; readonly skipped?: true };

export interface SharedUndoSizes {
  readonly undo: number;
  readonly redo: number;
  readonly dropped: number;
}

export interface SharedUndo {
  readonly perform: (run: () => SharedUndoRecord | null) => void;
  readonly undo: () => SharedUndoOutcome;
  readonly redo: () => SharedUndoOutcome;
  readonly breakGroup: () => void;
  readonly hold: () => () => void;
  readonly reset: () => void;
  readonly sizes: () => SharedUndoSizes;
  readonly skipped: () => number;
  readonly serial: () => number;
  readonly lifetime: () => number;
}

interface SharedUndoEntry {
  record: SharedUndoRecord;
  at: number;
  readonly group: string | null;
  endsInSpace: boolean;
}

const SHARED_COALESCE_MS = 1000;
const SHARED_MAX_ENTRIES = 200;
const NOTHING: SharedUndoOutcome = Object.freeze({ ok: false, empty: true });

// why: rule 71 on #1414: a refusal no later state can lift drops its step; "not now" and other refusals keep it.
function permanent(reason: string): boolean { return reason.startsWith("undo-unsupported:") || reason === "invalid-operation"; }

export function createSharedUndo(ports: SharedUndoPorts): SharedUndo {
  const done: SharedUndoEntry[] = [];
  const undone: SharedUndoEntry[] = [];
  let grouping = false;
  let commanding = false;
  let reversing = false;
  let holds = 0;
  let serial = 0;
  let lifetime = 0;
  let dropped = 0;
  let skipped = 0;

  function push(stack: SharedUndoEntry[], entry: SharedUndoEntry): void {
    stack.push(entry);
    if (stack.length > SHARED_MAX_ENTRIES) {
      stack.shift();
      if (stack === done) dropped++;
    }
  }

  function note(record: SharedUndoRecord): void {
    if (!record.parts.length) return;
    const now = ports.now();
    const group = sharedUndoGroupKey(record);
    const last = done[done.length - 1];
    const typed = record.typing ?? "";
    undone.length = 0;
    serial++;
    if (grouping && group !== null && last && last.group === group && now - last.at < SHARED_COALESCE_MS && !(last.endsInSpace && /\S/.test(typed))) {
      const merged = mergeSharedUndoRecords(last.record, record);
      if (merged) {
        last.record = merged;
        last.at = now;
        if (typed) last.endsInSpace = /\s$/.test(typed);
      } else {
        done.pop();
        grouping = false;
      }
      return;
    }
    push(done, { record: record, at: now, group: group, endsInSpace: /\s$/.test(typed) });
    grouping = true;
  }

  function perform(run: () => SharedUndoRecord | null): void {
    if (commanding || reversing) throw new Error("A shared command cannot start inside another command or an undo");
    let record: SharedUndoRecord | null;
    commanding = true;
    try {
      record = run();
    } finally {
      commanding = false;
    }
    if (record) note(record);
  }

  function step(direction: UndoDirection): SharedUndoOutcome {
    if (commanding) return { ok: false, reason: "command-in-progress" };
    if (reversing) return { ok: false, reason: "undo-in-progress" };
    if (holds) return { ok: false, reason: "held" };
    const from = direction === "undo" ? done : undone;
    const to = direction === "undo" ? undone : done;
    const entry = from[from.length - 1];
    if (!entry) return NOTHING;
    const skip = (reason: string): SharedUndoOutcome => {
      from.pop();
      grouping = false;
      serial++;
      skipped++;
      return { ok: false, reason, skipped: true };
    };
    for (const part of entry.record.parts) {
      const name = sharedUndoPartName(part);
      if (!ports.supports(name)) return skip("undo-unsupported:" + name);
    }
    let reversal: SharedUndoReversal;
    reversing = true;
    try {
      reversal = ports.reverse(entry.record, direction);
    } finally {
      reversing = false;
    }
    if (!reversal.ok) return permanent(reversal.reason) ? skip(reversal.reason) : { ok: false, reason: reversal.reason };
    from.pop();
    grouping = false;
    serial++;
    // why: T21 scalar and T06: an entry whose change is already gone is used up and never reaches an older step;
    // rule 90 on #1414: the outcome says so, so the person is told someone else changed it.
    if (!reversal.effective) return { ok: true, effective: false, label: entry.record.label, selection: null, reason: "used-up" };
    push(to, { record: reversal.inverse, at: entry.at, group: entry.group, endsInSpace: entry.endsInSpace });
    return { ok: true, effective: true, label: entry.record.label, selection: reversal.selection };
  }

  function hold(): () => void {
    holds++;
    let open = true;
    return function () {
      if (!open) return;
      open = false;
      holds--;
    };
  }

  function reset(): void {
    done.length = 0;
    undone.length = 0;
    grouping = false;
    dropped = 0;
    skipped = 0;
    serial++;
    lifetime++;
  }

  return Object.freeze({
    perform: perform,
    undo: function () { return step("undo"); },
    redo: function () { return step("redo"); },
    breakGroup: function () { grouping = false; },
    hold: hold,
    reset: reset,
    sizes: function () { return { undo: done.length, redo: undone.length, dropped: dropped }; },
    skipped: function () { return skipped; },
    serial: function () { return serial; },
    lifetime: function () { return lifetime; }
  });
}
