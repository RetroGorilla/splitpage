import { normalizeCell } from "../../core/text/runs.ts";
import type { HtmlRunDecoder } from "../../application/editing/undo/history.ts";

interface CellStep {
  readonly before?: unknown;
  readonly after?: unknown;
}

export function caretAfterStep(decode: HtmlRunDecoder, step: CellStep): number {
  function domChars(h: unknown): { text: string; keys: string[] } {
    let text = "";
    const keys: string[] = [];
    normalizeCell(decode(h == null ? "" : h)).forEach(function (r) {
      const t = r.text.replace(/\n/g, "");
      const key = (r.atom ? r.atom + ":" + String((r as { readonly id?: unknown }).id) : "") + JSON.stringify(r.marks || {});
      for (let i = 0; i < t.length; i++) keys.push(t[i] + key);
      text += t;
    });
    return { text: text, keys: keys };
  }
  const a = domChars(step.before).keys, bc = domChars(step.after), b = bc.text, bk = bc.keys;
  let s = 0;
  while (s < a.length && s < bk.length && a[a.length - 1 - s] === bk[bk.length - 1 - s]) s++;
  let offset = b.length - s;
  if (offset > 0 && offset < b.length) {
    const hi = b.charCodeAt(offset - 1), lo = b.charCodeAt(offset);
    if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) offset--;
  }
  return offset;
}

export interface ReplayStep {
  readonly op?: string;
  readonly rowId?: string;
  readonly key?: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface PlacedReplayStep extends ReplayStep {
  readonly rowId: string;
  readonly key: string;
}

export type ReplayPlacement<R> =
  | { readonly kind: "recorded"; readonly range: R }
  | { readonly kind: "step"; readonly step: PlacedReplayStep }
  | null;

export interface ReplayInput<R> {
  readonly surface: "writer" | "cells";
  readonly dir: "undo" | "redo";
  readonly recorded: { readonly before: R; readonly after: R } | null;
  readonly steps: readonly unknown[];
  readonly rowExists?: (rowId: string) => boolean;
}

// why: the Writer restores a recorded selection or measures its first narration step; a cell its first text step
export function replayPlacement<R>(input: ReplayInput<R>): ReplayPlacement<R> {
  const steps = input.steps as readonly ReplayStep[];
  if (input.surface === "writer") {
    if (input.recorded) return { kind: "recorded", range: input.dir === "undo" ? input.recorded.before ?? input.recorded.after : input.recorded.after };
    const step = steps.find(item => item.op === "rowField" && item.key === "audioText");
    return step && step.rowId ? { kind: "step", step: step as PlacedReplayStep } : null;
  }
  let cell: PlacedReplayStep | null = null;
  for (const step of steps) {
    if (step.op !== "rowField" || !input.rowExists?.(step.rowId as string)) continue;
    if (!cell && (step.key === "visualText" || step.key === "audioText")) cell = step as PlacedReplayStep;
  }
  return cell ? { kind: "step", step: cell } : null;
}
