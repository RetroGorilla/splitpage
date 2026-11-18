import type { Marks } from "../../../../src/core/text/runs.ts";

export interface ModelChar { ch: string; names: readonly string[] }
export interface ReadableItem { insert: unknown; attributes?: Record<string, unknown> }

export const ATOM = "￼";
const SUFFIX = "\u001f";
const FLAGS = ["b", "i", "u", "s", "hl", "dir", "cue"] as const;

// why: written apart from the variant's reader so the check does not lean on the code it checks
export function visibleName(key: string): string {
  const at = key.indexOf(SUFFIX);
  return at < 0 ? key : key.slice(0, at);
}

export function namesOfMarks(marks: Marks): string[] {
  const names: string[] = [];
  for (const flag of FLAGS) if (marks[flag]) names.push(flag);
  for (const id of marks.cmt ?? []) names.push(`c:${id}`);
  for (const id of [marks.tag, ...(marks.innerTags ?? [])]) if (id) names.push(`t:${id}`);
  if (marks.href) names.push(`l:${marks.href}`);
  return [...new Set(names)].sort();
}

export function marksOfNames(names: readonly string[]): Marks {
  const marks: Record<string, unknown> = {}, comments: string[] = [], tags: string[] = [];
  for (const name of names) {
    if (name.startsWith("c:")) comments.push(name.slice(2));
    else if (name.startsWith("t:")) tags.push(name.slice(2));
    else if (name.startsWith("l:")) marks.href = name.slice(2);
    else marks[name] = true;
  }
  if (comments.length) marks.cmt = comments.sort();
  tags.sort();
  if (tags[0]) marks.tag = tags[0];
  if (tags.length > 1) marks.innerTags = tags.slice(1);
  return marks as Marks;
}

export function readCell(delta: readonly ReadableItem[]): ModelChar[] {
  const result: ModelChar[] = [];
  for (const item of delta) {
    const names = [...new Set(Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([key]) => visibleName(key)))].sort();
    if (typeof item.insert === "string") for (const ch of item.insert) result.push({ ch, names });
    else result.push({ ch: ATOM, names });
  }
  return result;
}

export function printCell(chars: readonly ModelChar[]): string {
  const parts: { text: string; names: string }[] = [];
  for (const char of chars) {
    const names = char.names.join(","), last = parts.at(-1);
    if (last?.names === names) last.text += char.ch; else parts.push({ text: char.ch, names });
  }
  return parts.map(part => part.names ? `[${part.text}|${part.names}]` : part.text).join("");
}

export function firstDifference(expected: readonly ModelChar[], actual: readonly ModelChar[]): number {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    const want = expected[index], got = actual[index];
    if (!want || !got || want.ch !== got.ch || want.names.join(",") !== got.names.join(",")) return index;
  }
  return -1;
}

// why: what each command means for each character, applied in the order the commands were made; valid wherever
// every command was made by a copy that had seen all earlier commands on the same cell
export class FormatModel {
  readonly cells = new Map<string, ModelChar[]>();
  private readonly saved = new Map<number, { cell: string; chars: ModelChar[] }>();

  cell(key: string): ModelChar[] {
    const found = this.cells.get(key);
    if (found) return found;
    const fresh: ModelChar[] = [];
    this.cells.set(key, fresh);
    return fresh;
  }

  save(writer: number, key: string): void { this.saved.set(writer, { cell: key, chars: this.cell(key).map(char => ({ ...char })) }); }

  undo(writer: number): string {
    const saved = this.saved.get(writer);
    if (!saved) throw new Error("Nothing saved to undo");
    this.cells.set(saved.cell, saved.chars);
    this.saved.delete(writer);
    return saved.cell;
  }

  insert(key: string, at: number, chars: readonly ModelChar[]): void { this.cell(key).splice(at, 0, ...chars.map(char => ({ ch: char.ch, names: [...char.names].sort() }))); }

  remove(key: string, from: number, to: number): void { this.cell(key).splice(from, to - from); }

  left(key: string, at: number): readonly string[] { return at > 0 ? this.cell(key)[at - 1]?.names ?? [] : []; }

  throughout(key: string, from: number, to: number, name: string): boolean {
    return this.cell(key).slice(from, to).every(char => char.names.includes(name));
  }

  set(key: string, from: number, to: number, name: string, on: boolean): void {
    const chars = this.cell(key);
    for (let index = from; index < to; index++) {
      const char = chars[index];
      if (!char) continue;
      const names = new Set(char.names);
      if (on) names.add(name); else names.delete(name);
      chars[index] = { ch: char.ch, names: [...names].sort() };
    }
  }
}
