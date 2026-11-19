export interface Marker { kind: "b" | "h"; id: string }
type Unit = string | Marker;
export interface SegmentReading { head: Marker | null; units: Unit[] }
export interface StoredReading {
  order: string[];
  segments: Record<string, SegmentReading>;
  beats: Record<string, { status?: string; joined?: { into: string; glue: string } }>;
  visuals: Record<string, string>;
  headings: Record<string, { removed?: boolean }>;
}

export const beat = (id: string): Marker => ({ kind: "b", id });
export const heading = (id: string): Marker => ({ kind: "h", id });

export const base: StoredReading = {
  order: ["S", "T", "U", "V"],
  segments: {
    S: { head: beat("A"), units: [..."abc", beat("B"), ..."def", beat("C"), ..."ghi"] },
    T: { head: beat("D"), units: [..."jkl", heading("H"), ..."mno", beat("E"), ..."pqr"] },
    U: { head: heading("I"), units: [..."stu"] },
    V: { head: beat("F"), units: [..."vwx"] }
  },
  beats: { A: {}, B: { status: "todo" }, C: {}, D: {}, E: {}, F: {} },
  visuals: { A: "1", B: "2", C: "3", D: "4", E: "5", F: "6" },
  headings: { H: {}, I: {} }
};

export const sole: StoredReading = {
  order: ["S"], segments: { S: { head: beat("A"), units: [..."abc"] } },
  beats: { A: {} }, visuals: { A: "1" }, headings: {}
};

type Cell = "audio" | "visual" | "name";
export type DeleteCommand =
  | { op: "rows"; ids: string[] }
  | { op: "scene"; id: string }
  | { op: "heading"; id: string; removal: "flag" | "delete" }
  | { op: "type"; id: string; field: Cell; at: number; value: string }
  | { op: "erase"; id: string; field: Cell; from: number; to: number }
  | { op: "mark"; id: string; field: "audio" | "visual"; from: number; to: number; key: string }
  | { op: "field"; id: string; value: string }
  | { op: "split"; id: string; at: number; created: string }
  | { op: "insert"; before: string; created: string; value: string }
  | { op: "join"; id: string }
  | { op: "unjoin"; id: string }
  | { op: "create"; above: string; id: string; value: string };

export interface ExpectedBlock extends Marker { segment: string; from: number; to: number; text: string }
export type VisibleEntry = { heading: string; name: string } |
  { id: string; members: string[]; audio: string; visual: string; status?: string };

export function need<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Missing ${description}`);
  return value;
}

export function blocks(stored: StoredReading): ExpectedBlock[] {
  const result: ExpectedBlock[] = [];
  for (const segment of stored.order) {
    const { head, units } = need(stored.segments[segment], segment);
    let open: ExpectedBlock | undefined;
    const begin = (marker: Marker, index: number): void => {
      if (open) open.to = index - 1;
      open = { ...marker, segment, from: index, to: units.length, text: "" };
      result.push(open);
    };
    if (head) begin(head, 0);
    for (const [index, unit] of units.entries()) {
      if (typeof unit !== "string") begin(unit, index + 1);
      else if (open) open.text += unit;
    }
  }
  return result;
}

export function visible(stored: StoredReading): VisibleEntry[] {
  const result: VisibleEntry[] = [];
  let row: Extract<VisibleEntry, { id: string }> | undefined;
  for (const item of blocks(stored)) {
    const { id, kind, text } = item;
    if (kind === "h") {
      if (!stored.headings[id]?.removed) {
        result.push({ heading: id, name: text });
        row = undefined;
      }
      continue;
    }
    const record = stored.beats[id], cell = stored.visuals[id] ?? "";
    if (!record?.joined || !row) {
      row = { id, members: [], audio: "", visual: "", ...record?.status && { status: record.status } };
      result.push(row);
    }
    row.members.push(id);
    row.audio += (row.audio && text ? record?.joined?.glue ?? "" : "") + text;
    row.visual += (row.visual && cell ? "\n" : "") + cell;
  }
  return result;
}

function remove(stored: StoredReading, selected: readonly ExpectedBlock[], empty: "keep" | "drop"): void {
  const deleted = new Set(selected.map(block => block.id));
  for (const segment of [...stored.order]) {
    const positioned = blocks(stored).filter(block => block.segment === segment);
    const range = positioned.filter(block => deleted.has(block.id));
    if (!range.length) continue;
    const tape = need(stored.segments[segment], segment);
    if (empty === "drop" && range.length === positioned.length) {
      stored.order = stored.order.filter(id => id !== segment);
      Reflect.deleteProperty(stored.segments, segment);
    } else {
      const gone = new Set(range.flatMap(block =>
        Array.from({ length: block.to - Math.max(0, block.from - 1) }, (_, i) => i + Math.max(0, block.from - 1))));
      tape.units = tape.units.filter((_, index) => !gone.has(index));
      if (range.some(block => block.from === 0)) tape.head = null;
    }
  }
  for (const { kind, id } of selected) {
    if (kind === "h") Reflect.deleteProperty(stored.headings, id);
    else {
      Reflect.deleteProperty(stored.beats, id);
      Reflect.deleteProperty(stored.visuals, id);
    }
  }
}

export function advance(before: StoredReading, command: DeleteCommand, empty: "keep" | "drop"): StoredReading {
  const next = structuredClone(before);
  const position = (id: string): ExpectedBlock => need(blocks(before).find(block => block.id === id), id);
  const tape = (segment: string): SegmentReading => need(next.segments[segment], segment);
  const outline = (): VisibleEntry[] => visible(before);
  switch (command.op) {
    case "rows": {
      const ids = new Set(outline().flatMap(entry =>
        "id" in entry && command.ids.includes(entry.id) ? entry.members : []));
      remove(next, blocks(before).filter(block => ids.has(block.id)), empty);
      break;
    }
    case "scene": {
      const entries = outline(), members = new Set([command.id]);
      for (const entry of entries.slice(entries.findIndex(entry => "heading" in entry && entry.heading === command.id) + 1)) {
        if ("heading" in entry) break;
        for (const id of entry.members) members.add(id);
      }
      remove(next, blocks(before).filter(block => members.has(block.id)), empty);
      break;
    }
    case "heading":
      if (command.removal === "flag") next.headings[command.id] = { removed: true };
      else remove(next, [position(command.id)], empty);
      break;
    case "type":
    case "erase": {
      const from = command.op === "type" ? command.at : command.from;
      const count = command.op === "type" ? 0 : command.to - from;
      const insert = command.op === "type" ? [...command.value] : [];
      if (command.field === "visual") {
        const units = [...need(next.visuals[command.id], command.id)];
        units.splice(from, count, ...insert);
        next.visuals[command.id] = units.join("");
      } else {
        const where = position(command.id);
        tape(where.segment).units.splice(where.from + from, count, ...insert);
      }
      break;
    }
    case "mark": break;
    case "field": need(next.beats[command.id], command.id).status = command.value; break;
    case "join": {
      const entries = outline(), at = entries.findIndex(entry => "id" in entry && entry.id === command.id);
      const above = need(entries[at - 1], "row above");
      if (!("members" in above)) throw new Error("Expected row above");
      need(next.beats[command.id], command.id).joined = { into: need(above.members.at(-1), "last member"), glue: " " };
      break;
    }
    case "unjoin": delete need(next.beats[command.id], command.id).joined; break;
    case "split": {
      const where = position(command.id);
      tape(where.segment).units.splice(where.from + command.at, 0, beat(command.created));
      next.beats[command.created] = { status: "new" };
      next.visuals[command.created] = "";
      break;
    }
    case "insert": {
      const segment = `seg-b-${command.created}`;
      next.order.splice(next.order.indexOf(position(command.before).segment), 0, segment);
      next.segments[segment] = { head: beat(command.created), units: [...command.value] };
      next.beats[command.created] = { status: "new" };
      next.visuals[command.created] = "";
      break;
    }
    case "create": {
      const where = position(command.above);
      if (where.from === 0) {
        const segment = `seg-h-${command.id}`;
        next.order.splice(next.order.indexOf(where.segment), 0, segment);
        next.segments[segment] = { head: heading(command.id), units: [...command.value] };
      } else tape(where.segment).units.splice(where.from - 1, 0, heading(command.id), ...command.value);
      next.headings[command.id] = {};
      break;
    }
  }
  return next;
}

const key = (unit: Unit): string => typeof unit === "string" ? unit : `${unit.kind}:${unit.id}`;

function tapes<T extends Unit>(initial: readonly T[], forks: readonly (readonly T[])[]): T[][] {
  const original = initial.map(key), originals = new Set(original);
  const branches = forks.map(branch => branch.map(key));
  const values = new Map([initial, ...forks].flatMap(branch => branch.map(unit => [key(unit), unit] as const)));
  const live = new Set(original.filter(id => branches.every(branch => branch.includes(id))));
  for (const branch of branches) for (const id of branch) if (!originals.has(id)) live.add(id);
  const predecessors = new Map<string, Set<string>>();
  for (const sequence of [original, ...branches]) {
    for (const [index, id] of sequence.entries()) {
      const rules = predecessors.get(id) ?? new Set<string>();
      for (const previous of sequence.slice(0, index)) rules.add(previous);
      predecessors.set(id, rules);
    }
  }
  const before = new Map([...live].map(id => {
    const pending = [...predecessors.get(id) ?? []], visited = new Set<string>();
    while (pending.length) {
      const item = need(pending.pop(), "order dependency");
      if (visited.has(item)) continue;
      visited.add(item);
      pending.push(...predecessors.get(item) ?? []);
    }
    return [id, new Set([...visited].filter(item => live.has(item)))] as const;
  }));
  const possibilities: T[][] = [];
  const extend = (prefix: T[], remaining: ReadonlySet<string>): void => {
    if (!remaining.size) {
      possibilities.push(prefix);
      return;
    }
    for (const id of remaining) {
      if ([...need(before.get(id), id)].some(prior => remaining.has(prior))) continue;
      extend([...prefix, need(values.get(id), id)], new Set([...remaining].filter(item => item !== id)));
    }
  };
  extend([], live);
  if (!possibilities.length) throw new Error("Conflicting order constraints");
  return possibilities;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changed<T>(initial: T, values: readonly T[]): T {
  const edits = values.filter(value => !same(initial, value));
  if (edits.some(value => !same(value, edits[0]))) throw new Error("Unmodeled competing field writes");
  return edits.length ? edits[0] as T : initial;
}

function keys<T>(initial: Record<string, T>, forks: readonly Record<string, T>[]): string[] {
  return [...new Set([initial, ...forks].flatMap(Object.keys))].filter(id =>
    !(id in initial) || forks.every(fork => id in fork));
}

function records<T extends object>(initial: Record<string, T>, forks: readonly Record<string, T>[]): Record<string, T> {
  return Object.fromEntries(keys(initial, forks).map(id =>
    [id, need(changed(initial[id], forks.map(fork => fork[id] ?? initial[id])), id)]));
}

export function merge(initial: StoredReading, forks: readonly StoredReading[]): StoredReading[] {
  const segmentForks = forks.map(fork => fork.segments), visualForks = forks.map(fork => fork.visuals);
  const segments = keys(initial.segments, segmentForks);
  const beats = records(initial.beats, forks.map(fork => fork.beats));
  const headings = records(initial.headings, forks.map(fork => fork.headings));
  let readings = tapes(initial.order, forks.map(fork => fork.order)).map((order): StoredReading =>
    ({ order, segments: {}, beats, visuals: {}, headings }));
  for (const id of segments) {
    const start = initial.segments[id] ?? { head: null, units: [] };
    const versions = segmentForks.map(fork => fork[id] ?? start);
    const head = changed(start.head, versions.map(version => version.head));
    const alternatives = tapes(start.units, versions.map(version => version.units));
    readings = readings.flatMap(reading => alternatives.map(units =>
      ({ ...reading, segments: { ...reading.segments, [id]: { head, units } } })));
  }
  for (const id of keys(initial.visuals, visualForks)) {
    const start = initial.visuals[id] ?? "";
    const alternatives = tapes([...start], visualForks.map(fork => [...fork[id] ?? start]));
    readings = readings.flatMap(reading => alternatives.map(units =>
      ({ ...reading, visuals: { ...reading.visuals, [id]: units.join("") } })));
  }
  return readings;
}
