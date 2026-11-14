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
export interface SharedCommentCell {
  readonly owner: string;
  readonly field: SharedTextAddress["field"];
  readonly runs: readonly Run[];
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]));
}

function withoutAnchors(marks: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(marks ?? {}).filter(([key]) => key !== "cmt"));
}

function rest(char: Char): string {
  if ("atom" in char && char.atom) return JSON.stringify(sorted({ ...char.atom, marks: withoutAnchors(char.atom.marks) }));
  const text = char as { readonly ch: string; readonly marks?: Readonly<Record<string, unknown>> };
  return JSON.stringify([text.ch, sorted(withoutAnchors(text.marks))]);
}

function anchors(char: Char): readonly string[] {
  const marks = ("atom" in char && char.atom ? char.atom.marks : (char as { readonly marks?: unknown }).marks) as { readonly cmt?: readonly string[] } | undefined;
  return marks?.cmt ?? [];
}

export function sharedCommentRewriteRefused(anchor: string, unwraps: readonly SharedCommentUnwrap[]): boolean {
  return unwraps.some(unwrap => {
    const before = explode(unwrap.before), after = explode(unwrap.after);
    return before.length !== after.length || before.some((was, offset) => {
      const now = after[offset] as Char;
      return rest(was) !== rest(now) || anchors(now).some(id => !anchors(was).includes(id)) || anchors(was).some(id => id !== anchor && !anchors(now).includes(id));
    });
  });
}

export function sharedCommentMarkRemovals(anchor: string, cells: readonly SharedCommentCell[]): readonly Omit<SharedMarkChange, "id" | "by">[] {
  const operations: Omit<SharedMarkChange, "id" | "by">[] = [];
  for (const cell of cells) {
    const offsets = explode(cell.runs).flatMap((char, offset) => anchors(char).includes(anchor) ? [offset] : []);
    if (!offsets.length) continue;
    const observed: SharedContentRef[] = [];
    for (let i = 0; i < offsets.length;) {
      let end = i + 1;
      while (end < offsets.length && offsets[end] === (offsets[i] as number) + end - i) end++;
      observed.push(flowBaseReference(cell.owner, cell.field, offsets[i] as number, (offsets[i] as number) + end - i));
      i = end;
    }
    operations.push({ kind: "mark", target: { owner: cell.owner as SharedContentRef, segment: cell.owner as SharedContentRef, field: cell.field }, observed,
      mark: { kind: "comment", id: anchor as SharedContentRef, value: null } });
  }
  return operations;
}
