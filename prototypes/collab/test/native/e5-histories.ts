import { E5Model, required, spot } from "./e5-model.ts";
import type { E5Command, E5Event, E5Field, E5Removal, E5Step } from "./e5-model.ts";

export const DELIVERIES = ["forward", "reverse", "twice", "shuffled", "state"] as const;
export type E5Delivery = typeof DELIVERIES[number];
export interface E5History { steps: E5Step[]; events: E5Event[]; writers: number }

export function randomFor(seed: number): () => number {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
}

export function recordHistory(removal: E5Removal, writers: number, choose: (models: E5Model[], index: number) => E5Step | undefined): E5History {
  const steps: E5Step[] = [], events: E5Event[] = [];
  const seen = Array.from({ length: writers }, () => new Set<number>());
  for (let index = 0; ; index++) {
    const models = seen.map(known => new E5Model(events, known)), step = choose(models, index);
    if (!step) break;
    steps.push(step);
    if ("command" in step) {
      const { by, command } = step;
      const known = required(seen[by], "writer knowledge");
      events.push(required(models[by], "writer model").plan(command, by, known, events.length, removal));
      known.add(events.length - 1);
    } else {
      const receiver = required(seen[step.to], "receiver knowledge");
      for (const event of required(seen[step.from], "sender knowledge")) receiver.add(event);
    }
  }
  return { steps, events, writers };
}

export function generateHistory(removal: E5Removal, seed: number, length: number): E5History {
  const random = randomFor(seed), int = (max: number): number => Math.floor(random() * max);
  const pick = <T>(values: readonly T[]): T => required(values[int(values.length)], "generated choice");
  return recordHistory(removal, 3, (models, index) => {
    if (index >= length) return undefined;
    const by = int(3), send = { from: by, to: (by + 1 + int(2)) % 3 };
    if (int(100) < 22) return send;
    const model = required(models[by], "generator writer"), stored = model.stored(), view = model.project(stored);
    const rows = view.outline.filter(it => it.kind === "row"), headings = view.outline.filter(it => it.kind === "heading");
    const value = String.fromCharCode(0x100 + index);
    const choices: { weight: number; commands: E5Command[] }[] = [];
    const add = (weight: number, commands: E5Command[]): void => {
      if (commands.length) choices.push({ weight, commands });
    };
    add(10, rows.map(row => ({ op: "create", beat: row.id, id: `H${index + 10}`, name: value })));
    add(11, headings.map(item => ({ op: "renameType", id: item.id, at: int(item.name.length + 1), value })));
    add(7, headings.filter(item => item.name.length).map(item => ({ op: "renameDelete", id: item.id, at: int(item.name.length) })));
    add(10, headings.map(item => ({ op: "removeHeading", id: item.id })));
    add(10, view.removedHeadings.map(item => ({ op: "restoreHeading", id: item.id })));
    const field: E5Field = int(2) ? "audio" : "visual";
    add(21, rows.map(row => ({ op: "typeBeat", row: row.id, field, at: int(row[field].length + 1), value })));
    add(7, rows.flatMap(row => {
      const offsets = Array.from(row[field], (char, at) => char === " " || char === "\n" ? -1 : at).filter(at => at >= 0);
      return offsets.length ? [{ op: "deleteBeat", row: row.id, field, at: pick(offsets) }] : [];
    }));
    add(12, rows.flatMap(row => {
      const offsets = Array.from({ length: row.audio.length + 1 }, (_, at) => at);
      const spots = offsets.filter(at => !spot(row, "audio", at).seam);
      return spots.length ? [{ op: "split", row: row.id, at: pick(spots), id: `S${index + 10}` }] : [];
    }));
    add(17, rows.slice(1).filter(row => stored.beats[row.id]?.into === null).map(row => ({ op: "join", row: row.id })));
    add(22, rows.flatMap(row => {
      const seams = Array.from({ length: row.audio.length + 1 }, (_, at) => at).filter(at => spot(row, "audio", at).seam);
      return seams.length ? [{ op: "unjoin", row: row.id, at: pick(seams) }] : [];
    }));
    add(9, rows.map(row => ({ op: "removeBeat", row: row.id })));
    add(10, view.removedBeats.map(row => ({ op: "restoreBeat", id: row.id })));
    let selection = int(choices.reduce((sum, choice) => sum + choice.weight, 0));
    for (const { weight, commands } of choices) {
      if (selection < weight) return { by, command: pick(commands) };
      selection -= weight;
    }
    return send;
  });
}

const a = (command: E5Command): E5Step => ({ by: 0, command });
const b = (command: E5Command): E5Step => ({ by: 1, command });
const take: E5Step = { from: 0, to: 1 };
const remove: E5Step = a({ op: "removeHeading", id: "H1" });
const removeHead: E5Step = a({ op: "removeHeading", id: "H0" });

export const NAMED: Readonly<Record<string, E5Step[]>> = {
  "remove an embedded heading against rename typing": [remove, b({ op: "renameType", id: "H1", at: 1, value: "X" })],
  "remove a heading against rename deletion": [remove, b({ op: "renameDelete", id: "H1", at: 0 })],
  "remove a heading against splitting the beat directly below": [remove, b({ op: "split", row: "B2", at: 1, id: "S2" })],
  "remove a heading against splitting the beat directly above": [remove, b({ op: "split", row: "B1", at: 1, id: "S2" })],
  "remove a heading against joining the beat directly below": [remove, b({ op: "join", row: "B2" })],
  "remove a heading against joining the beat directly above": [remove, b({ op: "join", row: "B1" })],
  "create two headings above the same embedded beat": [a({ op: "create", beat: "B3", id: "Left", name: "X" }),
    b({ op: "create", beat: "B3", id: "Right", name: "Y" })],
  "create two headings above the same segment-head beat": [a({ op: "create", beat: "B4", id: "Left", name: "X" }),
    b({ op: "create", beat: "B4", id: "Right", name: "Y" })],
  "remove the same embedded heading twice": [remove, b({ op: "removeHeading", id: "H1" })],
  "remove the same segment-head heading twice": [removeHead, b({ op: "removeHeading", id: "H0" })],
  "remove a segment-head heading against typing at the start of its first beat": [removeHead,
    b({ op: "typeBeat", row: "B0", field: "audio", at: 0, value: "X" })],
  "remove a segment-head heading against typing in its name": [removeHead, b({ op: "renameType", id: "H0", at: 0, value: "X" })],
  "a new heading boundary races a rename at the end of the removed name": [
    a({ op: "create", beat: "B0", id: "New", name: "Y" }), removeHead, b({ op: "renameType", id: "H0", at: 1, value: "X" })]
};

export const WITH_RESTORE: Readonly<Record<string, E5Step[]>> = {
  "restore exposes the renamed heading for editing in place": [remove, b({ op: "renameType", id: "H1", at: 1, value: "X" }), take,
    b({ op: "restoreHeading", id: "H1" }), b({ op: "renameDelete", id: "H1", at: 0 })],
  "restoring a segment-head heading exposes the whole name at its original position": [removeHead,
    b({ op: "renameType", id: "H0", at: 0, value: "X" }), take, b({ op: "restoreHeading", id: "H0" })],
  "restore that saw only the lower-priority removal leaves the concurrent removal standing": [
    b({ op: "removeHeading", id: "H1" }), remove, a({ op: "restoreHeading", id: "H1" })]
};
