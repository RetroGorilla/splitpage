import type { NativeField, NativeScheme } from "../native/variant.ts";
import type { CreationRule } from "./layer.ts";
import { World } from "./harness.ts";
import type { Delivery, Loss, Part, Step, WorldOptions, WorldStats } from "./harness.ts";

export type Pace = "batched" | "continuous";
export interface HistoryOptions {
  seed: number; steps: number; pace: Pace; modes: readonly Delivery[]; checkEvery?: number; scheme?: NativeScheme; creations?: CreationRule;
  prepare?: (world: World) => void; onExtraPressUpdates?: (count: number) => void
}
export interface HistoryResult { stats: WorldStats; losses: Loss[]; history: string[]; steps: Step[]; actions: Record<string, number>; clients: number[] }

export const HISTORY_ROWS = [
  { id: "R1", audioText: "abcdef", visualText: "vw" },
  { id: "R2", audioText: "ghij", visualText: "xy" }
] as const;

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const WEIGHTS = {
  type: 26, erase: 8, replace: 3, format: 10, status: 6, field: 2, remove: 4, join: 3, split: 4, record: 3, edit: 5, compound: 6, undo: 14, redo: 6
} as const;
type Action = keyof typeof WEIGHTS;
interface Caret { beat: string; field: NativeField; at: number }

export function runHistory(options: HistoryOptions): HistoryResult {
  const next = random(options.seed);
  const clients = [1, 2, 3].sort(() => next() - 0.5);
  const world = new World(HISTORY_ROWS, {
    clients, creations: options.creations ?? "keep-always", ...(options.scheme ? { scheme: options.scheme } : {}),
    ...(options.onExtraPressUpdates ? { onExtraPressUpdates: options.onExtraPressUpdates } : {})
  });
  try { return generate(options, world, next, clients); }
  finally { for (const copy of world.copies) copy.replica.destroy(); }
}

function generate(options: HistoryOptions, world: World, next: () => number, clients: number[]): HistoryResult {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const names = world.copies.map(copy => copy.name), carets = new Map<string, Caret>(), actions: Record<string, number> = {};
  let created = 0, tags = 0, losses: Loss[] = [];
  options.prepare?.(world);
  const beats = (name: string): string[] => world.copy(name).replica.blocks().filter(block => block.kind === "b").map(block => block.id);
  const cells = (name: string): { beat: string; field: NativeField }[] => {
    const replica = world.copy(name).replica;
    return beats(name).flatMap(beat => [{ beat, field: "audioText" as NativeField }, ...(replica.visuals.has(beat) ? [{ beat, field: "visualText" as NativeField }] : [])]);
  };
  const length = (name: string, beat: string, field: NativeField): number => {
    const cell = world.copy(name).replica.cell(beat, field);
    return cell.end - cell.start;
  };
  const range = (name: string): { beat: string; field: NativeField; from: number; to: number } | null => {
    const options = cells(name).filter(cell => length(name, cell.beat, cell.field) > 0);
    if (!options.length) return null;
    const cell = pick(options), size = length(name, cell.beat, cell.field), from = Math.floor(next() * size);
    return { ...cell, from, to: Math.min(size, from + 1 + Math.floor(next() * 4)) };
  };
  const word = (): string => {
    const letters = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick([..."klmnopqrstuz"])).join("");
    return next() < 0.25 ? `${letters} ` : letters;
  };
  const records = (name: string): string[] => [...world.copy(name).replica.doc.getMap("tags").keys()];
  const choose = (): Action => {
    const total = Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    let roll = next() * total;
    for (const [action, weight] of Object.entries(WEIGHTS) as [Action, number][]) { roll -= weight; if (roll < 0) return action; }
    return "type";
  };
  const typingCaret = (name: string): Caret => {
    const last = carets.get(name);
    if (last && next() < 0.65 && cells(name).some(cell => cell.beat === last.beat && cell.field === last.field) && last.at <= length(name, last.beat, last.field)) return last;
    const cell = pick(cells(name));
    return { ...cell, at: Math.floor(next() * (length(name, cell.beat, cell.field) + 1)) };
  };
  const formatPart = (name: string): Part | null => {
    const where = range(name);
    return where ? { do: "format", ...where, mark: next() < 0.7 ? "b" : "t:T1", on: next() < 0.65 } : null;
  };
  const statusPart = (name: string): Part => ({ do: "set", beat: pick(beats(name)), key: "status", value: pick(["todo", "ready", "shot"]) });
  const recordPart = (): Part => ({ do: "record", root: "tags", id: `T${++tags}`, fields: { name: `tag ${tags}`, colour: pick(["red", "blue"]) } });
  const editPart = (name: string): Part | null => {
    const list = records(name);
    return list.length ? { do: "field", root: "tags", id: pick(list), key: pick(["colour", "note"]), value: pick(["red", "blue", "green", "x"]) } : null;
  };
  const splitPart = (name: string): Part | null => {
    const options = beats(name);
    const beat = pick(options), size = length(name, beat, "audioText");
    return { do: "split", beat, at: Math.floor(next() * (size + 1)), created: `S${++created}` };
  };

  for (let step = 0; step < options.steps; step++) {
    const name = pick(names), action = choose();
    world.clock += next() < 0.15 ? 1500 : 80 + Math.floor(next() * 500);
    actions[action] = (actions[action] ?? 0) + 1;
    switch (action) {
      case "type": {
        const caret = typingCaret(name), text = word();
        world.type(name, caret.beat, caret.field, caret.at, text, next() < 0.2 ? [pick(["b", "t:T1"])] : []);
        carets.set(name, { ...caret, at: caret.at + text.length });
        break;
      }
      case "erase": {
        const caret = carets.get(name);
        if (caret && caret.at > 0 && next() < 0.6 && cells(name).some(cell => cell.beat === caret.beat && cell.field === caret.field) && caret.at <= length(name, caret.beat, caret.field)) {
          world.erase(name, caret.beat, caret.field, caret.at - 1, caret.at);
          carets.set(name, { ...caret, at: caret.at - 1 });
        } else {
          const where = range(name);
          if (where) world.erase(name, where.beat, where.field, where.from, where.to);
        }
        break;
      }
      case "replace": {
        const where = range(name);
        if (where) world.replace(name, where.beat, where.field, where.from, where.to, word().trim() || "w");
        break;
      }
      case "format": { const part = formatPart(name); if (part) world.command(name, [part]); break; }
      case "status": world.command(name, [statusPart(name)]); break;
      case "field": world.command(name, [{ do: "set", beat: pick(beats(name)), key: "lengthSeconds", value: Math.floor(next() * 30) }]); break;
      case "remove": {
        const beat = pick(beats(name)), record = world.copy(name).replica.beats.get(beat);
        world.command(name, [record?.has("removed") ? { do: "clear", beat, key: "removed" } : { do: "set", beat, key: "removed", value: world.removal(name, name) }]);
        break;
      }
      case "join": {
        const list = beats(name), index = 1 + Math.floor(next() * (list.length - 1)), beat = list[index];
        if (!beat) break;
        const record = world.copy(name).replica.beats.get(beat);
        world.command(name, [record?.has("joined") ? { do: "clear", beat, key: "joined" } : { do: "set", beat, key: "joined", value: { into: list[index - 1], glue: " " } }]);
        break;
      }
      case "split": { const part = splitPart(name); if (part) world.command(name, [part]); break; }
      case "record": world.command(name, [recordPart()]); break;
      case "edit": { const part = editPart(name); if (part) world.command(name, [part]); break; }
      case "compound": {
        const caret = typingCaret(name);
        const parts: (Part | null)[] = [statusPart(name), formatPart(name), { do: "insert", beat: caret.beat, field: caret.field, at: caret.at, text: word() }, next() < 0.5 ? recordPart() : editPart(name)];
        if (next() < 0.3) parts.push(splitPart(name));
        world.command(name, parts.filter((part): part is Part => part !== null).filter((part, index, all) => all.findIndex(other => other.do === part.do) === index));
        carets.delete(name);
        break;
      }
      case "undo": world.undo(name); carets.delete(name); break;
      case "redo": world.redo(name); carets.delete(name); break;
    }
    const pairs = names.flatMap(from => names.filter(to => to !== from).map(to => [from, to] as const));
    if (options.pace === "continuous") {
      for (const [from, to] of pairs) if (next() < 0.7) world.deliver(from, to, pick(options.modes), 1 + Math.floor(next() * 2));
    } else if (next() < 0.4) {
      const [from, to] = pick(pairs);
      world.deliver(from, to, pick(options.modes));
    }
    if ((step + 1) % (options.checkEvery ?? 15) === 0 || step === options.steps - 1) {
      world.settle(pick(options.modes));
      losses = world.check(`step ${step + 1}`);
    }
  }
  return { stats: world.stats, losses, history: world.history, steps: world.steps, actions, clients };
}

export function replay(steps: readonly Step[], options: WorldOptions = {}): World {
  const world = new World(HISTORY_ROWS, options);
  for (const step of steps) {
    if (step.act === "settle") { world.settle(step.mode); continue; }
    if (step.act === "deliver") { world.deliver(step.from, step.to, step.mode, step.count); continue; }
    world.clock = step.at;
    if (!playable(world, step)) continue;
    if (step.act === "type") world.type(step.by, step.beat, step.field, step.offset, step.text, step.marks);
    else if (step.act === "erase") world.erase(step.by, step.beat, step.field, step.from, step.to);
    else if (step.act === "replace") world.replace(step.by, step.beat, step.field, step.from, step.to, step.text);
    else if (step.act === "command") world.command(step.by, step.parts);
    else if (step.act === "undo") world.undo(step.by);
    else world.redo(step.by);
  }
  return world;
}

// why: a shortened history can name a beat, a cell or a record its copy no longer holds; such a step is left out
function playable(world: World, step: Exclude<Step, { act: "settle" | "deliver" }>): boolean {
  const replica = world.copy(step.by).replica;
  const has = (beat: string, field: NativeField, to: number): boolean => {
    if (!replica.blocks().some(block => block.kind === "b" && block.id === beat)) return false;
    if (field === "visualText" && !replica.visuals.has(beat)) return false;
    const cell = replica.cell(beat, field);
    return to <= cell.end - cell.start;
  };
  switch (step.act) {
    case "type": return has(step.beat, step.field, step.offset);
    case "erase": case "replace": return has(step.beat, step.field, step.to);
    case "command": return step.parts.every(part => {
      if (part.do === "insert") return has(part.beat, part.field, part.at);
      if (part.do === "delete" || part.do === "format") return has(part.beat, part.field, part.to);
      if (part.do === "split") return has(part.beat, "audioText", part.at) && !replica.beats.has(part.created);
      if (part.do === "set" || part.do === "clear") return replica.beats.has(part.beat) && (part.do === "set" || replica.beat(part.beat).has(part.key));
      if (part.do === "record") return !replica.doc.getMap(part.root).has(part.id);
      return replica.doc.getMap(part.root).has(part.id);
    });
    default: return true;
  }
}

// why: steps are dropped in halves, then quarters, down to one, keeping each drop after which the property holds
export function minimize(steps: readonly Step[], holds: (steps: readonly Step[]) => boolean): Step[] {
  let current = [...steps];
  for (let size = Math.max(1, Math.floor(current.length / 2)); size >= 1; size = Math.floor(size / 2)) {
    for (let start = 0; start < current.length;) {
      const candidate = [...current.slice(0, start), ...current.slice(start + size)];
      if (holds(candidate)) current = candidate; else start += size;
    }
  }
  return current;
}
