import { histories } from "../native-delete/histories.ts";
import { base, blocks, type DeleteCommand, type StoredReading } from "../native-delete/model.ts";
import type { Effect } from "./model.ts";

type Write = DeleteCommand | { op: "undo" | "redo" } | { op: "move"; id: string; after: string } |
  { op: "detail"; id: string; key: string; value: unknown };
export type Step =
  | { person: number; command: Write; effect: Effect }
  | { from: number; to: number; ack?: true };

export interface NoticeHistory {
  name: string;
  initial: StoredReading;
  copies: number;
  stretches: { offline: readonly number[]; steps: Step[]; order?: number[] }[];
}

const other: Effect = { action: "other" };
const remove = (...ids: string[]): Effect => ({ action: "delete", ids });
type NoticeEdit = Extract<Effect, { action: "edit" }>;
const edit = (id: string, kind: NoticeEdit["kind"], details: Partial<NoticeEdit> = {}): Effect =>
  ({ action: "edit", id, kind, ...details });
const step = (person: number, command: Write, effect: Effect): Step => ({ person, command, effect });
const cut = (person: number, id: string, above?: string): Step =>
  step(person, { op: "rows", ids: [id] }, { action: "delete", ids: [id], ...(above ? { above } : {}) });
const undo = (person: number): Step => step(person, { op: "undo" }, { action: "undo" });
const type = (person: number, id: string, field: "audio" | "visual", value: string, at = 1): Step =>
  step(person, { op: "type", id, field, at, value }, edit(id, field === "audio" ? "narration" : "visual", { token: value }));
const mark = (person: number, id: string, field: "audio" | "visual", key: string, from = 0, to = from + 1): Step =>
  step(person, { op: "mark", id, field, from, to, key },
    edit(id, "marks", { mark: key, from, column: field === "audio" ? "narration" : "visual" }));
const status = (person: number, id: string, value: string): Step =>
  step(person, { op: "field", id, value }, edit(id, "record", { field: "status" }));
const note = (person: number, id: string): Step =>
  step(person, { op: "detail", id, key: "notes", value: "changed" }, edit(id, "record", { field: "notes" }));
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
        case "scene": effect = remove(command.id, command.id === "H" ? "E" : "F"); break;
        case "heading": if (command.removal === "delete") effect = remove(command.id); break;
        case "type":
          effect = edit(command.id, command.field === "visual" ? "visual" : "narration", { token: command.value });
          break;
        case "mark": effect = edit(command.id, "marks", { mark: command.key, from: command.from,
          column: command.field === "audio" ? "narration" : "visual" }); break;
        case "field": effect = edit(command.id, "record", { field: "status" }); break;
        case "join": effect = edit(command.id, "join", { into: command.id === "C" ? "B" : "A" }); break;
        case "unjoin": effect = edit(command.id, "join"); break;
        case "split": effect = { action: "create", id: command.created, from: command.id }; break;
        case "insert": effect = { action: "create", id: command.created }; break;
      }
      if (effect.action === "delete") {
        const ordered = blocks(initial);
        const at = ordered.findIndex(block => effect.action === "delete" && effect.ids.includes(block.id));
        const above = ordered.slice(0, Math.max(0, at)).findLast(block => block.kind === "b")?.id;
        if (above) effect.above = above;
        if (name === "run of rows") effect.landing = "A";
        if (name === "scene name" || name === "scene beat" || name === "embedded heading delete versus rename") effect.landing = "D";
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
          status(1, "N", "filmed"), undo(0)]
      }]
    }))),
    ...([
      type(0, "B", "visual", "Ω"), status(0, "B", "ready"), note(0, "B"),
      mark(0, "B", "visual", "t:TAG"), mark(0, "B", "audio", "t:TAG", 1),
      step(0, { op: "erase", id: "B", field: "visual", from: 0, to: 1 }, edit("B", "visual", { token: "2", erased: true }))
    ] as const).map((change, index) => ({ name: `unseen edit then cut and undo ${index}`, initial: base,
      copies: 2, stretches: [{ offline: [0, 1], steps: [change, cut(1, "B", "A"), undo(1)] }] }))
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
    const mode = seed < 72 ? (seed + 5 * stretch) % 12 : 12 + (seed - 72 + 5 * stretch) % 12;
    const idle = copies === 3 ? 3 - writer - deleter : deleter;
    const offline = mode === 22 ? [idle] : role === 0 ? [writer, deleter] : [role < 2 ? writer : deleter];
    const token = String.fromCodePoint(0xe000 + stretch * 256 + seed);
    const commands: Step[] = [];
    const move = (person: number) => step(person, { op: "move", id: b, after: c }, { action: "move", id: b, after: c });
    const removeBeat = () => cut(deleter, b, a);
    const seen = { from: writer, to: deleter };
    switch (mode) {
      case 0: commands.push(type(writer, b, "audio", token, next(4)), removeBeat()); break;
      case 1: commands.push(type(writer, b, "visual", token, next(2)), removeBeat()); break;
      case 2: commands.push(mark(writer, b, next(2) ? "audio" : "visual", seed % 3 === 0 ? "b" : "t:TAG"), removeBeat()); break;
      case 3: commands.push(status(writer, b, "ready"), removeBeat()); break;
      case 4: commands.push(step(writer, { op: "join", id: c }, edit(c, "join", { into: b })), removeBeat()); break;
      case 5: commands.push(split(writer, b, n, 1 + next(2)), removeBeat()); break;
      case 6: commands.push(split(writer, b, n, 1 + next(2)), move(deleter)); break;
      case 7: commands.push(cut(writer, b, a), undo(writer), removeBeat(), undo(deleter)); break;
      case 8: commands.push(type(writer, b, "visual", token), seen, removeBeat()); break;
      case 9: commands.push(type(writer, b, "audio", token), undo(writer), removeBeat()); break;
      case 10: commands.push(type(writer, a, "audio", token), removeBeat()); break;
      case 11: commands.push(insert(deleter, c, n), { from: deleter, to: writer }, type(writer, n, "visual", token, 0),
        note(writer, n), undo(deleter)); break;
      case 12: commands.push(type(writer, b, "visual", token), removeBeat(), undo(deleter)); break;
      case 13: commands.push(status(writer, b, "ready"), removeBeat(), undo(deleter)); break;
      case 14: commands.push(mark(writer, b, "visual", "t:TAG"), removeBeat(), undo(deleter)); break;
      case 15: commands.push(mark(writer, b, "audio", "t:TAG", 1), removeBeat(), undo(deleter)); break;
      case 16:
        commands.push(note(writer, b), removeBeat());
        if (stretch === 0) commands.push(undo(deleter));
        break;
      case 17: commands.push(mark(writer, b, role % 2 === 0 ? "visual" : "audio", "t:TAG"), seen, removeBeat()); break;
      case 18: commands.push(status(writer, b, "ready"), seen, removeBeat()); break;
      case 19: commands.push(type(writer, b, "audio", token), seen, removeBeat()); break;
      case 20: commands.push(split(writer, b, n), seen, move(deleter)); break;
      case 21:
        commands.push(type(writer, b, "audio", token),
          step(writer, { op: "erase", id: b, field: "audio", from: 1, to: 2 }, { action: "revert", id: b, kind: "narration", token }),
          status(writer, b, "ready"), step(writer, { op: "field", id: b, value: "todo" }, { action: "revert", id: b, kind: "record" }),
          removeBeat());
        break;
      case 22:
        commands.push(stretch === 0
          ? step(writer, { op: "erase", id: b, field: "audio", from: 0, to: 3 }, other)
          : type(writer, b, "audio", "def", 3));
        break;
      case 23: commands.push(split(writer, b, n), { ...seen, ack: true }, move(deleter)); break;
    }
    for (let index = 0; index < 24; index++) {
      const selected = next(copies), person = mode === 22 && selected === idle ? writer : selected;
      const id = ["A", "C", "D", "F"][next(4)] ?? "F";
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
