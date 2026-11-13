import { projection } from "../text/runs.ts";
import type { Run } from "../text/runs.ts";

export function sharedBufferQueueBytes(): number {
  const SHARED_BUFFER_QUEUE_BYTES = 64 * 1024;
  return SHARED_BUFFER_QUEUE_BYTES;
}

export interface BufferedSplice {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export function bufferedNativeReplacement(before: string, after: string): BufferedSplice | null {
  if (before === after) return null;
  const left = Array.from(before), right = Array.from(after);
  let from = 0, prefix = 0, leftEnd = left.length, rightEnd = right.length;
  while (prefix < leftEnd && prefix < rightEnd && left[prefix] === right[prefix]) { from += (left[prefix] as string).length; prefix++; }
  while (leftEnd > prefix && rightEnd > prefix && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd--; }
  return { from, to: from + left.slice(prefix, leftEnd).join("").length, insert: right.slice(prefix, rightEnd).join("") };
}

function spaceForm(text: string): string {
  return text.indexOf(" ") === -1 ? text : text.replaceAll(" ", " ");
}

export function sameUpToSpaceForm(a: string, b: string): boolean {
  return a === b || a.length === b.length && spaceForm(a) === spaceForm(b);
}

export function foldedNativeSplice(before: string, after: string, from: number, to: number, data: string | null): BufferedSplice | null {
  const inserted = after.length - before.length + to - from;
  if (inserted < 0 || !sameUpToSpaceForm(after.slice(0, from), before.slice(0, from))
    || !sameUpToSpaceForm(after.slice(from + inserted), before.slice(to))) return null;
  const shown = after.slice(from, from + inserted);
  return { from, to, insert: data !== null && sameUpToSpaceForm(data, shown) ? data : shown };
}

export function foldedNativeReplacement(before: string, after: string): BufferedSplice | null {
  const found = bufferedNativeReplacement(spaceForm(before), spaceForm(after));
  return found && { ...found, insert: after.slice(found.from, found.from + found.insert.length) };
}

export function alignSpaceForm(runs: readonly Run[], text: string): readonly Run[] | null {
  let at = 0, changed = false;
  const aligned = runs.map((run): Run => {
    if (run.atom) { at += 1; return run; }
    let next = "";
    for (let index = 0; index < run.text.length; index++) {
      const shown = run.text.charAt(index), wanted = text.charAt(at + index);
      next += shown !== wanted && sameUpToSpaceForm(shown, wanted) ? wanted : shown;
    }
    at += run.text.length;
    if (next === run.text) return run;
    changed = true;
    return { ...run, text: next };
  });
  if (projection(aligned) !== text) return null;
  return changed ? aligned : runs;
}

export interface BufferedCommit {
  readonly base: number;
  readonly text: string;
  readonly splices: readonly BufferedSplice[];
}

export function exceedsBufferQueue(held: number, incoming: number): boolean {
  return held + incoming > sharedBufferQueueBytes();
}

export interface SharedTextBuffer {
  readonly revision: number;
  readonly painted: string;
  readonly text: () => string;
  readonly dirty: () => boolean;
  readonly begin: () => void;
  readonly replace: (from: number, to: number, insert: string) => void;
  readonly plan: () => BufferedCommit;
  readonly commit: () => BufferedCommit;
  readonly cancel: () => void;
}

export function createSharedTextBuffer(revision: number, painted: string): SharedTextBuffer {
  let value = painted, origins: (number | null)[] = Array.from({ length: painted.length }, (_, index) => index), open = false;
  function plan(): BufferedCommit {
    const splices: BufferedSplice[] = [];
    let old = 0, start = 0;
    for (let index = 0; index <= origins.length; index++) {
      const origin = index === origins.length ? painted.length : origins[index];
      if (origin === null || origin === undefined) continue;
      if (origin !== old || index !== start) splices.push({ from: old, to: origin, insert: value.slice(start, index) });
      old = origin + 1;
      start = index + 1;
    }
    return { base: revision, text: value, splices };
  }
  return {
    revision, painted, text: () => value, dirty: () => open, begin: () => { open = true; },
    replace: (from, to, insert) => {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > value.length) {
        throw new RangeError("Native target outside buffered text");
      }
      const nextValue = value.slice(0, from) + insert + value.slice(to);
      const nextOrigins = origins.slice(0, from).concat(Array<null>(insert.length).fill(null), origins.slice(to));
      value = nextValue; origins = nextOrigins; open = true;
    },
    plan,
    commit: () => { const result = plan(); open = false; return result; },
    cancel: () => {
      const restored = Array.from({ length: painted.length }, (_, index) => index);
      value = painted; origins = restored; open = false;
    }
  };
}
