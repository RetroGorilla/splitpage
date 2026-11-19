import * as Y from "yjs";
import type { StoredImageRef } from "../../../core/document/text-policy.ts";
import { orderedMarks, sameMarks, tagStack, withTagStack } from "../../../core/text/runs.ts";
import type { Marks, Run } from "../../../core/text/runs.ts";

export type NativeAttributes = Record<string, true>;

export interface NativeDeltaItem {
  readonly insert: string | Readonly<Record<string, unknown>>;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

const PLAIN_MARKS = ["b", "i", "u", "s", "hl", "dir", "cue"] as const;
const APPLICATION = "\u001f";

export function nativeMarkName(key: string): string {
  const at = key.indexOf(APPLICATION);
  return at < 0 ? key : key.slice(0, at);
}

export function nativeBlockOf(insert: unknown): string | null {
  if (!insert || typeof insert !== "object") return null;
  const value = insert as Record<string, unknown>;
  if (typeof value.b === "string") return "b:" + value.b;
  return typeof value.h === "string" ? "h:" + value.h : null;
}

export function nativeItemLength(item: NativeDeltaItem): number {
  return typeof item.insert === "string" ? item.insert.length : 1;
}

function embedOf(run: Run): Record<string, unknown> | null {
  if (run.atom === "broll") return { k: run.id, label: run.text };
  if (run.atom === "who") return { w: run.name };
  if (run.atom === "image") return { img: { ...run.ref } };
  if (run.atom === "video") return { video: run.href, host: run.host };
  return null;
}

function tagKeyFor(doc: Y.Doc, id: string, beside: Readonly<Record<string, unknown>> | null): string {
  const name = "t:" + id;
  for (const [key, value] of Object.entries(beside ?? {})) if (value === true && nativeMarkName(key) === name) return key;
  // why: design decision 3: a fresh key per tag application, named by its writer and that writer's clock
  return name + APPLICATION + doc.clientID.toString(36) + "." + Y.getState(doc.store, doc.clientID).toString(36);
}

export function nativeAttributesOf(doc: Y.Doc, marks: Marks, beside: Readonly<Record<string, unknown>> | null): NativeAttributes {
  const result: NativeAttributes = {};
  for (const key of PLAIN_MARKS) if (marks[key]) result[key] = true;
  for (const id of marks.cmt ?? []) result["c:" + id] = true;
  if (marks.href) result["l:" + marks.href] = true;
  for (const id of tagStack(marks)) result[tagKeyFor(doc, id, beside)] = true;
  return result;
}

export function writeNativeRuns(doc: Y.Doc, text: Y.Text, index: number, runs: readonly Run[], left: Readonly<Record<string, unknown>> | null): number {
  let beside = left, at = index;
  for (const run of runs) {
    const embed = embedOf(run), attributes = nativeAttributesOf(doc, run.marks, beside);
    if (embed) { text.insertEmbed(at, embed, attributes); at += 1; }
    else if (run.text) { text.insert(at, run.text, attributes); at += run.text.length; }
    else continue;
    beside = attributes;
  }
  return at;
}

interface TagStretch { start: number; end: number }

function marksOf(attributes: Readonly<Record<string, unknown>> | undefined, stretches: ReadonlyMap<string, TagStretch>, atom: boolean): Marks {
  const marks: Record<string, unknown> = {}, comments: string[] = [], links: string[] = [];
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value !== true) continue;
    const name = nativeMarkName(key);
    if (name.startsWith("c:")) comments.push(name.slice(2));
    else if (name.startsWith("l:")) links.push(name.slice(2));
    else if ((PLAIN_MARKS as readonly string[]).includes(name) && !(atom && (name === "dir" || name === "cue"))) marks[name] = true;
  }
  if (comments.length) marks.cmt = [...new Set(comments)].sort();
  if (links.length) marks.href = links.sort()[0];
  const ordered = [...stretches].sort(([leftKey, left], [rightKey, right]) =>
    left.start - right.start || right.end - left.end || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0));
  const tags = atom ? [] : [...new Set(ordered.map(([key]) => nativeMarkName(key).slice(2)))];
  return orderedMarks(withTagStack(marks as Marks, tags));
}

function runOf(item: NativeDeltaItem, marks: Marks): Run | null {
  if (typeof item.insert === "string") return { text: item.insert, marks };
  const value = item.insert;
  if (typeof value.k === "string") return { atom: "broll", id: value.k, text: typeof value.label === "string" ? value.label : "", marks };
  if (typeof value.w === "string") return { atom: "who", name: value.w, text: "@" + value.w, marks };
  if (value.img && typeof value.img === "object") return { atom: "image", ref: { ...(value.img as StoredImageRef) }, text: "", marks };
  if (typeof value.video === "string") return { atom: "video", href: value.video, host: typeof value.host === "string" ? value.host : "", text: "", marks };
  return null;
}

// why: nested tags read outer first: the application whose stretch starts earlier, or ends later, holds the other
export function nativeRunsOf(items: readonly NativeDeltaItem[]): Run[] {
  const runs: Run[] = [];
  let open = new Map<string, TagStretch>(), offset = 0;
  const perItem: Map<string, TagStretch>[] = [];
  for (const item of items) {
    const length = nativeItemLength(item), next = new Map<string, TagStretch>();
    for (const [key, value] of Object.entries(item.attributes ?? {})) {
      if (value !== true || !key.startsWith("t:")) continue;
      const stretch = open.get(key) ?? { start: offset, end: offset };
      stretch.end = offset + length;
      next.set(key, stretch);
    }
    perItem.push(next);
    open = next;
    offset += length;
  }
  items.forEach((item, index) => {
    const run = runOf(item, marksOf(item.attributes, perItem[index] ?? new Map(), typeof item.insert !== "string"));
    if (!run) return;
    const last = runs.at(-1);
    if (last && !last.atom && !run.atom && sameMarks(last.marks, run.marks)) runs[runs.length - 1] = { text: last.text + run.text, marks: last.marks };
    else runs.push(run);
  });
  return runs;
}
