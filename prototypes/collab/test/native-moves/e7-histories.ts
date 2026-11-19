import { randomFor } from "../native/e5-histories.ts";
import { required, spot } from "../native/e5-model.ts";
import type { E5Field } from "../native/e5-model.ts";
import { E7Model, refOf } from "./e7-model.ts";
import type { E7Command, E7Event, E7Move, E7Step } from "./e7-model.ts";

export interface E7History { steps: E7Step[]; events: E7Event[]; writers: number }

export function recordHistory(writers: number, choose: (models: E7Model[], index: number) => E7Step | undefined): E7History {
  const steps: E7Step[] = [], events: E7Event[] = [];
  const seen = Array.from({ length: writers }, () => new Set<number>());
  for (let index = 0; ; index++) {
    const models = seen.map(known => new E7Model(events, known)), step = choose(models, index);
    if (!step) break;
    steps.push(step);
    if ("command" in step) {
      const known = required(seen[step.by], "writer knowledge");
      events.push(required(models[step.by], "writer model").plan(step.command, step.by, known, events.length));
      known.add(events.length - 1);
    } else {
      const receiver = required(seen[step.to], "receiver knowledge");
      for (const event of required(seen[step.from], "sender knowledge")) receiver.add(event);
    }
  }
  return { steps, events, writers };
}

function moves(model: E7Model): E7Move[] {
  const stored = model.stored(), order = model.arrangement(stored).order, view = model.project(stored);
  const rows = view.outline.filter(entry => entry.kind === "row"), headings = view.outline.filter(entry => entry.kind === "heading");
  const result: E7Move[] = [];
  const add = (unit: E7Move["unit"], first: string, last: string, after: string | null): void => {
    const from = order.indexOf(first), to = order.indexOf(last), run = order.slice(from, to + 1);
    if (from < 0 || to < from || (after !== null && run.includes(after)) || (order[from - 1] ?? null) === after) return;
    result.push({ op: "move", unit, first, last, after });
  };
  const ends = (members: readonly string[]): [string, string] => [refOf("b", required(members[0], "row start")), refOf("b", required(members.at(-1), "row end"))];
  for (const row of rows) {
    const [first, last] = ends(row.members);
    for (const target of rows) if (target !== row) {
      const [start, end] = ends(target.members);
      add("row", first, last, end);
      add("row", first, last, order[order.indexOf(start) - 1] ?? null);
    }
    for (const heading of headings) add("into", first, last, refOf("h", heading.id));
  }
  rows.slice(0, -1).forEach((row, index) => {
    const next = required(rows[index + 1], "next row"), [first] = ends(row.members), [, last] = ends(next.members);
    for (const target of rows) add("rows", first, last, ends(target.members)[1]);
    add("rows", first, last, null);
  });
  for (const heading of headings) {
    const first = refOf("h", heading.id), start = order.indexOf(first);
    let end = start;
    while (end + 1 < order.length && !headings.some(other => refOf("h", other.id) === order[end + 1])) end++;
    const last = required(order[end], "scene end");
    for (const target of headings) if (target !== heading) add("scene", first, last, order[order.indexOf(refOf("h", target.id)) - 1] ?? null);
    add("scene", first, last, order.at(-1) ?? null);
  }
  return result;
}

export function generateHistory(seed: number, length: number): E7History {
  const random = randomFor(seed), int = (max: number): number => Math.floor(random() * max);
  const pick = <T>(values: readonly T[]): T => required(values[int(values.length)], "generated choice");
  return recordHistory(3, (models, index) => {
    if (index >= length) return undefined;
    const by = int(3), send = { from: by, to: (by + 1 + int(2)) % 3 };
    if (int(100) < 22) return send;
    const model = required(models[by], "generator writer"), stored = model.stored(), view = model.project(stored);
    const rows = view.outline.filter(it => it.kind === "row"), headings = view.outline.filter(it => it.kind === "heading");
    const value = String.fromCharCode(0x100 + index);
    const choices: { weight: number; commands: E7Command[] }[] = [];
    const add = (weight: number, commands: E7Command[]): void => { if (commands.length) choices.push({ weight, commands }); };
    add(8, rows.map(row => ({ op: "create", beat: row.id, id: `H${index + 10}`, name: value })));
    add(9, headings.map(item => ({ op: "renameType", id: item.id, at: int(item.name.length + 1), value })));
    add(5, headings.filter(item => item.name.length).map(item => ({ op: "renameDelete", id: item.id, at: int(item.name.length) })));
    add(6, headings.map(item => ({ op: "removeHeading", id: item.id })));
    add(6, view.removedHeadings.map(item => ({ op: "restoreHeading", id: item.id })));
    const field: E5Field = int(2) ? "audio" : "visual";
    add(21, rows.map(row => ({ op: "typeBeat", row: row.id, field, at: int(row[field].length + 1), value })));
    add(6, rows.flatMap(row => {
      const offsets = Array.from(row[field], (char, at) => char === " " || char === "\n" ? -1 : at).filter(at => at >= 0);
      return offsets.length ? [{ op: "deleteBeat", row: row.id, field, at: pick(offsets) }] : [];
    }));
    add(12, rows.flatMap(row => {
      const spots = Array.from({ length: row.audio.length + 1 }, (_, at) => at).filter(at => !spot(row, "audio", at).seam);
      return spots.length ? [{ op: "split", row: row.id, at: pick(spots), id: `S${index + 10}` }] : [];
    }));
    add(10, rows.slice(1).filter(row => stored.beats[row.id]?.into === null).map(row => ({ op: "join", row: row.id })));
    add(10, rows.flatMap(row => {
      const seams = Array.from({ length: row.audio.length + 1 }, (_, at) => at).filter(at => spot(row, "audio", at).seam);
      return seams.length ? [{ op: "unjoin", row: row.id, at: pick(seams) }] : [];
    }));
    add(6, rows.map(row => ({ op: "removeBeat", row: row.id })));
    add(6, view.removedBeats.map(row => ({ op: "restoreBeat", id: row.id })));
    const options = moves(model);
    for (const unit of ["row", "rows", "scene", "into"] as const) add({ row: 16, rows: 6, scene: 7, into: 4 }[unit], options.filter(move => move.unit === unit));
    let selection = int(choices.reduce((sum, choice) => sum + choice.weight, 0));
    for (const { weight, commands } of choices) {
      if (selection < weight) return { by, command: pick(commands) };
      selection -= weight;
    }
    return send;
  });
}
