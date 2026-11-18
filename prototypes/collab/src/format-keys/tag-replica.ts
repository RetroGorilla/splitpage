import * as Y from "yjs";
import { NativeReplica } from "../native/variant.ts";
import type { NativeDeltaItem, NativeScheme } from "../native/variant.ts";
import { compareCodeUnits } from "../readers/order.ts";
import { readCell } from "./model.ts";
import type { ModelChar } from "./model.ts";
import type { TagEdit } from "./tag-model.ts";

export class TagReplica extends NativeReplica {
  constructor(client: number, scheme: NativeScheme) { super(client, 0, scheme); }

  tagText(id: string): Y.Text {
    const text = this.visuals.get(id);
    if (!text) throw new Error(`Missing cell ${id}`);
    return text;
  }

  tagDelta(id: string): NativeDeltaItem[] { return this.tagText(id).toDelta() as NativeDeltaItem[]; }

  tagView(id: string, includeApplications = false): ModelChar[] { return readCell(this.tagDelta(id), includeApplications); }

  editTagCell(edit: TagEdit): void {
    const { cell } = edit;
    if (edit.op === "insert") {
      this.splice(cell, "visualText", edit.at, edit.at, [{ text: edit.letter, marks: {} }]);
    } else if (edit.op === "delete") {
      this.splice(cell, "visualText", edit.from, edit.to, []);
    } else {
      const value = edit.op === "add" ? true : null;
      if (edit.name.startsWith("t:")) this.format(cell, "visualText", edit.from, edit.to, { [edit.name]: value });
      else this.transact(() => this.tagText(cell).format(edit.from, edit.to - edit.from, { [edit.name]: value }));
    }
  }
}

export function pullTags(copy: TagReplica, from: Y.Doc): void {
  Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(from, Y.encodeStateVector(copy.doc)), "remote");
}

interface TagExtent { name: string; from: number; to: number }

export function nestedTags(chars: readonly ModelChar[]): { chars: ModelChar[]; rejected: TagExtent[] } {
  const extents: TagExtent[] = [], open = new Map<string, TagExtent>();
  for (const [index, { names }] of chars.entries()) {
    for (const name of open.keys()) if (!names.includes(name)) open.delete(name);
    for (const name of names) {
      if (!name.startsWith("t:")) continue;
      let extent = open.get(name);
      if (!extent) {
        extent = { name, from: index, to: index };
        extents.push(extent);
        open.set(name, extent);
      }
      extent.to = index + 1;
    }
  }
  const kept: TagExtent[] = [], rejected: TagExtent[] = [];
  extents.sort((a, b) => a.from - b.from || b.to - a.to || compareCodeUnits(a.name, b.name));
  for (const extent of extents) {
    const crosses = kept.some(outer => extent.from < outer.to && extent.to > outer.to);
    (crosses ? rejected : kept).push(extent);
  }
  return {
    chars: chars.map(({ ch, names }, index) => ({
      ch,
      names: [...names.filter(name => !name.startsWith("t:")),
        ...kept.filter(extent => extent.from <= index && index < extent.to).map(extent => extent.name)]
    })),
    rejected
  };
}
