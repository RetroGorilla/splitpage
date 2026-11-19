import { histories } from "../native-delete/histories.ts";
import { base, type DeleteCommand, type StoredReading } from "../native-delete/model.ts";
import type { Effect } from "./model.ts";

type Write = DeleteCommand | { op: "undo" | "redo" } | { op: "move"; id: string; after: string } |
  { op: "detail"; id: string; key: string; value: unknown };
export type Step =
  | { person: number; command: Write; effect: Effect }
  | { from: number; to: number };

export interface NoticeHistory {
  name: string;
  initial: StoredReading;
  copies: number;
  stretches: { offline: readonly number[]; steps: Step[]; order?: number[] }[];
}

const other: Effect = { action: "other" };
const remove = (...ids: string[]): Effect => ({ action: "delete", ids });
const edit = (id: string, kind: "narration" | "visual" | "marks" | "record" | "join", token?: string, into?: string): Effect =>
  ({ action: "edit", id, kind, token, into });
const step = (person: number, command: Write, effect: Effect): Step => ({ person, command, effect });
const cut = (person: number, id: string): Step => step(person, { op: "rows", ids: [id] }, remove(id));
const undo = (person: number): Step => step(person, { op: "undo" }, { action: "undo" });
const type = (person: number, id: string, field: "audio" | "visual", value: string, at = 1): Step =>
  step(person, { op: "type", id, field, at, value }, edit(id, field === "audio" ? "narration" : "visual", value));
const split = (person: number, id: string, created: string, at = 1): Step =>
  step(person, { op: "split", id, at, created }, { action: "create", id: created, from: id });
const insert = (person: number, before: string, created: string): Step =>
  step(person, { op: "insert", before, created, value: "new" }, { action: "create", id: created });

export function namedHistories(): NoticeHistory[] {
  return histories(1).flatMap(({ name, initial, forks }) => {
    const steps = forks.flatMap((commands, person) => commands.map(command => {
      let effect = other;
      switch (command.op) {
        case "rows": effect = remove(...command.ids, ...name === "cross segment joined" ? ["C", "D"] :
          name === "unjoin selected member" ? ["C"] : []); break;
        case "scene": effect = remove(command.id === "H" ? "E" : "F"); break;
        case "type":
          if (command.field !== "name") effect = edit(command.id, command.field === "audio" ? "narration" : "visual", command.value);
          break;
        case "mark": effect = edit(command.id, "marks"); break;
        case "field": effect = edit(command.id, "record"); break;
        case "join": effect = edit(command.id, "join", undefined, command.id === "C" ? "B" : "A"); break;
        case "unjoin": effect = edit(command.id, "join"); break;
        case "split": effect = { action: "create", id: command.created, from: command.id }; break;
        case "insert": effect = { action: "create", id: command.created }; break;
      }
      return step(person, command, effect);
    }));
    return [0, 1].map(person => ({ name: `${name} / offline ${person}`, initial, copies: 2, stretches: [{ offline: [person], steps }] }));
  }).concat([
    { name: "double delete and undo", initial: base, copies: 2, stretches: [{ offline: [0, 1], steps: [cut(0, "B"), undo(0), cut(1, "B"), undo(1)] }] },
    ...(["insert", "split"] as const).flatMap(creation => [0, 1].map(person => ({
      name: `undo ${creation} / offline ${person}`, initial: base, copies: 2, stretches: [{
        offline: [person], steps: [creation === "insert" ? insert(0, "D", "N") : split(0, "B", "N"),
          { from: 0, to: 1 }, type(1, "N", "audio", "⟡"), type(1, "N", "visual", "♠", 0),
          step(1, { op: "field", id: "N", value: "filmed" }, edit("N", "record")), undo(0)]
      }]
    })))
  ]);
}

function generatedBase(): StoredReading {
  const initial = structuredClone(base);
  for (const suffix of ["0", "1"]) {
    const ids = ["A" + suffix, "B" + suffix, "C" + suffix] as const;
    initial.order.push("work" + suffix);
    initial.segments["work" + suffix] = {
      head: { kind: "b", id: ids[0] },
      units: [..."abc", { kind: "b", id: ids[1] }, ..."def", { kind: "b", id: ids[2] }, ..."ghi"]
    };
    ids.forEach(id => { initial.beats[id] = { status: "todo" }; initial.visuals[id] = "x"; });
  }
  return initial;
}

export function generatedHistory(seed: number, copies: number): NoticeHistory {
  let state = seed + 1;
  function next(max: number): number {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  }
  const stretches = [0, 1].map(stretch => {
    const a = "A" + stretch, b = "B" + stretch, c = "C" + stretch, n = "N" + stretch;
    const writer = next(copies);
    const deleter = (writer + 1 + next(copies - 1)) % copies;
    const role = (Math.floor(seed / 12) + stretch) % 4;
    const offline = role === 0 ? [writer, deleter] : [role < 2 ? writer : deleter];
    const token = String.fromCodePoint(0xe000 + stretch * 256 + seed);
    const commands: Step[] = [];
    const move = (person: number) => step(person, { op: "move", id: b, after: c }, { action: "move", id: b, after: c });
    const mode = (seed + 5 * stretch) % 12;
    switch (mode) {
      case 0: commands.push(type(writer, b, "audio", token, next(4)), cut(deleter, b)); break;
      case 1: commands.push(type(writer, b, "visual", token, next(2)), cut(deleter, b)); break;
      case 2: commands.push(step(writer, { op: "mark", id: b, field: next(2) ? "audio" : "visual", from: 0, to: 1,
        key: seed % 3 === 0 ? "b" : "t:TAG" }, edit(b, "marks")), cut(deleter, b)); break;
      case 3: commands.push(step(writer, { op: "field", id: b, value: "ready" }, edit(b, "record")), cut(deleter, b)); break;
      case 4: commands.push(step(writer, { op: "join", id: c }, edit(c, "join", undefined, b)), cut(deleter, b)); break;
      case 5: commands.push(split(writer, b, n, 1 + next(2)), cut(deleter, b)); break;
      case 6: commands.push(split(writer, b, n, 1 + next(2)), move(deleter)); break;
      case 7: commands.push(cut(writer, b), undo(writer), cut(deleter, b), undo(deleter)); break;
      case 8: commands.push(type(writer, b, "visual", token), { from: writer, to: deleter }, cut(deleter, b)); break;
      case 9: commands.push(type(writer, b, "audio", token), undo(writer), cut(deleter, b)); break;
      case 10: commands.push(type(writer, a, "audio", token), cut(deleter, b)); break;
      case 11: commands.push(insert(deleter, c, n), { from: deleter, to: writer }, type(writer, n, "visual", token, 0),
        step(writer, { op: "detail", id: n, key: "notes", value: "changed" }, edit(n, "record")), undo(deleter)); break;
    }
    for (let index = 0; index < 24; index++) {
      const person = next(copies), id = ["A", "C", "D", "F"][next(4)] ?? "F";
      if (index % 5 === 0) {
        commands.unshift(step(person, { op: "create", above: id, id: `heading-${stretch}-${index}`, value: "Scene" }, other));
      } else if (index % 5 === 1) {
        commands.unshift(step(person, { op: "field", id, value: "ready" }, edit(id, "record")));
      } else {
        commands.unshift(type(person, id, next(2) ? "audio" : "visual", "x", 0));
      }
    }
    if (copies === 3 && (mode === 0 || mode === 1)) {
      const third = 3 - writer - deleter;
      commands.push(type(third, b, mode === 0 ? "audio" : "visual", String.fromCodePoint(0xe300 + stretch * 256 + seed), 0));
    }
    const first = next(copies);
    return { offline, steps: commands, order: Array.from({ length: copies }, (_, index) => (first + index) % copies) };
  });
  return { name: `generated ${copies}×${seed}`, initial: generatedBase(), copies, stretches };
}
