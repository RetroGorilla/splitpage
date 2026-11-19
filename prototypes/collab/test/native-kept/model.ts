import { settle } from "../native-chosen/ledger.ts";
import type { LedgerEvent } from "../native-chosen/ledger.ts";
import { need } from "../native-delete/model.ts";

export type KeepProbe =
  | "cut" | "undoCut" | "redoCut" | "visual" | "status" | "lens"
  | "visualTag" | "audioTag" | "move" | "create" | "undoCreate" | "newAudio" | "newVisual" | "newStatus" | "rename" | "typeA" | "typeC";

export type ProbeStep = { by: number; op: KeepProbe } | { from: number; to: number };

export interface ProbeState {
  rows: string[];
  removed: string[];
  fields: Record<string, string>;
  visual: string | null;
  visualTag: boolean;
  audioTag: boolean | null;
  rank: boolean;
  createdVisual: string | null;
  createdStatus: string | null;
}

export interface KeepHistory {
  steps: ProbeStep[];
  glyph: string;
  shape: "never undone" | "undo offline" | "undo after move" | "redo" | "two cuts" | "double undo" | "creation undo" | "insert undo" | "heading undo";
}

export function probeHistory(seed: number): KeepHistory {
  const shapes = ["never undone", "undo offline", "undo after move", "redo", "two cuts", "double undo", "creation undo", "insert undo", "heading undo"] as const;
  const shape = need(shapes[seed % shapes.length], "probe shape");
  const glyph = String.fromCharCode(0x400 + seed), edit: KeepProbe[] = ["visual", "status", "lens", "visualTag", "audioTag", "move"];
  const bias = Math.floor(seed / 8) % edit.length;
  const edits = [...edit.slice(bias), ...edit.slice(0, bias)].map(op => ({ by: 1, op }));
  const a = (op: KeepProbe): ProbeStep => ({ by: 0, op });
  const b = (op: KeepProbe): ProbeStep => ({ by: 1, op });
  const toA: ProbeStep = { from: 1, to: 0 }, toB: ProbeStep = { from: 0, to: 1 };
  const cutFirst = (Math.floor(seed / 16) % 2) === 0;
  const noise = seed % 16 < 8 ? [] : Array.from({ length: 12 + seed % 5 }, (_, index) => b(index % 2 === 0 ? "typeA" : "typeC"));
  const offline = cutFirst ? [a("cut"), ...edits] : [...edits, a("cut")];
  const crossing = [...offline, ...noise];
  switch (shape) {
    case "never undone": return { shape, glyph, steps: crossing };
    case "undo offline": return { shape, glyph, steps: [...crossing, a("undoCut")] };
    case "undo after move": return { shape, glyph, steps: [...crossing, toA, a("undoCut")] };
    case "redo": return { shape, glyph, steps: [a("cut"), a("undoCut"), ...edits, ...noise, toA, a("redoCut")] };
    case "two cuts": return { shape, glyph, steps: [a("cut"), b("cut"), ...(cutFirst ? [toA] : []), a("undoCut")] };
    case "double undo": return { shape, glyph, steps: [a("cut"), b("cut"), a("undoCut"), ...(cutFirst ? [toB] : []), b("undoCut")] };
    case "creation undo": case "insert undo":
      return { shape, glyph, steps: [a("create"), toB, b("newVisual"), b("newStatus"), b("newAudio"), a("undoCreate")] };
    case "heading undo": return { shape, glyph, steps: [a("create"), toB, b("rename"), a("undoCreate")] };
  }
}

interface Action {
  op: KeepProbe;
  seen: ReadonlySet<number>;
  by: number;
}

// why: the earlier ledger kills the cell along with the beat version. Kept cells are accounted for separately,
// so the ledger handles narration and beat versions only. No stored or shown values are inputs.
export class KeptProbeModel {
  private readonly actions = new Map<number, Action>();
  private readonly known = [new Set<number>(), new Set<number>()];
  private readonly history: KeepHistory;
  private readonly keep: boolean;

  constructor(history: KeepHistory, keep: boolean) {
    this.history = history;
    this.keep = keep;
  }

  step(step: ProbeStep, index: number): void {
    if ("from" in step) {
      for (const key of need(this.known[step.from], "sending copy")) need(this.known[step.to], "receiving copy").add(key);
      return;
    }
    const known = need(this.known[step.by], "acting copy");
    this.actions.set(index, { op: step.op, seen: new Set(known), by: step.by });
    known.add(index);
  }

  expected(peer?: number): ProbeState {
    const known = peer === undefined ? new Set(this.actions.keys()) : need(this.known[peer], "copy");
    const actions = [...this.actions].filter(([index]) => known.has(index));
    const has = (op: KeepProbe): boolean => actions.some(([, action]) => action.op === op);
    const last = (op: KeepProbe): [number, Action] | undefined => actions.findLast(([, action]) => action.op === op);
    const cuts = actions.filter(([, action]) => action.op === "cut");
    const restorations = new Map<number, number>();
    const events: LedgerEvent[] = [];
    const newHeading = this.history.shape === "heading undo", inserted = this.history.shape === "insert undo";
    const creation = inserted || newHeading || this.history.shape === "creation undo";
    for (const [index, { by, op, seen }] of actions) {
      const cut = cuts.findLast(([other, action]) => other < index && by === action.by)?.[0] ?? null;
      if (op === "undoCut" && cut !== null) restorations.set(cut, index);
      events.push({
        index, by, op, seen, typed: [], erased: op === "cut" ? [..."def"] : [], deletedBeats: op === "cut" ? ["B"] : [],
        seenVisual: [], createdBeats: op === "create" && !newHeading ? ["N"] : [],
        createdSegment: inserted && op === "create", createdHeading: op === "create" && newHeading ? { id: "J", standalone: true } : null,
        fieldSet: null, reverts: op === "undoCut" ? cut : op === "undoCreate" ? last("create")?.[0] ?? null : null,
        redoes: op === "redoCut" && cut !== null ? restorations.get(cut) ?? null : null, skipped: []
      });
    }
    const narration = settle(events, [..."def"].map(char => ({ char, field: "audio", owner: "B" })), ["A", "B", "C"]);
    const live = narration.beatsAlive.has("B");
    const words = "def".repeat(narration.alive.get("d")?.count ?? 0);
    const removed = cuts.length > 0 && !live;
    const cellExists = this.keep || !removed;
    const contentKept = this.keep || !cuts.length;
    const restored = last("undoCut");
    const overwritten = (op: KeepProbe): boolean => {
      const index = last(op)?.[0];
      return !this.keep && restored !== undefined && index !== undefined && restored[1].seen.has(index);
    };
    const rank = cellExists && !overwritten("move");
    const fields: Record<string, string> = {};
    if (cellExists && !overwritten("status")) fields.status = contentKept && has("status") ? "ready" : "todo";
    if (cellExists && !overwritten("lens")) fields.lens = contentKept && has("lens") ? "wide" : "normal";
    const visual = cellExists ? `2${contentKept && has("visual") ? this.history.glyph : ""}` : null;
    const visualTag = contentKept && has("visualTag");
    const tag = last("audioTag");
    const audioTag = !live || !tag ? false : !cuts.length ? true : restored?.[1].seen.has(tag[0]) ? null : false;
    const typed = (op: KeepProbe): number => actions.filter(([, action]) => action.op === op).length;
    const rowB = `B: ${words} / ${visual}`;
    const extra = has("newAudio") ? "Z" : "";
    const joinedTail = !inserted && has("undoCreate") ? extra : "";
    const rows = [`A: a${"β".repeat(typed("typeA"))}b${joinedTail}c / 1`, `C: g${"γ".repeat(typed("typeC"))}hi / 3`, "#H title"];
    if (live) rows.splice(contentKept && has("move") ? 3 : 1, 0, rowB);
    const exists = creation && has("create") && !has("undoCreate");
    if (exists && newHeading) rows.splice(2, 0, `#J draft${has("rename") ? this.history.glyph : ""}`);
    if (exists && !newHeading) {
      const at = rows.findIndex(row => row.startsWith("A:"));
      const row = `N: ${inserted ? `q${extra}r` : `b${extra}c`} / ${has("newVisual") ? this.history.glyph : ""}`;
      if (inserted) rows.splice(at, 0, row); else rows.splice(at, 1, "A: a / 1", row);
    }
    return {
      rows, removed: removed && this.keep ? ["B"] : [], fields, visual, visualTag, audioTag, rank,
      createdVisual: exists && !newHeading ? has("newVisual") ? this.history.glyph : "" : null,
      createdStatus: exists && has("newStatus") ? "ready" : null
    };
  }
}
