import { flowBaseReference } from "./base-reference.ts";
import type { SharedContentRef, SharedMarkChange, SharedTextAddress } from "./operations.ts";
import { explode } from "../text/edits.ts";
import type { Char } from "../text/edits.ts";
import type { Run } from "../text/runs.ts";

export interface SharedCommentUnwrap {
  readonly owner: string;
  readonly field: SharedTextAddress["field"];
  readonly before: readonly Run[];
  readonly after: readonly Run[];
}
export type SharedCommentMarkRemovals = { readonly operations: readonly Omit<SharedMarkChange, "id" | "by">[] } | { readonly refused: string };

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]));
}

function rest(char: Char): string {
  if ("atom" in char && char.atom) return JSON.stringify(sorted(char.atom));
  const text = char as { readonly ch: string; readonly marks?: Readonly<Record<string, unknown>> };
  const marks = Object.fromEntries(Object.entries(text.marks ?? {}).filter(([key]) => key !== "cmt"));
  return JSON.stringify([text.ch, sorted(marks)]);
}

function anchors(char: Char): readonly string[] {
  return "atom" in char && char.atom ? [] : (char as { readonly marks?: { readonly cmt?: readonly string[] } }).marks?.cmt ?? [];
}

export function sharedCommentMarkRemovals(unwraps: readonly SharedCommentUnwrap[]): SharedCommentMarkRemovals {
  const operations: Omit<SharedMarkChange, "id" | "by">[] = [];
  for (const unwrap of unwraps) {
    const before = explode(unwrap.before), after = explode(unwrap.after);
    if (before.length !== after.length) return { refused: "comment-unwrap-rewrite" };
    const removed = new Map<string, number[]>();
    for (let offset = 0; offset < before.length; offset++) {
      const was = before[offset] as Char, now = after[offset] as Char;
      if (rest(was) !== rest(now) || anchors(now).some(anchor => !anchors(was).includes(anchor))) return { refused: "comment-unwrap-rewrite" };
      for (const anchor of anchors(was)) if (!anchors(now).includes(anchor)) removed.set(anchor, [...removed.get(anchor) ?? [], offset]);
    }
    for (const [anchor, offsets] of [...removed].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const observed: SharedContentRef[] = [];
      for (let i = 0; i < offsets.length;) {
        let end = i + 1;
        while (end < offsets.length && offsets[end] === (offsets[i] as number) + end - i) end++;
        observed.push(flowBaseReference(unwrap.owner, unwrap.field, offsets[i] as number, (offsets[i] as number) + end - i));
        i = end;
      }
      operations.push({ kind: "mark", target: { owner: unwrap.owner as SharedContentRef, segment: unwrap.owner as SharedContentRef, field: unwrap.field }, observed,
        mark: { kind: "comment", id: anchor as SharedContentRef, value: null } });
    }
  }
  return { operations };
}
