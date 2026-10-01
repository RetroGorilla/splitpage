import { DEFAULT_WPM, hasSetLength } from "../document/timing.ts";
import type { LengthHolder } from "../document/timing.ts";
import type { FieldHtml, ProductionReaders } from "./ports.ts";

export type TimedRow = LengthHolder & { audioText?: FieldHtml };

export type TimingState = { wordsPerMinute?: number | null | undefined; rows: readonly TimedRow[] };

export type TargetClock = { target: string; delta: string; over: boolean };

type WordCounter = Pick<ProductionReaders, "wordCount">;

export function pad2(n: number): string { return n < 10 ? "0" + n : "" + n; }

export function estimatedSeconds(row: TimedRow, state: TimingState | null | undefined, readers: WordCounter): number {
  const wpm = (state && state.wordsPerMinute) || DEFAULT_WPM;
  return readers.wordCount(row.audioText) / wpm * 60;
}

export function rowSeconds(row: TimedRow, state: TimingState | null | undefined, readers: WordCounter): number {
  return hasSetLength(row) ? row.lengthSeconds : estimatedSeconds(row, state, readers);
}

export function totalSeconds(state: TimingState, readers: WordCounter): number {
  return state.rows.reduce(function (n, r) { return n + rowSeconds(r, state, readers); }, 0);
}

export function formatDuration(sec: number): string {
  const whole = Math.max(0, Math.round(sec));
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return h ? (h + ":" + pad2(m) + ":" + pad2(s)) : (m + ":" + pad2(s));
}

export function formatTimecode(sec: number): string {
  const whole = Math.max(0, Math.round(sec));
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return (h ? h + ":" : "") + pad2(m) + ":" + pad2(s);
}

export function targetClock(total: number, target: number): TargetClock {
  const diff = Math.round(target) - Math.max(0, Math.round(total));
  return {
    target: formatDuration(target),
    delta: formatDuration(Math.abs(diff)),
    over: diff < 0
  };
}
