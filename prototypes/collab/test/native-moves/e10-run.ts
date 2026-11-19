import { isDeepStrictEqual as equal } from "node:util";
import * as Y from "yjs";
import { MoveReplica } from "../../src/native-moves/ranks.ts";
import type { MoveDesign, RankDrop } from "../../src/native-moves/ranks.ts";
import { UndoLayer } from "../../src/native-undo/layer.ts";
import { joinUp } from "../../src/native/rows.ts";
import { nativeMarkName } from "../../src/native/variant.ts";
import type { NativeDeltaItem } from "../../src/native/variant.ts";
import { randomFor } from "../native/e5-histories.ts";
import type { E5Delivery } from "../native/e5-histories.ts";
import { required } from "../native/e5-model.ts";
import { compile, seedBlocks } from "./e10-model.ts";
import type { E10Command, E10Event, E10Facts, E10History, E10Step, E10View } from "./e10-model.ts";

const heading = (id: string): string => id.slice(1);
const delta = (text: Y.Text): NativeDeltaItem[] => text.toDelta() as NativeDeltaItem[];
const stringOf = (items: NativeDeltaItem[]): string => items.map(item => typeof item.insert === "string" ? item.insert : "").join("");
const fields = (record: Y.Map<unknown>): Record<string, unknown> => Object.fromEntries([...record].filter(([key]) =>
  key !== "place" && key !== "joined" && key !== "e10Rank"));

export function seed(design: MoveDesign): Uint8Array {
  const replica = new MoveReplica(900, design);
  replica.doc.transact(() => {
    let tape: Y.Text | undefined;
    for (const [id, item] of Object.entries(seedBlocks)) {
      if (id.startsWith("#") || id === "D") {
        const key = id.startsWith("#") ? `scene-${heading(id)}` : "beat-D", segment = new Y.Map<unknown>();
        tape = new Y.Text();
        replica.segments.set(key, segment);
        segment.set("head", id.startsWith("#") ? { h: heading(id) } : { b: id });
        segment.set("text", tape);
        replica.order.push([key]);
      } else if (tape) tape.insertEmbed(tape.length, { b: id });
      const text = required(tape, "seed segment");
      text.insert(text.length, item.audioText, {});
      if (id.startsWith("#")) replica.headings.set(heading(id), new Y.Map());
      else {
        replica.beats.set(id, new Y.Map(Object.entries(item.fields)));
        replica.visuals.set(id, new Y.Text(item.visualText));
      }
    }
  }, "hydration");
  replica.initializeRanks();
  const result = replica.encode();
  replica.destroy();
  return result;
}

export function load(design: MoveDesign, bytes: Uint8Array, client = 1): MoveReplica {
  const replica = new MoveReplica(client, design);
  Y.applyUpdate(replica.doc, bytes, "remote");
  replica.changes();
  return replica;
}

function edit(replica: MoveReplica, undo: UndoLayer, command: E10Command): void {
  if (command.op === "undo" || command.op === "redo") {
    undo[command.op]();
    return;
  }
  if (command.op === "type") {
    undo.command(() => { replica.splice(command.id, command.field, command.at, command.at, [{ text: command.text, marks: {} }]); });
    return;
  }
  undo.command(() => {
    if (command.op === "move") {
      const { unit, first, target, ...rest } = command.drop;
      const drop: RankDrop = { first: unit === "scene" ? heading(first) : first, target: unit === "scene" && target ? heading(target) : target, unit, ...rest };
      replica.drop(drop);
    } else if (command.op === "split") replica.split(command.id, command.at, command.newId);
    else if (command.op === "join") joinUp(replica, command.id);
    else if (command.op === "unjoin") replica.unjoin(command.id);
    else if (command.op === "delete") replica.deleteBeat(command.id);
    else if (command.op === "heading") replica.createHeading(command.id, heading(command.newId), command.text);
    else if (command.op === "removeHeading") replica.removeHeading(heading(command.id));
    else if (command.op === "rename") replica.typeHeading(heading(command.id), command.at, command.text);
    else if (command.op === "field") replica.setField(command.id, command.key, command.value);
    else if (command.op === "format" || command.op === "tag") replica.format(command.id, "audioText", command.from, command.to, { [command.key]: true });
  });
}

interface Inspection {
  facts: E10Facts;
  view: E10View;
  problems: string[];
  raw?: unknown;
}

interface SharedState {
  order: string[];
  segments: Record<string, { head?: Record<string, string>; text: NativeDeltaItem[]; [key: string]: unknown }>;
  beats: Record<string, Record<string, unknown>>;
  headings: Record<string, Record<string, unknown>>;
  visuals: Record<string, NativeDeltaItem[]>;
}

function sharedState(replica: MoveReplica): SharedState {
  return JSON.parse(JSON.stringify({
    order: replica.order.toArray(),
    segments: Object.fromEntries([...replica.segments].map(([id, record]) => {
      const text = record.get("text");
      return [id, { ...record.toJSON(), text: text instanceof Y.Text ? delta(text) : [] }];
    })),
    beats: replica.beats.toJSON(), headings: replica.headings.toJSON(),
    visuals: Object.fromEntries([...replica.visuals].map(([id, text]) => [id, delta(text)]))
  })) as SharedState;
}

function checkWrites(state: ReturnType<typeof sharedState>, before: ReturnType<typeof sharedState>, event: E10Event, design: MoveDesign): string[] {
  const raw: E10Facts = {}, failures: string[] = [];
  const boundary = (value: Record<string, unknown>): void => {
    if (typeof value.b === "string") raw[`id/${value.b}`] = true;
    if (typeof value.h === "string") raw[`id/#${value.h}`] = true;
  };
  const letters = (items: NativeDeltaItem[], field: string): void => {
    for (const { insert, attributes } of items) {
      if (typeof insert !== "string") { boundary(insert); continue; }
      for (const char of insert) {
        raw[`letter/${char}`] = field;
        for (const [mark, value] of Object.entries(attributes ?? {})) {
          if (value === true) raw[`mark/${char}/${nativeMarkName(mark)}`] = true;
        }
      }
    }
  };
  for (const key of state.order) {
    const segment = state.segments[key];
    if (!segment) { failures.push(`missing segment ${key}`); continue; }
    if (segment.head) boundary(segment.head);
    letters(segment.text, "narration");
  }
  for (const text of Object.values(state.visuals)) letters(text, "visual");
  for (const [id, record] of Object.entries(state.beats)) {
    if (record.joined && raw[`id/${id}`]) raw[`join/${id}`] = true;
    for (const [key, value] of Object.entries(record)) {
      if (key !== "place" && key !== "joined" && key !== "e10Rank") raw[`field/${id}/${key}`] = value;
    }
  }
  for (const [id, record] of Object.entries(state.headings)) {
    if (record.removed && raw[`id/#${id}`]) raw[`hide/#${id}`] = true;
  }
  for (const key of Object.keys(raw)) {
    if (!key.startsWith("id/")) continue;
    const id = key.slice(3), record = id.startsWith("#") ? state.headings[heading(id)] : state.beats[id];
    if (!record || (!id.startsWith("#") && !(id in state.visuals))) failures.push(`missing cell or record ${id}`);
    if (design === "flat" && typeof record?.e10Rank !== "string") failures.push(`missing rank ${id}`);
  }
  const { command } = event;
  if (command.op === "delete" && (state.beats[command.id] || state.visuals[command.id])) failures.push("beat record or cell still stored after delete");
  if (command.op === "heading" && design === "run") {
    const id = heading(command.newId);
    if (!Object.values(state.segments).some(segment => segment[`e10Cut:h:${id}`] ||
        (segment.head?.h === id && typeof segment.e10Base === "string"))) failures.push("heading did not start a run");
  }
  if (command.op === "split" && design === "placement") {
    for (const [key, records] of [["b", before.beats], ["h", before.headings]] as const) {
      for (const [id, record] of Object.entries(records)) {
        const place = record.place as { a: string } | undefined;
        const after = (key === "b" ? state.beats : state.headings)[id]?.place as { a: string } | undefined;
        if (place?.a === `b:${command.id}` && after?.a !== `b:${command.newId}`) failures.push(`placement of ${id} did not follow the split`);
      }
    }
  }
  return [...failures, ...diff(raw, event.expected)];
}

function inspect(replica: MoveReplica, withRaw: boolean): Inspection {
  const facts: E10Facts = {}, cells: Record<string, string> = {}, problems: string[] = [];
  const present = (key: string, value: unknown): void => {
    if (key in facts) problems.push(`duplicate ${key}`);
    else facts[key] = value;
  };
  const letters = (items: NativeDeltaItem[], field: "narration" | "visual"): void => {
    for (const { insert, attributes } of items) {
      if (typeof insert !== "string") { problems.push(`unexpected embed in ${field}`); continue; }
      for (const char of insert) {
        present(`letter/${char}`, field);
        const marks = new Set(Object.entries(attributes ?? {}).filter(([, value]) => value === true).map(([key]) => nativeMarkName(key)));
        for (const mark of marks) present(`mark/${char}/${mark}`, true);
      }
    }
  };
  const ordered = replica.blocks();
  const order = ordered.map(block => block.kind === "h" ? "#" + block.id : block.id)
    .filter(id => !id.startsWith("#") || !replica.headings.get(heading(id))?.get("removed"));
  const visible = replica.outline(), rows: E10View["rows"] = [];
  let scene: string | null = null, first = true;
  const shown: string[] = [];
  for (const item of visible) {
    if (item.kind === "heading") {
      scene = "#" + item.id;
      first = true;
      shown.push(scene);
      cells[scene] = stringOf(item.name);
      letters(item.name, "narration");
    } else {
      const { id, members, parts, fields: projectedFields } = item.row;
      rows.push({ id, scene, start: first || projectedFields.paragraphStart === true, members });
      first = false;
      shown.push(...members);
      for (const [key, field, category] of [["audio", "audioText", "narration"], ["visual", "visualText", "visual"]] as const) {
        const text = stringOf(item.row[key]);
        let index = 0;
        for (const { beat, length } of parts[key]) {
          const displayed = text.slice(index, index + length);
          index += length;
          if (beat === null) continue;
          const cell = replica.cell(beat, field), stored = delta(cell.text).flatMap(part =>
            typeof part.insert === "string" ? part.insert.split("") : ["\u0000"]);
          if (stored.slice(cell.start, cell.end).join("") !== displayed) problems.push(`wrong editor range for ${beat} ${field}`);
          if (field === "audioText") cells[beat] = displayed;
        }
        if (text.length !== index) problems.push(`wrong parts for ${id} ${field}`);
        let offset = 0;
        const keep = new Set(parts[key].flatMap(part => {
          const start = offset;
          offset += part.length;
          return part.beat ? Array.from({ length: part.length }, (_, i) => start + i) : [];
        }));
        let cursor = 0;
        for (const part of item.row[key]) {
          if (typeof part.insert !== "string") { problems.push("unexpected row embed"); continue; }
          const insert = [...part.insert].filter(() => keep.has(cursor++)).join("");
          letters([{ ...part, insert }], category);
        }
      }
    }
  }
  if (!equal(order, shown)) problems.push(`outline order ${shown.join(" ")} versus blocks ${order.join(" ")}`);
  for (const item of replica.headingRecovery()) {
    cells["#" + item.id] = stringOf(item.name);
    letters(item.name, "narration");
  }
  for (const block of ordered) {
    const id = block.kind === "h" ? "#" + block.id : block.id;
    present(`id/${id}`, true);
    if (block.kind === "h") {
      const record = replica.headings.get(block.id);
      if (!record) problems.push(`missing heading record ${id}`);
      else if (record.get("removed")) present(`hide/${id}`, true);
    } else {
      if (!replica.beats.has(id) || !replica.visuals.has(id)) problems.push(`missing record or visual cell for ${id}`);
      if (replica.joined(id)) present(`join/${id}`, true);
    }
  }
  for (const [id, record] of replica.beats) {
    for (const [key, value] of Object.entries(fields(record))) present(`field/${id}/${key}`, value);
  }
  for (const [id, text] of replica.visuals) {
    if (!order.includes(id) && text.length) problems.push(`unreachable visual cell ${id} (${text.toString()})`);
  }
  if (replica.unownedNarration().length) problems.push("unreachable narration before a segment's first beat");
  const raw = withRaw ? sharedState(replica) : undefined;
  return { facts, view: { order, rows, cells }, problems, raw };
}

function diff(actual: E10Facts, expected: E10Facts): string[] {
  return Object.keys({ ...actual, ...expected }).filter(key => !equal(actual[key], expected[key]))
    .map(key => `${key} expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`);
}

function compare(actual: Inspection, expected: E10Facts, view?: E10View): string[] {
  return [...actual.problems, ...diff(actual.facts, expected),
    ...(view && !equal(actual.view, view) ? [`view expected ${JSON.stringify(view)}, got ${JSON.stringify(actual.view)}`] : [])];
}

type Api = "map.set" | "map.delete" | "text.insert" | "text.embed" | "text.delete" | "text.format" | "array.insert" | "undo" | "redo";
interface Call { api: Api; key: string }
const interfaces = [
  ["map.set", Y.Map.prototype, "set"], ["map.delete", Y.Map.prototype, "delete"],
  ["text.insert", Y.Text.prototype, "insert"], ["text.embed", Y.Text.prototype, "insertEmbed"],
  ["text.delete", Y.Text.prototype, "delete"], ["text.format", Y.Text.prototype, "format"],
  ["array.insert", Y.Array.prototype, "insert"], ["undo", Y.UndoManager.prototype, "undo"], ["redo", Y.UndoManager.prototype, "redo"]
] as const;

function trace(run: () => void, calls: Call[], muted = -1): void {
  const restore = interfaces.map(([api, methods, name]) => {
    const prototype = methods as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = required(prototype[name], api);
    prototype[name] = function (...args: unknown[]) {
      const key = api.startsWith("map.") ? String(args[0]).replace(/^e10Cut:.+$/, "run cut") : "";
      const index = calls.push({ api, key }) - 1;
      if (index !== muted) return original.apply(this, args);
      return api === "map.set" ? args[1] : null;
    };
    return () => { prototype[name] = original; };
  });
  try { run(); } finally { restore.forEach(reset => { reset(); }); }
}

interface ControlStats { used: number; effective: number; failed: number; throws: number; coverage: number; storageOnly: number }
export interface E10Run {
  problems: string[];
  local: string[];
  preferences: string[];
  view?: E10View;
  presses: Record<string, string>;
  controls: Record<string, ControlStats>;
  failureHistory?: E10Step[];
}
interface ReplayState { replica: MoveReplica; undo: UndoLayer; seen: Set<number>; updates: Uint8Array[] }
const shuffled = (packets: Uint8Array[], random: () => number): Uint8Array[] => {
  const result = packets.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [required(result[j], "shuffled packet"), required(result[i], "packet to shuffle")];
  }
  return result;
};

export function run(design: MoveDesign, history: E10History, delivery: E5Delivery, writers: number, controls = false): E10Run {
  const model = compile(history.steps, writers), bytes = seed(design), random = randomFor(103),
    copies: ReplayState[] = [], packets = new Map<number, Uint8Array[]>();
  const result: E10Run = { problems: [], local: [], preferences: [], presses: {}, controls: {} };
  const open = (client: number, encoded = bytes): ReplayState => {
    const replica = load(design, encoded, client), undo = new UndoLayer(replica);
    undo.manager.addToScope(replica.headings);
    const state: ReplayState = { replica, undo, seen: new Set(), updates: [] };
    replica.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === replica.origin || origin === undo.manager) state.updates.push(update);
    });
    copies.push(state);
    return state;
  };
  const send = (from: ReplayState, to: ReplayState): void => {
    const original = [...from.seen].filter(index => !to.seen.has(index)).sort((a, b) => a - b)
      .flatMap(index => required(packets.get(index), "updates for command"));
    const updates = delivery === "reverse" ? original.toReversed() : delivery === "twice" ? original.flatMap(packet => [packet, packet])
      : delivery === "shuffled" ? shuffled(original, random) : original;
    if (delivery === "state") Y.applyUpdate(to.replica.doc, Y.encodeStateAsUpdate(from.replica.doc, Y.encodeStateVector(to.replica.doc)), "remote");
    else for (const update of updates) Y.applyUpdate(to.replica.doc, update, "remote");
    for (const index of from.seen) to.seen.add(index);
  };
  const editAndObserve = (copy: ReplayState, event: E10Event, calls: Call[] | null, muted = -1): Inspection => {
    if (calls) trace(() => { edit(copy.replica, copy.undo, event.command); }, calls, muted);
    else edit(copy.replica, copy.undo, event.command);
    return inspect(copy.replica, calls !== null);
  };
  const testControls = (baseline: Inspection, before: ReturnType<typeof sharedState>, calls: Call[], event: E10Event): void => {
    const normal = baseline.raw as ReturnType<typeof sharedState>;
    const clean = !checkWrites(normal, before, event, design).length && !compare(baseline, event.expected, event.view).length;
    const targets = [...calls.entries()] as [number, Call | undefined][];
    if (calls.length > 1) targets.push([-1, undefined]);
    for (const [index, call] of targets) {
      const group = `${event.command.op} ${call ? call.api + (call.key ? " " + call.key : "") : "whole command"}`;
      const stats = result.controls[group] ??= { used: 0, effective: 0, failed: 0, throws: 0, coverage: 0, storageOnly: 0 };
      stats.used++;
      const replica = load(design, bytes, event.by + 1), undo = new UndoLayer(replica);
      undo.manager.addToScope(replica.headings);
      const target = { replica, undo, seen: new Set<number>(), updates: [] };
      try {
        for (const step of history.steps.slice(0, event.step).keys()) {
          const old = required(history.steps[step], "command prefix");
          if ("from" in old) {
            if (old.to === event.by) for (const update of packets.get(step) ?? []) Y.applyUpdate(replica.doc, update, "remote");
          } else if (old.by === event.by) edit(replica, undo, old.command);
        }
        const observed: Call[] = [];
        if (index >= 0) {
          trace(() => { edit(target.replica, target.undo, event.command); }, observed, index);
          if (!equal(observed, calls)) { stats.coverage++; continue; }
        }
        const raw = sharedState(replica);
        if (!equal(raw, normal)) {
          stats.effective++;
          if (clean && checkWrites(raw, before, event, design).length) { stats.failed++; continue; }
          const mutant = inspect(replica, false);
          if (clean && compare(mutant, event.expected, event.view).length) stats.failed++;
          else if (clean && history.kind === "undo remote edit" && event.command.op === "undo" &&
              baseline.view.order.join(" ") === "#P A B C D #Q E F G H" && !equal(mutant.view, baseline.view)) stats.failed++;
          else if (clean && history.kind === "undo remote edit" && event.command.op === "redo" &&
              history.preferred(baseline.view) && !history.preferred(mutant.view)) stats.failed++;
          else if (equal(mutant.facts, baseline.facts) && equal(mutant.view, baseline.view) && equal(mutant.problems, baseline.problems)) stats.storageOnly++;
        }
      } catch {
        stats.throws++;
      } finally {
        replica.destroy();
      }
    }
  };
  let stepIndex = -1;
  try {
    const writersOnly = Array.from({ length: writers }, (_, index) => open(index + 1));
    const waiting = open(801);
    for (const [index, step] of history.steps.entries()) {
      stepIndex = index;
      if ("from" in step) {
        const from = required(writersOnly[step.from], "sender"), to = required(writersOnly[step.to], "receiver");
        const shared = [...from.seen].filter(key => !to.seen.has(key)).sort((a, b) => a - b)
          .flatMap(key => required(packets.get(key), "shared command"));
        packets.set(index, shared);
        send(from, to);
        continue;
      }
      const event = required(model.events.find(item => item.step === index), "recorded command");
      const copy = required(writersOnly[step.by], "writer"), calls: Call[] | null = controls ? [] : null;
      const before = controls ? sharedState(copy.replica) : undefined;
      copy.updates = [];
      const actual = editAndObserve(copy, event, calls);
      copy.seen.add(index);
      packets.set(index, copy.updates);
      if (index === 0) send(copy, waiting);
      const problems = compare(actual, event.expected, event.view);
      if (problems.length) result.local.push(`step ${index} ${step.command.op}: ${problems.join("; ")}`);
      if (step.command.op === "undo" || step.command.op === "redo") {
        result.presses[index] = actual.view.order.join(" ");
        if (history.kind === "undo remote edit" && step.command.op === "undo" &&
            (actual.view.order.join(" ") !== "#P A B C D #Q E F G H" || actual.view.cells.B !== "cqd")) result.preferences.push("undo did not take B home with cqd");
        if (history.kind === "undo remote move" && actual.view.order.join(" ") !== "#P A C D #Q E F G H B") result.preferences.push("undo or redo disturbed B's later move");
      }
      if (calls && before) testControls(actual, before, calls, event);
    }
    const hub = required(writersOnly[0], "first copy");
    for (const copy of writersOnly.slice(1)) send(copy, hub);
    for (const copy of [...writersOnly.slice(1), waiting]) send(hub, copy);
    const fresh = open(802, hub.replica.encode()), final = inspect(hub.replica, true);
    result.view = final.view;
    result.problems.push(...compare(final, model.final));
    for (const copy of [...writersOnly.slice(1), waiting, fresh]) {
      const observed = inspect(copy.replica, true);
      if (!equal(observed, final)) result.problems.push(`copy ${copy.replica.doc.clientID} disagrees with the first copy`);
    }
  } catch (error) {
    result.problems.push(`step ${stepIndex} threw: ${String(error)}`);
    if (error instanceof Error && error.message.startsWith("Placement did not settle")) result.failureHistory = history.steps;
  } finally {
    for (const { replica, undo } of copies) { undo.manager.destroy(); replica.destroy(); }
  }
  return result;
}
