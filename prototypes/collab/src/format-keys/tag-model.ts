import type { ModelChar } from "./model.ts";

export const TAG_T = "t:t_abcdefg";
export const TAG_U = "t:t_bcdefgh";

export interface TagFormatEdit { cell: string; op: "add" | "remove"; name: string; from: number; to: number }

export type TagEdit =
  | TagFormatEdit
  | { cell: string; op: "delete"; from: number; to: number }
  | { cell: string; op: "insert"; at: number; letter: string };

type Effect = {
  edit: TagEdit;
  letters: string[];
  seen: number[];
  left?: string | undefined;
  right?: string | undefined;
};

export class TagCommandModel {
  private readonly effects: Effect[] = [];
  private readonly initial: Readonly<Record<string, string>>;

  constructor(initial: Readonly<Record<string, string>>) { this.initial = initial; }

  record(edit: TagEdit, seen: number[]): number {
    const chars = this.view(edit.cell, seen);
    const effect: Effect = edit.op === "insert"
      ? { edit, letters: [edit.letter], left: chars[edit.at - 1]?.ch, right: chars[edit.at]?.ch, seen }
      : { edit, letters: chars.slice(edit.from, edit.to).map(char => char.ch), seen };
    this.effects.push(effect);
    return this.effects.length - 1;
  }

  view(cell: string, active: readonly number[], options: {
    presses?: readonly { target: number; redo: boolean }[];
    includeApplications?: boolean;
  } = {}): ModelChar[] {
    const ordered = this.effects.flatMap((effect, id) => active.includes(id) && effect.edit.cell === cell ? [{ id, ...effect }] : []);
    const text = [...(this.initial[cell] ?? "")];
    const deleted = new Set<string>();
    for (const { edit, letters, right } of ordered) {
      if (edit.op === "delete") for (const letter of letters) deleted.add(letter);
      if (edit.op === "insert") text.splice(right === undefined ? text.length : text.indexOf(right), 0, edit.letter);
    }
    return text.filter(ch => !deleted.has(ch)).map(ch => {
      const inserted = ordered.find(item => item.edit.op === "insert" && item.letters[0] === ch);
      let names: string[] = [];
      for (const { id, edit, letters } of ordered) {
        if (edit.op !== "add") continue;
        const unseenInside = inserted && !inserted.seen.includes(id) && inserted.left !== undefined
          && inserted.right !== undefined && letters.includes(inserted.left) && letters.includes(inserted.right);
        if (!letters.includes(ch) && !unseenInside) continue;
        if (!ordered.some(other => other.edit.op === "remove" && other.edit.name === edit.name
          && other.seen.includes(id) && other.letters.includes(ch))) names.push(edit.name);
      }
      for (const { target, redo } of options.presses ?? []) {
        const effect = this.effects[target];
        if (!effect || effect.edit.cell !== cell || (effect.edit.op !== "add" && effect.edit.op !== "remove")) continue;
        const { edit, letters } = effect;
        const inside = inserted && !inserted.seen.includes(target) && inserted.left !== undefined && inserted.right !== undefined
          && letters.includes(inserted.left) && letters.includes(inserted.right);
        if (!letters.includes(ch) && !inside) continue;
        if (redo === (edit.op === "add")) names.push(edit.name); else names = names.filter(name => name !== edit.name);
      }
      return { ch, names: (options.includeApplications ? names : [...new Set(names)]).sort() };
    });
  }
}

export class TagLifeModel {
  private readonly cells = new Map<string, ModelChar[]>();
  private readonly includeApplications: boolean;

  constructor(cells: Readonly<Record<string, string>>, includeApplications: boolean) {
    this.includeApplications = includeApplications;
    for (const [cell, text] of Object.entries(cells)) this.cells.set(cell, Array.from(text, ch => ({ ch, names: [] })));
  }

  view(cell: string): readonly ModelChar[] { return this.cells.get(cell) ?? []; }

  apply(edit: TagFormatEdit): void {
    const chars = this.cells.get(edit.cell);
    if (!chars) throw new Error(`Missing model cell ${edit.cell}`);
    for (let index = edit.from; index < edit.to; index++) {
      const char = chars[index];
      if (!char) throw new Error(`Tag selection outside ${edit.cell}`);
      let names = char.names;
      if (edit.op === "remove") names = names.filter(name => name !== edit.name);
      else if (this.includeApplications || !names.includes(edit.name)) names = [...names, edit.name].sort();
      chars[index] = { ch: char.ch, names };
    }
  }
}
