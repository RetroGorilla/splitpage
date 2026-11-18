import * as Y from "yjs";
import { NativeReplica, nativeCopy } from "../../src/native/variant.ts";
import type { NativeDeltaItem, NativeField, NativeReading, NativeRecovery, NativeRow } from "../../src/native/variant.ts";
import { deleteIn, joinUp, removeRow, restoreRow, splitAt, typeAt } from "../../src/native/rows.ts";

export type E2Field = "a" | "v";
export type E2Delivery = "forward" | "reverse" | "twice" | "shuffled" | "state";
export type E2Pick = number | string;
export type E2Step =
  | { op: "type"; by: number; row: E2Pick; field: E2Field; at: number; count?: number }
  | { op: "delete"; by: number; row: E2Pick; field: E2Field; at: number; span: number }
  | { op: "split"; by: number; row: E2Pick; at: number }
  | { op: "join"; by: number; row: E2Pick }
  | { op: "remove"; by: number; row: E2Pick }
  | { op: "restore"; by: number; entry: E2Pick }
  | { op: "flag"; by: number; beat: string; into: string }
  | { op: "deliver"; from: number; to: number };
export interface E2Beat { id: string; audio: string; visual: string }
export type E2Role = "copy" | "late" | "probe";
export interface E2Options {
  delivery?: E2Delivery; seed?: number; beats?: readonly E2Beat[]; reading?: NativeReading; probes?: number;
  tamper?: (replica: NativeReplica, role: E2Role) => void;
}
export interface E2Place { row: number; members: string[]; hidden: boolean }
export interface E2Result {
  problems: string[]; misordered: boolean; executed: number; skipped: number; labels: string[];
  rows: string[]; recovery: string[]; copies: NativeReplica[]; late: NativeReplica;
  observedTies: number; observedFlags: number; probed: number; places: Map<string, E2Place>;
}
interface ModelWrite { id: number; command: number; beat: string; key: "joined" | "removed"; set: boolean; into: string | null; glue: string; knew: Set<number>; item: string | null }
interface ModelCommand { id: number; by: number; knew: Set<number>; writes: number[] }
interface ModelPiece { beat: string | null; chars: string[] }
interface ModelRow { id: string; members: string[]; audio: ModelPiece[]; visual: ModelPiece[] }
interface ModelEntry { beat: string; reason: string; members: string[]; audio: string[]; visual: string[] }
interface ModelView { rows: ModelRow[]; entries: ModelEntry[]; line: string[]; visuals: Map<string, string[]>; beats: string[]; flags: Map<string, unknown>; reading: NativeReading }
interface Stored { line: string[]; visuals: Map<string, string[]>; beats: string[]; items: Map<string, { id: string; deleted: boolean }[]>; values: Map<string, unknown>; stray: string[] }

export const E2_BEATS: readonly E2Beat[] = [
  { id: "R1", audio: "abc", visual: "mn" }, { id: "R2", audio: "def", visual: "op" },
  { id: "R3", audio: "ghi", visual: "qr" }, { id: "R4", audio: "jkl", visual: "st" }
];
const POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const KEYS = ["joined", "removed"] as const;
export const E2_NAMES = ["#1", "#2", "#3"];

export function glyph(index: number): string {
  return index < POOL.length ? POOL.charAt(index) : String.fromCodePoint(0x4e00 + index);
}

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0x100000000; };
}

// why: what the commands alone fix about order: each new element lies between the two it was put between, and a flag
// written after others sits after them. Where they fix nothing, the first order any copy shows is held from then on
class Fences {
  private readonly after = new Map<string, Set<string>>();
  private readonly fixedAfter = new Map<string, Set<string>>();
  put(first: string, second: string, observed = false): void {
    this.after.set(first, (this.after.get(first) ?? new Set<string>()).add(second));
    if (!observed) this.fixedAfter.set(first, (this.fixedAfter.get(first) ?? new Set<string>()).add(second));
  }
  private reaches(graph: ReadonlyMap<string, Set<string>>, first: string, second: string): boolean {
    const queue = [first], seen = new Set<string>();
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) for (const char of graph.get(next) ?? []) {
      if (char === second) return true;
      if (!seen.has(char)) { seen.add(char); queue.push(char); }
    }
    return false;
  }
  precedes(first: string, second: string): boolean { return this.reaches(this.after, first, second); }
  fixed(first: string, second: string): boolean { return this.reaches(this.fixedAfter, first, second); }
  accepts(sequence: readonly string[]): boolean {
    for (let index = 1; index < sequence.length; index++) {
      const left = sequence[index - 1] as string, right = sequence[index] as string;
      if (left === right || this.precedes(right, left)) return false;
      if (!this.precedes(left, right)) this.put(left, right, true);
    }
    return true;
  }
  observedPairs(sequence: readonly string[]): number {
    let count = 0;
    for (let index = 1; index < sequence.length; index++) if (!this.fixed(sequence[index - 1] as string, sequence[index] as string)) count++;
    return count;
  }
  chain(sequence: readonly string[]): void { sequence.forEach((value, index) => { if (index) this.put(sequence[index - 1] as string, value); }); }
}

function keyItems(map: Y.Map<unknown>, key: string): { id: string; deleted: boolean }[] {
  const result: { id: string; deleted: boolean }[] = [];
  let item = (map as unknown as { _map: Map<string, Y.Item> })._map.get(key) ?? null;
  while (item) {
    for (let offset = item.length - 1; offset >= 0; offset--) result.unshift({ id: `${item.id.client}:${item.id.clock + offset}`, deleted: item.deleted });
    item = item.left as Y.Item | null;
  }
  return result;
}

function readStored(replica: NativeReplica): Stored {
  const line: string[] = [], visuals = new Map<string, string[]>(), items = new Map<string, { id: string; deleted: boolean }[]>(), values = new Map<string, unknown>();
  const listed = [...new Set(replica.order.toArray())], stray: string[] = [];
  const chars = (text: Y.Text, into: string[]): void => {
    for (const item of text.toDelta() as NativeDeltaItem[]) {
      if (typeof item.insert === "string") into.push(...item.insert);
      else into.push(typeof item.insert.b === "string" ? `b:${item.insert.b}` : "?embed");
    }
  };
  for (const key of listed) {
    const segment = replica.segments.get(key), head = segment?.get("head") as { b?: string } | undefined, text = segment?.get("text");
    line.push(typeof head?.b === "string" ? `b:${head.b}` : "?head");
    if (text instanceof Y.Text) chars(text, line);
  }
  for (const [key, segment] of replica.segments) {
    const text = segment.get("text");
    if (!listed.includes(key) && text instanceof Y.Text) chars(text, stray);
  }
  for (const [beat, text] of replica.visuals) { const cell: string[] = []; chars(text, cell); visuals.set(beat, cell); }
  for (const [beat, record] of replica.beats) for (const key of KEYS) {
    items.set(`${beat}/${key}`, keyItems(record, key));
    values.set(`${beat}/${key}`, record.get(key));
  }
  return { line, visuals, beats: [...replica.beats.keys()].sort(), items, values, stray };
}

// why: both readings, written apart from the code under test. Follow: a chain is one row, a loop breaks at its beat
// earliest in order, a chain meeting a removed beat hides with the nearest one. Contiguous: see contiguousGroups
function modelView(line: readonly string[], visuals: ReadonlyMap<string, string[]>, beats: readonly string[], flags: ReadonlyMap<string, unknown>, reading: NativeReading): ModelView {
  const flag = (beat: string, key: "joined" | "removed"): unknown => flags.get(`${beat}/${key}`);
  const order: string[] = [], narration = new Map<string, string[]>();
  for (const element of line) {
    if (element.startsWith("b:")) { order.push(element.slice(2)); narration.set(element.slice(2), []); }
    else narration.get(order.at(-1) ?? "")?.push(element);
  }
  const placed = new Set(order), rank = (beat: string): number => order.indexOf(beat);
  const join = (beat: string): { into: string; glue: string } | null => {
    const value = flag(beat, "joined") as { into?: unknown; glue?: unknown } | undefined;
    return value && typeof value.into === "string" ? { into: value.into, glue: typeof value.glue === "string" ? value.glue : "" } : null;
  };
  const up = new Map<string, string | null>();
  for (const beat of order) { const into = join(beat)?.into; up.set(beat, into && into !== beat && placed.has(into) ? into : null); }
  const loops = new Set<string>();
  for (const beat of order) {
    let current: string | null = beat;
    for (let step = 0; step <= order.length && current !== null; step++) current = up.get(current) ?? null;
    if (current === null) continue;
    const cycle = [current];
    for (let next = up.get(current) ?? null; next !== null && next !== current; next = up.get(next) ?? null) cycle.push(next);
    loops.add(cycle.sort((left, right) => rank(left) - rank(right))[0] as string);
  }
  for (const beat of loops) up.set(beat, null);
  if (reading === "contiguous") loops.clear();
  const groups = reading === "contiguous" ? contiguousGroups(order, beat => join(beat) !== null, beat => flag(beat, "removed") !== undefined) : new Map<string, { hidden: boolean; members: string[] }>();
  if (reading === "follow") for (const beat of order) {
    let current = beat, next = up.get(beat) ?? null;
    while (flag(current, "removed") === undefined && next !== null) { current = next; next = up.get(current) ?? null; }
    const head = { id: current, hidden: flag(current, "removed") !== undefined };
    const group = groups.get(head.id) ?? { hidden: head.hidden, members: [] };
    group.members.push(beat); groups.set(head.id, group);
  }
  const pieces = (head: string, members: readonly string[]): { audio: ModelPiece[]; visual: ModelPiece[] } => {
    const audio: ModelPiece[] = [], visual: ModelPiece[] = [];
    let spoken = 0, shown = 0;
    for (const member of members) {
      const words = narration.get(member) ?? [], cell = visuals.get(member) ?? [], glue = member === head ? "" : join(member)?.glue ?? "";
      if (glue && spoken && words.length) audio.push({ beat: null, chars: [...glue] });
      audio.push({ beat: member, chars: words }); spoken += words.length;
      if (shown && cell.length) visual.push({ beat: null, chars: ["\n"] });
      visual.push({ beat: member, chars: cell }); shown += cell.length;
    }
    return { audio, visual };
  };
  const rows: ModelRow[] = [], entries: ModelEntry[] = [];
  for (const beat of beats) if (!placed.has(beat) && (visuals.get(beat) ?? []).length) entries.push({ beat, reason: "unplaced", members: [beat], audio: [], visual: visuals.get(beat) ?? [] });
  for (const [id, group] of groups) {
    const built = pieces(id, group.members);
    if (!group.hidden) { rows.push({ id, members: group.members, ...built }); continue; }
    entries.push({ beat: id, reason: "removed", members: group.members, audio: built.audio.flatMap(piece => piece.chars), visual: built.visual.flatMap(piece => piece.chars) });
  }
  for (const beat of [...loops].sort((left, right) => rank(left) - rank(right))) entries.push({ beat, reason: "loop", members: [beat], audio: [], visual: [] });
  return { rows, entries, line: [...line], visuals: new Map(visuals), beats: [...beats], flags: new Map(flags), reading };
}

// why: the second reading: a join flag hides only the boundary above its beat. A shown joined beat goes to the last
// shown row above it; a removed joined beat goes with the removed beat right above it, else heads its own entry
function contiguousGroups(order: readonly string[], joined: (beat: string) => boolean, removed: (beat: string) => boolean): Map<string, { hidden: boolean; members: string[] }> {
  const groups = new Map<string, { hidden: boolean; members: string[] }>();
  const shownHeads: string[] = [], hiddenHeads: string[] = [];
  order.forEach((beat, index) => {
    const gone = removed(beat), previous = order[index - 1];
    let head = beat;
    if (gone && joined(beat) && previous !== undefined && removed(previous)) head = hiddenHeads.at(-1) ?? beat;
    if (!gone && joined(beat) && shownHeads.length) head = shownHeads.at(-1) ?? beat;
    if (head === beat) (gone ? hiddenHeads : shownHeads).push(beat);
    const group = groups.get(head) ?? { hidden: gone, members: [] };
    group.members.push(beat); groups.set(head, group);
  });
  return groups;
}

const flat = (pieces: readonly ModelPiece[]): string => pieces.map(piece => piece.chars.join("")).join("");
const plain = (delta: readonly NativeDeltaItem[]): string => delta.map(item => typeof item.insert === "string" ? item.insert : "￼").join("");

function printRow(row: { id: string; members: readonly string[]; audio: string; visual: string }): string {
  return `${row.id}${row.members.length > 1 ? `(${row.members.join("+")})` : ""}: ${row.audio}${row.visual ? ` / ${row.visual.replace(/\n/g, "|")}` : ""}`;
}

function printEntry(entry: { beat: string; reason: string; members: readonly string[]; audio: string; visual: string }): string {
  return `${entry.reason} ${entry.beat}${entry.members.length > 1 ? `(${entry.members.join("+")})` : ""}: ${entry.audio}${entry.visual ? ` / ${entry.visual.replace(/\n/g, "|")}` : ""}`;
}

export function shownRows(replica: NativeReplica): string[] {
  return replica.rows().map(row => printRow({ id: row.id, members: row.members, audio: plain(row.audio), visual: plain(row.visual) }));
}

export function shownRecovery(replica: NativeReplica): string[] {
  return replica.recovery().map(entry => printEntry({ beat: entry.beat, reason: entry.reason, members: entry.members, audio: plain(entry.audio), visual: plain(entry.visualItems) }));
}

function modelRows(view: ModelView): string[] {
  return view.rows.map(row => printRow({ id: row.id, members: row.members, audio: flat(row.audio), visual: flat(row.visual) }));
}

function modelEntries(view: ModelView): string[] {
  return view.entries.map(entry => printEntry({ ...entry, audio: entry.audio.join(""), visual: entry.visual.join("") }));
}

function spot(row: ModelRow, field: E2Field, at: number): { beat: string; offset: number; seam: string | null } {
  const ranges: { beat: string; start: number; end: number }[] = [];
  let position = 0;
  for (const piece of field === "a" ? row.audio : row.visual) {
    if (piece.beat !== null) ranges.push({ beat: piece.beat, start: position, end: position + piece.chars.length });
    position += piece.chars.length;
  }
  for (const [index, range] of ranges.entries()) {
    const next = ranges[index + 1];
    if (next && range.end <= at && at <= next.start) return { beat: range.beat, offset: range.end - range.start, seam: next.beat };
  }
  const inside = ranges.find(range => range.start <= at && at <= range.end) ?? ranges[ranges.length - 1] as { beat: string; start: number; end: number };
  return { beat: inside.beat, offset: Math.max(0, Math.min(at - inside.start, inside.end - inside.start)), seam: null };
}

// why: copies made only from the stored state; the generator issues commands as a person would, on rows shown
export function runE2(steps: readonly E2Step[], options: E2Options = {}): E2Result {
  const delivery = options.delivery ?? "forward", random = rng(options.seed ?? 7), beats = options.beats ?? E2_BEATS, reading = options.reading ?? "follow";
  const seed = new NativeReplica(900);
  seed.hydrate({ rows: beats.map(beat => ({ id: beat.id, audioText: beat.audio, visualText: beat.visual })) });
  const copies = E2_NAMES.map((_, index) => { const copy = nativeCopy(seed, index + 1); copy.reading = reading; copy.changes(); return copy; });
  seed.destroy();
  const fences = new Fences(), commands: ModelCommand[] = [], writes: ModelWrite[] = [];
  const born = new Map<string, number>(), died = new Map<string, number[]>(), home = new Map<string, string>(), beatBorn = new Map<string, number>();
  const initial: string[] = [];
  for (const beat of beats) {
    initial.push(`b:${beat.id}`, ...beat.audio);
    fences.chain([...beat.visual]); beatBorn.set(beat.id, -1);
    for (const char of beat.visual) { born.set(char, -1); home.set(char, beat.id); }
  }
  fences.chain(initial);
  for (const element of initial) born.set(element, -1);
  const known = copies.map(() => new Set<number>([-1]));
  const logs = copies.map((): Uint8Array[] => []), has = copies.map(() => copies.map(() => 0));
  copies.forEach((replica, index) => replica.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") logs[index]?.push(update); }));
  const problems: string[] = [], labels: string[] = [];
  let next = 0, created = 0, executed = 0, skipped = 0;

  const alive = (element: string, seen: ReadonlySet<number>): boolean => seen.has(born.get(element) ?? -2) && !(died.get(element) ?? []).some(command => seen.has(command));
  let observed: Set<string> | null = null;
  const verify = (replica: NativeReplica, seen: ReadonlySet<number>, who: string): ModelView | null => {
    const stored = readStored(replica), fail = (message: string): null => { problems.push(`${who}: ${message}`); return null; };
    const wanted = [...born.keys()].filter(element => !home.has(element) && alive(element, seen));
    if (stored.line.length !== new Set(stored.line).size) return fail(`a narration element is there twice: ${stored.line.join("")}`);
    if (stored.line.length !== wanted.length || stored.line.some(element => !wanted.includes(element))) return fail(`narration holds ${stored.line.join("")}, the commands call for ${wanted.join("")}`);
    if (!fences.accepts(stored.line)) return fail(`narration order ${stored.line.join("")} breaks an order the commands fixed or an order already shown`);
    const present = [...beatBorn].filter(([, command]) => seen.has(command)).map(([beat]) => beat).sort();
    if (JSON.stringify(present) !== JSON.stringify(stored.beats)) return fail(`beat records ${stored.beats.join(",")}, the commands call for ${present.join(",")}`);
    for (const beat of present) {
      const cell = stored.visuals.get(beat) ?? [], expected = [...home].filter(([char, owner]) => owner === beat && alive(char, seen)).map(([char]) => char);
      if (cell.length !== new Set(cell).size || cell.length !== expected.length || cell.some(char => !expected.includes(char))) return fail(`visual ${beat} holds ${cell.join("")}, the commands call for ${expected.join("")}`);
      if (!fences.accepts(cell)) return fail(`visual ${beat} order ${cell.join("")} breaks a fixed or shown order`);
    }
    const flags = new Map<string, unknown>();
    for (const beat of present) for (const key of KEYS) {
      const mine = writes.filter(write => write.beat === beat && write.key === key && seen.has(write.command)), sets = mine.filter(write => write.set);
      const items = stored.items.get(`${beat}/${key}`) ?? [], listed = items.map(item => sets.find(write => write.item === item.id));
      if (listed.some(write => !write) || listed.length !== sets.length) return fail(`${beat}.${key} holds ${items.map(item => item.id).join(",")}, the commands wrote ${sets.map(write => write.item).join(",")}`);
      const ordered = listed as ModelWrite[];
      if (!fences.accepts(ordered.map(write => `w:${write.id}`))) return fail(`${beat}.${key} writes in an order that breaks one fixed or shown`);
      const last = ordered.at(-1), over = last ? mine.some(write => write.knew.has(last.id)) : true;
      const value = last && !over ? (key === "joined" ? { into: last.into, glue: last.glue } : true) : undefined;
      // why: the outcomes the commands allow: any set nobody overwrote or deleted, and no value when one of those may sit
      // left of a set someone deleted; only when several remain does the order the library gave them decide
      const shape = (set: ModelWrite): string => JSON.stringify(key === "joined" ? { into: set.into, glue: set.glue } : true);
      const standing = sets.filter(set => !mine.some(other => other.knew.has(set.id)));
      const deleted = sets.filter(set => mine.some(other => !other.set && other.knew.has(set.id)));
      const outcomes = new Set(standing.map(shape));
      if (!standing.length || standing.some(set => deleted.some(gone => !set.knew.has(gone.id)))) outcomes.add("none");
      if (!outcomes.has(value === undefined ? "none" : JSON.stringify(value))) return fail(`${beat}.${key} is ${JSON.stringify(value)}, the commands allow ${[...outcomes].join(" or ")}`);
      if (outcomes.size > 1) observed?.add(`${beat}.${key}`);
      const raw = stored.values.get(`${beat}/${key}`) as { into?: string; glue?: string } | undefined;
      const same = value === undefined ? raw === undefined : key === "removed" ? raw !== undefined
        : raw?.into === (value as { into: string }).into && raw?.glue === (value as { glue: string }).glue;
      if (!same) return fail(`${beat}.${key} is ${JSON.stringify(raw)}, the commands and the held order call for ${JSON.stringify(value)}`);
      if (items.some((item, index) => item.deleted !== (index < items.length - 1 || over))) return fail(`${beat}.${key} keeps a write the library should have dropped`);
      flags.set(`${beat}/${key}`, value);
    }
    const view = modelView(stored.line, stored.visuals, present, flags, reading);
    const rows = shownRows(replica), wantRows = modelRows(view), entries = shownRecovery(replica), wantEntries = modelEntries(view);
    if (JSON.stringify(rows) !== JSON.stringify(wantRows)) return fail(`rows ${JSON.stringify(rows)}, the model reads ${JSON.stringify(wantRows)}`);
    const unplaced = (list: string[]): string => JSON.stringify([...list.filter(item => item.startsWith("unplaced")).sort(), ...list.filter(item => !item.startsWith("unplaced"))]);
    if (unplaced(entries) !== unplaced(wantEntries)) return fail(`recovery ${JSON.stringify(entries)}, the model reads ${JSON.stringify(wantEntries)}`);
    return view;
  };

  const pick = <T extends { id: string }>(list: readonly T[], choice: E2Pick): T | undefined =>
    typeof choice === "string" ? list.find(item => item.id === choice) : list.length ? list[((choice % list.length) + list.length) % list.length] : undefined;
  const write = (command: ModelCommand, by: number, beat: string, key: "joined" | "removed", set: boolean, into: string | null = null, glue = " "): void => {
    const knew = new Set(writes.filter(other => other.beat === beat && other.key === key && known[by]?.has(other.command)).map(other => other.id));
    const record: ModelWrite = { id: writes.length, command: command.id, beat, key, set, into, glue, knew, item: null };
    for (const id of knew) if (writes[id]?.set && set) fences.put(`w:${id}`, `w:${record.id}`);
    writes.push(record); command.writes.push(record.id);
  };
  const repoint = (command: ModelCommand, by: number, row: ModelRow, from: number, begins: string, flags: (beat: string) => { into: string; glue: string } | null): void => {
    if (reading === "contiguous") return;
    const earlier = new Set(row.members.slice(0, from));
    for (const member of row.members.slice(from)) {
      const join = flags(member);
      if (member !== begins && join && earlier.has(join.into)) write(command, by, member, "joined", true, begins, join.glue);
    }
  };
  const transfer = (from: number, to: number, position: number): void => {
    const source = copies[from] as NativeReplica, target = copies[to] as NativeReplica;
    if (delivery === "state") Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc, Y.encodeStateVector(target.doc)), "remote");
    else {
      const batch: Uint8Array[] = [];
      copies.forEach((_, sender) => {
        const upTo = sender === from ? logs[sender]?.length ?? 0 : has[from]?.[sender] ?? 0, start = has[to]?.[sender] ?? 0;
        batch.push(...(logs[sender] ?? []).slice(start, upTo));
        if (upTo > start) (has[to] as number[])[sender] = upTo;
      });
      let sequence = batch;
      if (delivery === "reverse" || (delivery === "shuffled" && position % 2)) sequence = [...batch].reverse();
      if (delivery === "twice") sequence = batch.flatMap(update => [update, update]);
      if (delivery === "shuffled") {
        sequence = [...sequence];
        for (let index = sequence.length - 1; index > 0; index--) { const swap = Math.floor(random() * (index + 1)); [sequence[index], sequence[swap]] = [sequence[swap] as Uint8Array, sequence[index] as Uint8Array]; }
        for (const update of batch) if (random() < 0.3) sequence.splice(Math.floor(random() * (sequence.length + 1)), 0, update);
      }
      for (const update of sequence) Y.applyUpdate(target.doc, update, "remote");
    }
    target.changes();
    for (const command of known[from] ?? []) known[to]?.add(command);
  };

  for (const [position, step] of steps.entries()) {
    if (problems.length) break;
    if (step.op === "deliver") {
      if (step.from !== step.to && copies[step.from] && copies[step.to]) { transfer(step.from, step.to, position); labels.push(`${E2_NAMES[step.from]} sends to ${E2_NAMES[step.to]}`); }
      continue;
    }
    const replica = copies[step.by], seen = known[step.by];
    if (!replica || !seen) continue;
    const view = verify(replica, seen, `${E2_NAMES[step.by]} before step ${position}`);
    if (!view) break;
    const flags = (beat: string): { into: string; glue: string } | null => {
      const value = view.flags.get(`${beat}/joined`) as { into?: string; glue?: string } | undefined;
      return value && typeof value.into === "string" ? { into: value.into, glue: value.glue ?? "" } : null;
    };
    const command: ModelCommand = { id: commands.length, by: step.by, knew: new Set(seen), writes: [] };
    const name = E2_NAMES[step.by] as string, field: NativeField = "field" in step && step.field === "v" ? "visualText" : "audioText";
    let label: string;
    if (step.op === "type" || step.op === "delete" || step.op === "split" || step.op === "join" || step.op === "remove") {
      const row = pick(view.rows, step.row);
      if (!row) { skipped++; continue; }
      const index = view.rows.indexOf(row), pieces = field === "visualText" ? row.visual : row.audio, length = pieces.reduce((sum, piece) => sum + piece.chars.length, 0);
      if (step.op === "type") {
        const at = ((step.at % (length + 1)) + length + 1) % (length + 1), place = spot(row, step.op === "type" && step.field === "v" ? "v" : "a", at);
        const text = Array.from({ length: step.count ?? 1 }, () => glyph(next++));
        const cell = field === "visualText" ? view.visuals.get(place.beat) ?? [] : view.line;
        const at0 = field === "visualText" ? place.offset : view.line.indexOf(`b:${place.beat}`) + 1 + place.offset;
        fences.chain([...(cell[at0 - 1] !== undefined ? [cell[at0 - 1] as string] : []), ...text, ...(cell[at0] !== undefined ? [cell[at0] as string] : [])]);
        for (const char of text) { born.set(char, command.id); if (field === "visualText") home.set(char, place.beat); }
        typeAt(replica, row.id, field, at, text.join(""));
        label = `${name} types ${text.join("")} in ${row.id} ${field === "visualText" ? "visual" : "narration"} at ${at}`;
      } else if (step.op === "delete") {
        const from = ((step.at % (length + 1)) + length + 1) % (length + 1), to = Math.min(length, from + Math.max(1, step.span));
        const chosen: string[] = [];
        let at = 0;
        for (const piece of pieces) { for (const char of piece.chars) { if (piece.beat !== null && at >= from && at < to) chosen.push(char); at++; } }
        if (!chosen.length) { skipped++; continue; }
        for (const char of chosen) died.set(char, [...(died.get(char) ?? []), command.id]);
        deleteIn(replica, row.id, field, from, to);
        label = `${name} deletes ${chosen.join("")} in ${row.id} ${field === "visualText" ? "visual" : "narration"}`;
      } else if (step.op === "split") {
        const at = ((step.at % (length + 1)) + length + 1) % (length + 1), place = spot(row, "a", at), beat = `S${++created}`;
        if (place.seam !== null) {
          write(command, step.by, place.seam, "joined", false);
          repoint(command, step.by, row, row.members.indexOf(place.seam), place.seam, flags);
          label = `${name} splits ${row.id} at the seam before ${place.seam}`;
        } else {
          const at0 = view.line.indexOf(`b:${place.beat}`) + 1 + place.offset;
          fences.chain([...(view.line[at0 - 1] !== undefined ? [view.line[at0 - 1] as string] : []), `b:${beat}`, ...(view.line[at0] !== undefined ? [view.line[at0] as string] : [])]);
          born.set(`b:${beat}`, command.id); beatBorn.set(beat, command.id);
          repoint(command, step.by, row, row.members.indexOf(place.beat) + 1, beat, flags);
          label = `${name} splits ${row.id} inside ${place.beat} at ${place.offset}, making ${beat}`;
        }
        const outcome = splitAt(replica, row.id, at, beat);
        if ((outcome === "unjoined") !== (place.seam !== null)) problems.push(`${name}: split of ${row.id} at ${at} did ${outcome}`);
      } else if (step.op === "join") {
        const above = view.rows[index - 1];
        if (!above) { skipped++; continue; }
        write(command, step.by, row.id, "joined", true, above.members.at(-1) as string, " ");
        joinUp(replica, row.id, " ");
        label = `${name} joins ${row.id} to ${above.id}`;
      } else {
        for (const member of reading === "contiguous" ? row.members : [row.id]) write(command, step.by, member, "removed", true);
        removeRow(replica, row.id, name);
        label = `${name} removes ${row.id}`;
      }
    } else if (step.op === "restore") {
      const entry = pick(view.entries.filter(item => item.reason === "removed").map(item => ({ ...item, id: item.beat })), step.entry);
      if (!entry) { skipped++; continue; }
      for (const member of reading === "contiguous" ? entry.members : [entry.beat]) write(command, step.by, member, "removed", false);
      restoreRow(replica, entry.beat);
      label = `${name} restores ${entry.beat}`;
    } else {
      write(command, step.by, step.beat, "joined", true, step.into, " ");
      replica.join(step.beat, step.into, " "); replica.changes();
      label = `${name} writes ${step.beat} joined into ${step.into}`;
    }
    commands.push(command); seen.add(command.id); executed++; labels.push(label);
    for (const id of command.writes) {
      const record = writes[id] as ModelWrite;
      if (!record.set) continue;
      const item = (replica.beats.get(record.beat) as unknown as { _map: Map<string, Y.Item> } | undefined)?._map.get(record.key);
      record.item = item ? `${item.id.client}:${item.id.clock}` : null;
    }
    verify(replica, seen, `${name} after step ${position}`);
  }
  if (!problems.length) for (let round = 0; round < 2; round++) for (let from = 0; from < copies.length; from++) for (let to = 0; to < copies.length; to++) if (from !== to) transfer(from, to, round);
  for (const replica of copies) options.tamper?.(replica, "copy");
  const late = new NativeReplica(800);
  late.reading = reading;
  Y.applyUpdate(late.doc, Y.encodeStateAsUpdate((copies[0] as NativeReplica).doc), "remote");
  options.tamper?.(late, "late");
  late.changes();
  const all = new Set(commands.map(command => command.id).concat(-1));
  let misordered = false, observedTies = 0, observedFlags = 0, probed = 0;
  const places = new Map<string, E2Place>();
  if (!problems.length) {
    const readings = [...copies, late].map(replica => JSON.stringify([shownRows(replica), shownRecovery(replica), readStored(replica).line]));
    if (readings.some(value => value !== readings[0])) problems.push(`copies differ: ${readings.join(" / ")}`);
    [...copies, late].forEach((replica, index) => {
      observed = index === 0 ? new Set<string>() : null;
      const failed = problems.length, view = verify(replica, all, index < copies.length ? `${E2_NAMES[index]} at the end` : "late joiner");
      const unreached = reach(replica);
      if (!view || index !== 0) { problems.push(...unreached); return; }
      observedFlags = observed?.size ?? 0;
      observedTies = fences.observedPairs(view.line) + [...view.visuals.values()].reduce((sum, cell) => sum + fences.observedPairs(cell), 0);
      const shown = view.rows.flatMap(row => row.members), stored = view.line.filter(element => element.startsWith("b:")).map(element => element.slice(2));
      misordered = JSON.stringify(shown) !== JSON.stringify(stored.filter(beat => shown.includes(beat)));
      view.rows.forEach((row, at) => { for (const member of row.members) places.set(member, { row: at, members: row.members, hidden: false }); });
      view.entries.forEach((entry, at) => { for (const member of entry.members) places.set(member, { row: at, members: entry.members, hidden: true }); });
      if (problems.length === failed) {
        const result = probeEdits(replica, view, options.probes ?? 6, random, options.tamper);
        probed = result.count; problems.push(...result.problems);
      }
      problems.push(...unreached);
    });
  }
  observed = null;
  return { problems, misordered, executed, skipped, labels, rows: shownRows(copies[0] as NativeReplica), recovery: shownRecovery(copies[0] as NativeReplica), copies, late,
    observedTies, observedFlags, probed, places };
}

// why: edits are routed by the row's parts; each probe types or deletes at a shown place on a fresh copy and compares
// the rows with the model's own placement of that edit, which never reads the parts
function probeEdits(source: NativeReplica, view: ModelView, count: number, random: () => number, tamper?: (replica: NativeReplica, role: E2Role) => void): { count: number; problems: string[] } {
  const places: { row: ModelRow; field: E2Field; at: number }[] = [];
  for (const row of view.rows) for (const field of ["a", "v"] as const) {
    const length = flat(field === "a" ? row.audio : row.visual).length;
    for (let at = 0; at <= length; at++) places.push({ row, field, at });
  }
  for (let index = places.length - 1; index > 0; index--) { const swap = Math.floor(random() * (index + 1)); [places[index], places[swap]] = [places[swap] as typeof places[number], places[index] as typeof places[number]]; }
  const problems: string[] = [];
  let done = 0;
  for (const { row, field, at } of places.slice(0, count)) for (const op of ["type", "delete"] as const) {
    const pieces = field === "a" ? row.audio : row.visual, shown = pieces.flatMap(piece => piece.chars.map(char => ({ char, beat: piece.beat })));
    const target = shown[at];
    if (op === "delete" && (!target || target.beat === null)) continue;
    const line = [...view.line], visuals = new Map([...view.visuals].map(([beat, cell]) => [beat, [...cell]]));
    if (op === "type") {
      const place = spot(row, field, at);
      if (field === "v") visuals.get(place.beat)?.splice(place.offset, 0, "Ω");
      else line.splice(line.indexOf(`b:${place.beat}`) + 1 + place.offset, 0, "Ω");
    } else if (field === "v") visuals.get(target?.beat ?? "")?.splice(visuals.get(target?.beat ?? "")?.indexOf(target?.char ?? "") ?? -1, 1);
    else line.splice(line.indexOf(target?.char ?? ""), 1);
    const expected = modelView(line, visuals, view.beats, view.flags, view.reading);
    const copy = new NativeReplica(700);
    copy.reading = view.reading;
    Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(source.doc), "remote");
    tamper?.(copy, "probe");
    copy.changes();
    const fieldName: NativeField = field === "v" ? "visualText" : "audioText";
    if (op === "type") typeAt(copy, row.id, fieldName, at, "Ω"); else deleteIn(copy, row.id, fieldName, at, at + 1);
    const got = [...shownRows(copy), ...shownRecovery(copy)], want = [...modelRows(expected), ...modelEntries(expected)];
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`edit at shown place: ${op} at ${at} of ${row.id} ${fieldName} gave ${JSON.stringify(got)}, the model places it ${JSON.stringify(want)}`);
    copy.destroy(); done++;
  }
  return { count: done, problems };
}

// why: apart from the model: every live character of any text is shown once, in a row or in recovery, and a row or
// removed group shows its beats' cells in order, so an edit at a shown place reaches the character shown there
export function reach(replica: NativeReplica): string[] {
  const problems: string[] = [], live = new Map<string, number>(), shown = new Map<string, number>();
  const count = (into: Map<string, number>, text: string): void => { for (const char of text) if (char !== " " && char !== "\n" && char !== "￼") into.set(char, (into.get(char) ?? 0) + 1); };
  for (const [, segment] of replica.segments) { const text = segment.get("text"); if (text instanceof Y.Text) count(live, plain(text.toDelta() as NativeDeltaItem[])); }
  for (const [, text] of replica.visuals) count(live, plain(text.toDelta() as NativeDeltaItem[]));
  const groups: { id: string; members: string[]; parts: NativeRow["parts"]; audio: NativeDeltaItem[]; visual: NativeDeltaItem[] }[] = replica.rows().map(row => ({ ...row }));
  for (const entry of replica.recovery() as NativeRecovery[]) {
    if (entry.reason === "removed") groups.push({ id: entry.beat, members: entry.members, parts: { audio: [], visual: [] }, audio: entry.audio, visual: entry.visualItems });
    else { count(shown, plain(entry.audio)); count(shown, plain(entry.visualItems)); }
  }
  for (const group of groups) {
    count(shown, plain(group.audio)); count(shown, plain(group.visual));
    for (const field of ["audioText", "visualText"] as const) {
      const cells = group.members.map(member => { const cell = replica.cell(member, field); return plain(cell.text.toDelta() as NativeDeltaItem[]).slice(cell.start, cell.end); });
      const held = cells.join(""), shownText = plain(field === "audioText" ? group.audio : group.visual), showing = shownText.replace(/[ \n]/g, "");
      if (held !== showing) problems.push(`${group.id} ${field} shows ${showing}; its beats' cells hold ${held}`);
      const parts = field === "audioText" ? group.parts.audio : group.parts.visual;
      if (!parts.length) continue;
      let at = 0;
      const routed = parts.map(part => { const slice = shownText.slice(at, at + part.length); at += part.length; return part.beat === null ? slice.replace(/[ \n]/g, "") : slice === cells[group.members.indexOf(part.beat)] ? "" : "x"; });
      if (at !== shownText.length || routed.some(mark => mark !== "")) problems.push(`${group.id} ${field} parts do not cover the shown text beat by beat`);
    }
  }
  for (const [char, times] of live) if ((shown.get(char) ?? 0) !== times) problems.push(`${char} is stored ${times} time(s) and shown ${shown.get(char) ?? 0}`);
  for (const [char, times] of shown) if (!live.has(char)) problems.push(`${char} is shown ${times} time(s) and stored nowhere`);
  return problems;
}

export function generateE2(seed: number, length: number): E2Step[] {
  const random = rng(seed), steps: E2Step[] = [], int = (limit: number): number => Math.floor(random() * limit);
  for (let index = 0; index < length; index++) {
    const roll = random(), by = int(3), row = int(8), at = int(12);
    if (roll < 0.22) steps.push({ op: "deliver", from: int(3), to: int(3) });
    else if (roll < 0.40) steps.push({ op: "type", by, row, field: "a", at, count: 1 + int(2) });
    else if (roll < 0.50) steps.push({ op: "type", by, row, field: "v", at, count: 1 + int(2) });
    else if (roll < 0.56) steps.push({ op: "delete", by, row, field: random() < 0.7 ? "a" : "v", at, span: 1 + int(5) });
    else if (roll < 0.70) steps.push({ op: "split", by, row, at });
    else if (roll < 0.84) steps.push({ op: "join", by, row });
    else if (roll < 0.92) steps.push({ op: "remove", by, row });
    else steps.push({ op: "restore", by, entry: int(4) });
  }
  return steps;
}

// why: drops steps one at a time while the history still shows the same failure, so the report gives the shortest
export function shrinkE2(steps: readonly E2Step[], fails: (candidate: readonly E2Step[]) => boolean): E2Step[] {
  let current = [...steps], changed = true;
  while (changed) {
    changed = false;
    for (let index = current.length - 1; index >= 0; index--) {
      const candidate = current.filter((_, at) => at !== index);
      if (fails(candidate)) { current = candidate; changed = true; }
    }
  }
  return current;
}

export function storedText(result: E2Result): string {
  const stored = readStored(result.copies[0] as NativeReplica);
  return JSON.stringify([stored.line, [...stored.visuals].sort()]);
}

export function closeE2(result: E2Result): void {
  for (const replica of [...result.copies, result.late]) replica.destroy();
}
