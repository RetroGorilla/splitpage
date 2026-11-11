import type { SharedMarkValue as MarkTraceMark } from "../../../../src/core/collab/operations.ts";
import type { MarkTraceCommand } from "./replica.ts";

interface ModelCharacter { id: string; value: string; position: number; birth: string | null }
interface ModelAddition { id: string; mark: MarkTraceMark; from: number; to: number; born: string | null }
interface ModelRemoval { ids: readonly string[]; from: number; to: number; born: string | null }
interface ModelEntry { id: string; additions: ModelAddition[]; removals: ModelRemoval[]; deleted: string[]; inserted: ModelCharacter[] }
export interface MarkTraceExpectedCharacter { id: string; value: string; marks: readonly MarkTraceMark[] }

export class MarkTraceModel {
  readonly entries = new Map<string, ModelEntry>();
  readonly initial: ModelCharacter[];
  constructor(text: string) { this.initial = Array.from({ length: text.length }, (_, index) => ({ id: "s" + index, value: text.charAt(index), position: index * 1000, birth: null })); }

  characters(known: ReadonlySet<string>): ModelCharacter[] {
    const entries = [...known].map(id => this.entry(id)), deleted = new Set(entries.flatMap(entry => entry.deleted));
    return [...this.initial, ...entries.flatMap(entry => entry.inserted)].filter(char => !deleted.has(char.id)).sort((a, b) => a.position - b.position);
  }

  read(known: ReadonlySet<string>): MarkTraceExpectedCharacter[] {
    const entries = [...known].map(id => this.entry(id)), additions = entries.flatMap(entry => entry.additions), removals = entries.flatMap(entry => entry.removals);
    return this.characters(known).map(char => {
      const values = new Map<string, MarkTraceMark>();
      for (const add of additions) if (covers(add, char) && !removals.some(remove => remove.ids.includes(add.id) && covers(remove, char))) {
        const mark = add.mark, output = "id" in mark ? { kind: mark.kind, id: mark.id, value: mark.value } : { kind: mark.kind, value: mark.value };
        values.set(JSON.stringify([mark.kind, "id" in mark ? mark.id : null, mark.value]), output as MarkTraceMark);
      }
      return { id: char.id, value: char.value, marks: [...values.keys()].sort().map(key => values.get(key) as MarkTraceMark) };
    });
  }

  add(command: MarkTraceCommand, known: ReadonlySet<string>, insertionPosition?: number): readonly string[] {
    if (this.entries.has(command.id)) throw new Error("Duplicate model command");
    const characters = this.characters(known), selected = characters.slice(command.from, command.to);
    const entry: ModelEntry = { id: command.id, additions: [], removals: [], deleted: [], inserted: [] };
    const from = selected[0]?.position ?? 0, to = selected.at(-1)?.position ?? -1;
    const previous = [...known].map(id => this.entry(id)), additions = previous.flatMap(item => item.additions), removals = previous.flatMap(item => item.removals);
    if (command.kind === "delete") entry.deleted = selected.map(char => char.id);
    else if (command.kind === "insert") {
      const text = command.text ?? "", before = characters[command.from - 1]?.position ?? -1000, after = characters[command.from]?.position ?? before + 2000;
      const base = insertionPosition ?? (before + after) / 2;
      entry.inserted = Array.from({ length: text.length }, (_, index) => ({ id: command.id + ":" + index, value: text.charAt(index), position: base + index / 100, birth: command.id }));
      const marks = command.mode === "inherit" ? independentTyping(this.read(known), command.from) : command.marks ?? [];
      if (entry.inserted.length) {
        const start = entry.inserted[0]?.position ?? 0, end = entry.inserted.at(-1)?.position ?? 0;
        entry.removals.push({ ids: additions.map(add => add.id), from: start, to: end, born: command.id });
        marks.forEach((mark, index) => entry.additions.push({ id: command.id + ":" + index, mark, from: start, to: end, born: command.id }));
      }
    } else if (command.mark && selected.length) {
      if (command.kind === "add") entry.additions.push({ id: command.id, mark: command.mark, from, to, born: null });
      else {
        const mark = command.mark;
        const observed = additions.filter(add => sameKind(add.mark, mark) && selected.some(char => covers(add, char) && !removals.some(remove => remove.ids.includes(add.id) && covers(remove, char))));
        entry.removals.push({ ids: observed.map(add => add.id), from, to, born: null });
      }
    }
    this.entries.set(command.id, entry);
    return entry.inserted.map(char => char.id);
  }

  private entry(id: string): ModelEntry { const entry = this.entries.get(id); if (!entry) throw new Error("Unknown model command " + id); return entry; }
}

function covers(range: { from: number; to: number; born: string | null }, char: ModelCharacter): boolean {
  return range.from <= char.position && char.position <= range.to && (range.born === null || range.born === char.birth);
}
function sameKind(a: MarkTraceMark, b: MarkTraceMark): boolean { return a.kind === b.kind && ("id" in a ? "id" in b && a.id === b.id : !("id" in b)); }
function independentTyping(characters: readonly MarkTraceExpectedCharacter[], offset: number): MarkTraceMark[] {
  const left = characters[offset - 1], right = characters[offset], source = left ?? right;
  const marks = (source?.marks ?? []).filter(mark => !("id" in mark) && mark.value === true && mark.kind !== "cue"
    && (mark.kind !== "dir" || !!left?.marks.some(item => item.kind === "dir") && !!right?.marks.some(item => item.kind === "dir")));
  const sourceIndex = left ? offset - 1 : offset;
  let from = sourceIndex, to = sourceIndex;
  while (from > 0 && characters[from - 1]?.value !== "\n") from--;
  while (to < characters.length && characters[to]?.value !== "\n") to++;
  const line = characters.slice(from, to);
  if (source?.value !== "\n" && /^[ \t\u00a0]*(sfx|music)[ \t\u00a0]*:/i.test(line.map(char => char.value).join(""))
    && line.some(char => char.marks.some(mark => mark.kind === "cue"))) marks.push({ kind: "cue", value: true });
  return marks;
}
