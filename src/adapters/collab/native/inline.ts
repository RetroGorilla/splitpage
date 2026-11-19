import * as Y from "yjs";
import type { StoredImageRef } from "../../../core/document/text-policy.ts";
import { OBJ, cleanMarks, cleanText, normalizeCell, orderedMarks, sameMarks, tagStack, withTagStack } from "../../../core/text/runs.ts";
import type { Marks, Run } from "../../../core/text/runs.ts";
import { nativeWellFormed } from "./values.ts";

export type NativeAttributes = Record<string, true>;

export interface NativeDeltaItem {
  readonly insert: string | Readonly<Record<string, unknown>>;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface NativePreparedRun {
  readonly insert: string | Readonly<Record<string, string>>;
  readonly length: number;
  readonly plain: NativeAttributes;
  readonly marks: Marks;
  readonly stack: readonly string[];
  readonly atom: boolean;
}

export interface NativeLeft {
  readonly marks: Marks;
  readonly keys: readonly string[];
  readonly atom: boolean;
}

export interface NativeCellView {
  readonly runs: readonly Run[];
  readonly text: string;
  readonly length: number;
  readonly hidden: number;
  readonly unknown: number;
  readonly ends: readonly number[];
  readonly lefts: readonly NativeLeft[];
}

const PLAIN_MARKS = ["b", "i", "u", "s", "hl", "dir", "cue"] as const;
const APPLICATION = "\u001f";
const HIDDEN_CODES = new Map<number, boolean>();

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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value) ?? "undefined";
}

function atomFields(run: Run): string {
  if (!run.atom) return "";
  if (run.atom === "broll") return canonical(["broll", run.id, run.text]);
  if (run.atom === "who") return canonical(["who", run.name, run.text]);
  if (run.atom === "image") return canonical(["image", run.ref]);
  return canonical(["video", run.href, run.host]);
}

function hiddenAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(index + 1); return !(next >= 0xdc00 && next <= 0xdfff); }
  if (code >= 0xdc00 && code <= 0xdfff) { const previous = text.charCodeAt(index - 1); return !(previous >= 0xd800 && previous <= 0xdbff); }
  let hidden = HIDDEN_CODES.get(code);
  if (hidden === undefined) { const unit = text.charAt(index); hidden = cleanText(unit) !== unit; HIDDEN_CODES.set(code, hidden); }
  return hidden;
}

export function nativeTextAllowed(text: string): boolean {
  for (let index = 0; index < text.length; index++) if (hiddenAt(text, index)) return false;
  return true;
}

function plainOf(marks: Marks): NativeAttributes {
  const result: NativeAttributes = {};
  for (const key of PLAIN_MARKS) if (marks[key]) result[key] = true;
  for (const id of marks.cmt ?? []) result["c:" + id] = true;
  if (marks.href) result["l:" + marks.href] = true;
  return result;
}

function embedOf(run: Run): Readonly<Record<string, string>> | null {
  if (run.atom === "broll") return { k: run.id, label: run.text };
  if (run.atom === "who") return { w: run.name };
  if (run.atom === "image") return { img: JSON.stringify(run.ref) };
  if (run.atom === "video") return { video: run.href, host: run.host };
  return null;
}

function cleanAtom(run: Run): Run | null {
  try {
    const clean = normalizeCell([run]);
    const only = clean[0];
    if (clean.length !== 1 || !only?.atom || atomFields(only) !== atomFields(run) || !sameMarks(orderedMarks(run.marks), only.marks)) return null;
    return only;
  } catch { return null; }
}

function keysWellFormed(marks: Marks): boolean {
  return [...tagStack(marks), ...marks.cmt ?? [], ...marks.href === undefined ? [] : [marks.href]].every(nativeWellFormed);
}

// why: a batch is checked whole before anything is written, so a later bad run cannot follow an earlier good one
export function prepareNativeRuns(runs: readonly Run[]): NativePreparedRun[] | null {
  const prepared: NativePreparedRun[] = [];
  for (const run of runs as readonly unknown[]) {
    if (!run || typeof run !== "object") return null;
    const value = run as Run;
    if (value.atom) {
      const clean = cleanAtom(value), embed = clean ? embedOf(clean) : null;
      if (!clean || !embed || !Object.values(embed).every(nativeWellFormed) || !keysWellFormed(clean.marks)) return null;
      prepared.push({ insert: embed, length: 1, plain: plainOf(clean.marks), marks: clean.marks, stack: [], atom: true });
      continue;
    }
    if (typeof value.text !== "string" || !value.marks || typeof value.marks !== "object") return null;
    if (!value.text) continue;
    const marks = orderedMarks(cleanMarks(value.marks, false)), stack = tagStack(marks);
    if (!nativeTextAllowed(value.text) || !sameMarks(marks, orderedMarks(value.marks))) return null;
    if (stack.some(id => !id || id.includes(APPLICATION)) || new Set(stack).size !== stack.length || !keysWellFormed(marks)) return null;
    prepared.push({ insert: value.text, length: value.text.length, plain: plainOf(marks), marks, stack, atom: false });
  }
  return prepared;
}

function clockOf(doc: Y.Doc): number {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;
}

// why: design decision 3: a fresh key per tag application, named by its writer and that writer's clock
function mintKey(doc: Y.Doc, id: string): string {
  return "t:" + id + APPLICATION + doc.clientID.toString(36) + "." + clockOf(doc).toString(36);
}

function chain(marks: Marks, depth: number): string {
  return JSON.stringify([marks.cue ?? false, marks.cmt ?? [], marks.dir ?? false, marks.href ?? "", tagStack(marks).slice(0, depth + 1)]);
}

// why: an application continues only where the cell's HTML keeps that tag element open, so nesting round-trips;
// inner applications that start together are written after the outer one, so their keys carry later clocks
export function writeNativeRuns(doc: Y.Doc, text: Y.Text, index: number, runs: readonly NativePreparedRun[], left: NativeLeft | null): number {
  let at = index, beside = left;
  for (const run of runs) {
    const keys: string[] = [], continued = beside && !beside.atom && !run.atom ? beside : null;
    while (continued && keys.length < run.stack.length && keys.length < continued.keys.length && chain(continued.marks, keys.length) === chain(run.marks, keys.length)) {
      keys.push(continued.keys[keys.length] as string);
    }
    const fresh = run.stack.slice(keys.length), attributes: Record<string, true> = { ...run.plain };
    for (const key of keys) attributes[key] = true;
    if (fresh[0] !== undefined) { const key = mintKey(doc, fresh[0]); keys.push(key); attributes[key] = true; }
    if (typeof run.insert === "string") text.insert(at, run.insert, attributes);
    else text.insertEmbed(at, run.insert, attributes);
    for (const id of fresh.slice(1)) { const key = mintKey(doc, id); keys.push(key); text.format(at, run.length, { [key]: true }); }
    at += run.length;
    beside = { marks: run.marks, keys, atom: run.atom };
  }
  return at;
}

interface Stretch { start: number; end: number }

function applicationOrder(key: string): [number, number] {
  const suffix = key.slice(key.indexOf(APPLICATION) + 1), [client, clock] = suffix.split(".");
  const parsed = [parseInt(client ?? "", 36), parseInt(clock ?? "", 36)] as const;
  return [Number.isFinite(parsed[0]) ? parsed[0] : Infinity, Number.isFinite(parsed[1]) ? parsed[1] : Infinity];
}

function orderKeys(stretches: ReadonlyMap<string, Stretch>): string[] {
  return [...stretches].sort(([leftKey, left], [rightKey, right]) => {
    const [leftClient, leftClock] = applicationOrder(leftKey), [rightClient, rightClock] = applicationOrder(rightKey);
    return left.start - right.start || right.end - left.end || leftClient - rightClient || leftClock - rightClock || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0);
  }).map(([key]) => key);
}

function marksOf(attributes: Readonly<Record<string, unknown>> | undefined, keys: readonly string[], atom: boolean): Marks {
  const marks: Record<string, unknown> = {}, comments: string[] = [], links: string[] = [];
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value !== true) continue;
    if (key.startsWith("c:")) comments.push(key.slice(2));
    else if (key.startsWith("l:")) links.push(key.slice(2));
    else if ((PLAIN_MARKS as readonly string[]).includes(key) && !(atom && (key === "dir" || key === "cue"))) marks[key] = true;
  }
  if (comments.length) marks.cmt = [...new Set(comments)].sort();
  if (links.length) marks.href = links.sort()[0];
  const tags = atom ? [] : [...new Set(keys.map(key => nativeMarkName(key).slice(2)))];
  return orderedMarks(withTagStack(marks as Marks, tags));
}

function atomOf(value: Readonly<Record<string, unknown>>, marks: Marks): Run | null {
  if (typeof value.k === "string" && typeof value.label === "string") return { atom: "broll", id: value.k, text: value.label, marks };
  if (typeof value.w === "string") return { atom: "who", name: value.w, text: "@" + value.w, marks };
  if (typeof value.img === "string") {
    try {
      const ref = JSON.parse(value.img) as unknown;
      return ref && typeof ref === "object" && !Array.isArray(ref) ? { atom: "image", ref: ref as StoredImageRef, text: "", marks } : null;
    } catch { return null; }
  }
  if (typeof value.video === "string" && typeof value.host === "string") return { atom: "video", href: value.video, host: value.host, text: "", marks };
  return null;
}

interface ItemView { readonly run: Run | null; readonly keys: readonly string[]; readonly start: number; readonly shown: readonly number[]; readonly unknown: boolean }

function itemViews(items: readonly NativeDeltaItem[]): ItemView[] {
  const perItem: Map<string, Stretch>[] = [];
  let open = new Map<string, Stretch>(), offset = 0;
  for (const item of items) {
    const length = nativeItemLength(item), next = new Map<string, Stretch>();
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
  offset = 0;
  return items.map((item, index) => {
    const start = offset, keys = orderKeys(perItem[index] ?? new Map<string, Stretch>());
    offset += nativeItemLength(item);
    if (typeof item.insert === "string") {
      const shown: number[] = [];
      let kept = "";
      for (let at = 0; at < item.insert.length; at++) if (!hiddenAt(item.insert, at)) { shown.push(at); kept += item.insert.charAt(at); }
      return { run: kept ? { text: kept, marks: marksOf(item.attributes, keys, false) } : null, keys, start, shown, unknown: false };
    }
    const atom = atomOf(item.insert, marksOf(item.attributes, [], true)), clean = atom ? cleanAtom(atom) : null;
    return { run: clean, keys: [], start, shown: clean ? [0] : [], unknown: !atom };
  });
}

function merged(views: readonly ItemView[]): Run[] {
  const runs: Run[] = [];
  for (const view of views) {
    const run = view.run, last = runs.at(-1);
    if (!run) continue;
    if (last && !last.atom && !run.atom && sameMarks(last.marks, run.marks)) runs[runs.length - 1] = { text: last.text + run.text, marks: last.marks };
    else runs.push(run);
  }
  return normalizeCell(runs);
}

export function nativeRunsOf(items: readonly NativeDeltaItem[]): Run[] {
  return merged(itemViews(items));
}

export function nativeCellView(items: readonly NativeDeltaItem[]): NativeCellView {
  const views = itemViews(items), ends: number[] = [], lefts: NativeLeft[] = [];
  let text = "", hidden = 0, unknown = 0;
  for (const [index, view] of views.entries()) {
    const stored = items[index], length = stored ? nativeItemLength(stored) : 0;
    hidden += length - view.shown.length;
    if (view.unknown) unknown++;
    if (!view.run) continue;
    const left: NativeLeft = { marks: view.run.marks, keys: view.keys, atom: !!view.run.atom };
    for (const at of view.shown) { ends.push(view.start + at + 1); lefts.push(left); }
    text += view.run.atom ? OBJ : view.run.text;
  }
  return { runs: merged(views), text, length: ends.length, hidden, unknown, ends, lefts };
}

export function nativeStoredOffset(view: NativeCellView, shown: number): number {
  return shown > 0 ? view.ends[shown - 1] ?? 0 : 0;
}

export function nativeLeftAt(view: NativeCellView, stored: number): NativeLeft | null {
  let low = 0, high = view.ends.length;
  while (low < high) { const middle = (low + high) >> 1; if ((view.ends[middle] ?? 0) <= stored) low = middle + 1; else high = middle; }
  return low > 0 ? view.lefts[low - 1] ?? null : null;
}

export function nativeUnitCounts(items: readonly NativeDeltaItem[]): { readonly hidden: number; readonly unknown: number } {
  const view = nativeCellView(items);
  return { hidden: view.hidden, unknown: view.unknown };
}
