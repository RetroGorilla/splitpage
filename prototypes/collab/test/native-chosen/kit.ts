import * as Y from "yjs";
import { ChosenReplica } from "../../src/native-chosen/replica.ts";
import type { ChosenNames } from "../../src/native-chosen/replica.ts";
import { ALL_RULES, nativeMarkName } from "../../src/native/variant.ts";
import type { NativeDeltaItem, NativeRules } from "../../src/native/variant.ts";
import type { Marker, StoredReading, VisibleEntry } from "../native-delete/model.ts";

export type Unit = string | { b: string } | { h: string };
export interface Spec {
  order: string[];
  segments: Record<string, { head?: { b: string } | { h: string }; units: Unit[] }>;
  beats: Record<string, Record<string, unknown>>;
  visuals: Record<string, string>;
  headings: Record<string, Record<string, unknown>>;
}

export const b = (id: string): { b: string } => ({ b: id });
export const h = (id: string): { h: string } => ({ h: id });

export function base(): Spec {
  return {
    order: ["S", "T", "U", "V"],
    segments: {
      S: { head: b("A"), units: ["abc", b("B"), "def", b("C"), "ghi"] },
      T: { head: b("D"), units: ["jkl", h("H"), "mno", b("E"), "pqr"] },
      U: { head: h("I"), units: ["stu"] },
      V: { head: b("F"), units: ["vwx"] }
    },
    beats: { A: {}, B: {}, C: {}, D: {}, E: {}, F: {} },
    visuals: { A: "1", B: "2", C: "3", D: "4", E: "5", F: "6" },
    headings: { H: {}, I: {} }
  };
}

// why: with names in cells, the text right after a heading's boundary in a spec is that heading's name
export function seed(spec: Spec, rules: NativeRules = ALL_RULES, names: ChosenNames = "inline"): Uint8Array {
  const replica = new ChosenReplica(900, rules, names);
  replica.doc.transact(() => {
    for (const [id, data] of Object.entries(spec.segments)) {
      const record = new Y.Map<unknown>(), text = new Y.Text();
      replica.segments.set(id, record);
      if (data.head) record.set("head", data.head);
      record.set("text", text);
      let heading = data.head && "h" in data.head ? data.head.h : null;
      for (const unit of data.units) {
        if (typeof unit === "string" && heading && names === "cells") {
          const cell = replica.names.get(heading) ?? new Y.Text();
          if (!replica.names.has(heading)) replica.names.set(heading, cell);
          cell.insert(cell.length, unit, {});
        } else if (typeof unit === "string") text.insert(text.length, unit, {});
        else text.insertEmbed(text.length, unit, {});
        if (typeof unit === "object") heading = "h" in unit ? unit.h : null;
      }
    }
    if (names === "cells") for (const id of Object.keys(spec.headings)) if (!replica.names.has(id)) replica.names.set(id, new Y.Text());
    replica.order.push(spec.order);
    for (const [id, fields] of Object.entries(spec.beats)) replica.beats.set(id, new Y.Map(Object.entries(fields)));
    for (const [id, value] of Object.entries(spec.visuals)) { const text = new Y.Text(); text.insert(0, value, {}); replica.visuals.set(id, text); }
    for (const [id, fields] of Object.entries(spec.headings)) replica.headings.set(id, new Y.Map(Object.entries(fields)));
  }, "hydration");
  replica.initializeRanks();
  const bytes = replica.encode();
  replica.destroy();
  return bytes;
}

export function load(bytes: Uint8Array, client: number, rules: NativeRules = ALL_RULES, names: ChosenNames = "inline"): ChosenReplica {
  const replica = new ChosenReplica(client, rules, names);
  Y.applyUpdate(replica.doc, bytes, "remote");
  replica.changes();
  return replica;
}

export function marked(delta: readonly NativeDeltaItem[], withMarks: boolean): string {
  return delta.map(item => {
    const text = typeof item.insert === "string" ? item.insert : "□";
    const names = [...new Set(Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([key]) => nativeMarkName(key)))].sort();
    return withMarks && names.length ? `[${text}|${names.join(",")}]` : text;
  }).join("");
}

// why: one line per outline entry, so an expected outline is a hand-written list of strings
export function outline(replica: ChosenReplica, withMarks = false): string[] {
  return replica.outline().map(entry => {
    if (entry.kind === "heading") return `#${entry.id} ${marked(entry.name, withMarks)}`;
    const { id, members, audio, visual } = entry.row;
    return `${id}${members.length > 1 ? `(${members.join("+")})` : ""}: ${marked(audio, withMarks)} / ${marked(visual, withMarks)}`;
  });
}

export function sync(copies: readonly ChosenReplica[]): void {
  for (let round = 0; round < 2; round++) for (const from of copies) for (const to of copies) {
    if (from === to) continue;
    Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote");
  }
}

export function storedOf(spec: Spec): StoredReading {
  const marker = (unit: { b: string } | { h: string }): Marker => "b" in unit ? { kind: "b", id: unit.b } : { kind: "h", id: unit.h };
  return {
    order: [...spec.order],
    segments: Object.fromEntries(Object.entries(spec.segments).map(([id, data]) => [id, {
      head: data.head ? marker(data.head) : null,
      units: data.units.flatMap((unit): (string | Marker)[] => typeof unit === "string" ? [...unit] : [marker(unit)])
    }])),
    beats: structuredClone(spec.beats) as StoredReading["beats"], visuals: { ...spec.visuals },
    headings: structuredClone(spec.headings) as StoredReading["headings"]
  };
}

export function specOf(stored: StoredReading): Spec {
  const unit = (marker: Marker): { b: string } | { h: string } => marker.kind === "b" ? { b: marker.id } : { h: marker.id };
  return {
    order: [...stored.order],
    segments: Object.fromEntries(Object.entries(stored.segments).map(([id, data]) => [id, {
      ...data.head && { head: unit(data.head) }, units: data.units.map(item => typeof item === "string" ? item : unit(item))
    }])),
    beats: structuredClone(stored.beats), visuals: { ...stored.visuals }, headings: structuredClone(stored.headings)
  };
}

export function lines(view: readonly VisibleEntry[]): string[] {
  return view.map(entry => "heading" in entry ? `#${entry.heading} ${entry.name}`
    : `${entry.id}${entry.members.length > 1 ? `(${entry.members.join("+")})` : ""}: ${entry.audio} / ${entry.visual}`);
}

export function stringOf(delta: readonly NativeDeltaItem[]): string {
  return delta.map(item => typeof item.insert === "string" ? item.insert : "").join("");
}
