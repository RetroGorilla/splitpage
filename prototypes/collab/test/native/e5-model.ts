export type E5Removal = "delete" | "flag";
export type E5Field = "audio" | "visual";
export type E5Command =
  | { op: "create"; beat: string; id: string; name: string }
  | { op: "renameType"; id: string; at: number; value: string }
  | { op: "renameDelete"; id: string; at: number }
  | { op: "removeHeading" | "restoreHeading" | "restoreBeat"; id: string }
  | { op: "typeBeat"; row: string; field: E5Field; at: number; value: string }
  | { op: "deleteBeat"; row: string; field: E5Field; at: number }
  | { op: "split"; row: string; at: number; id: string }
  | { op: "unjoin"; row: string; at: number }
  | { op: "join" | "removeBeat"; row: string };
export type E5Write = E5Command["op"];
export type E5Step = { by: number; command: E5Command } | { from: number; to: number };
export interface E5Boundary { kind: "b" | "h"; id: string }
export type E5Unit = string | E5Boundary;
export interface E5Segment { head: E5Boundary | null; units: E5Unit[] }
export interface E5Stored {
  order: string[];
  segments: Record<string, E5Segment>;
  headings: Record<string, boolean>;
  beats: Record<string, { removed: boolean; into: string | null }>;
  visuals: Record<string, string>;
}
export interface E5Piece { beat: string | null; length: number }
export interface E5Row {
  kind: "row"; id: string; members: string[]; audio: string; visual: string;
  parts: Record<E5Field, E5Piece[]>;
}
export interface E5HeadingView { kind: "heading"; id: string; name: string }
export interface E5Projection {
  outline: (E5Row | E5HeadingView)[];
  removedBeats: Omit<E5Row, "parts">[];
  removedHeadings: E5HeadingView[];
}

export const BEATS = ["B0", "B1", "B2", "B3", "B4"];
export const HEADINGS = ["H0", "H1"];
export const INITIAL: E5Stored = {
  order: ["S0", "S1"],
  segments: {
    S0: { head: { kind: "h", id: "H0" }, units: ["A", { kind: "b", id: "B0" }, "O", { kind: "b", id: "B1" }, "b", "c",
      { kind: "h", id: "H1" }, "D", { kind: "b", id: "B2" }, "e", "f", { kind: "b", id: "B3" }, "g", "h"] },
    S1: { head: { kind: "b", id: "B4" }, units: ["i", "j"] }
  },
  headings: { H0: false, H1: false },
  beats: Object.fromEntries(BEATS.map(id => [id, { removed: false, into: null }])),
  visuals: { B0: "P", B1: "K", B2: "L", B3: "M", B4: "N" }
};

interface Item { id: string; by: number; left: string | null; right: string | null; value: E5Unit }
type Change =
  | { type: "put"; list: string; item: Item }
  | { type: "erase"; id: string }
  | { type: "segment"; id: string; head: E5Boundary }
  | { type: "clearHead"; id: string }
  | { type: "record"; kind: "b" | "h"; id: string };
export interface E5Event { by: number; command: E5Command; seen: ReadonlySet<number>; changes: Change[]; joinInto?: string }
interface Block extends E5Boundary { segment: string; start: number; length: number; text: string }

const script = (segment: string): string => `text:${segment}`;
const visual = (beat: string): string => `visual:${beat}`;
const flag = (key: "joined" | "removedBeat" | "removedHeading", id: string): string => `${key}:${id}`;

export function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

export class E5Model {
  private readonly lists = new Map<string, Item[]>();
  private readonly erased = new Set<string>();
  private readonly heads = new Map<string, E5Boundary | null>();
  private readonly headingIds = new Set(HEADINGS);
  private readonly beatIds = new Set(BEATS);

  constructor(events: readonly E5Event[], seen: ReadonlySet<number>) {
    const seed = (list: string, values: readonly E5Unit[]): void => {
      this.lists.set(list, values.map((value, index) => ({
        id: `${list}/${index}`, by: 900, left: index ? `${list}/${index - 1}` : null, right: null, value
      })));
    };
    seed("order", INITIAL.order);
    for (const [id, segment] of Object.entries(INITIAL.segments)) {
      this.heads.set(id, segment.head);
      seed(script(id), segment.units);
    }
    for (const [id, text] of Object.entries(INITIAL.visuals)) seed(visual(id), [...text]);
    for (const [index, event] of events.entries()) if (seen.has(index)) {
      for (const change of event.changes) this.apply(change);
    }
  }

  private apply(change: Change): void {
    switch (change.type) {
      case "put": this.integrate(change.list, change.item); break;
      case "erase": this.erased.add(change.id); break;
      case "segment": this.heads.set(change.id, change.head); break;
      case "clearHead": this.heads.set(change.id, null); break;
      case "record": (change.kind === "h" ? this.headingIds : this.beatIds).add(change.id); break;
    }
  }

  private integrate(key: string, item: Item): void {
    const items = this.lists.get(key) ?? [], left = items.findIndex(other => other.id === item.left);
    let slot = left + 1;
    const scanned = new Set<string>(), tied = new Set<string>();
    // why: deleted units still anchor concurrent inserts, and descendants of an earlier sibling travel with it
    for (let index = slot; index < items.length; index++) {
      const other = required(items[index], "ordered unit");
      if (other.id === item.right) break;
      scanned.add(other.id);
      tied.add(other.id);
      if (other.left === item.left) {
        if (other.by < item.by) { slot = index + 1; tied.clear(); }
        else if (other.right === item.right) break;
      } else if (other.left !== null && scanned.has(other.left)) {
        if (!tied.has(other.left)) { slot = index + 1; tied.clear(); }
      } else break;
    }
    items.splice(slot, 0, item);
    this.lists.set(key, items);
  }

  private live(key: string): Item[] {
    return (this.lists.get(key) ?? []).filter(item => !this.erased.has(item.id));
  }

  private last(key: string): Item | undefined { return this.lists.get(key)?.at(-1); }

  private value(key: string): string | null {
    const last = this.last(key);
    return last && !this.erased.has(last.id) ? String(last.value) : null;
  }

  stored(): E5Stored {
    return {
      order: this.live("order").map(item => String(item.value)),
      segments: Object.fromEntries([...this.heads].map(([id, head]) => [id, {
        head, units: this.live(script(id)).map(item => item.value)
      }])),
      headings: Object.fromEntries([...this.headingIds].map(id => [id, this.value(flag("removedHeading", id)) !== null])),
      beats: Object.fromEntries([...this.beatIds].map(id => [id, {
        removed: this.value(flag("removedBeat", id)) !== null, into: this.value(flag("joined", id))
      }])),
      visuals: Object.fromEntries([...this.beatIds].map(id => [id, this.live(visual(id)).map(item => item.value).join("")]))
    };
  }

  private blocks(stored: E5Stored): Block[] {
    const blocks: Block[] = [];
    for (const segment of stored.order) {
      const { head, units } = required(stored.segments[segment], segment);
      let block: Block | null = null;
      const open = (boundary: E5Boundary, start: number): void => {
        block = { ...boundary, segment, start, length: 0, text: "" };
        blocks.push(block);
      };
      if (head) open(head, 0);
      units.forEach((unit, index) => {
        if (typeof unit !== "string") open(unit, index + 1);
        else if (block) { block.length++; block.text += unit; }
      });
    }
    return blocks;
  }

  project(stored = this.stored()): E5Projection {
    const outline: E5Projection["outline"] = [], removedBeats: E5Row[] = [], removedHeadings: E5HeadingView[] = [];
    let shown: E5Row | undefined, hidden: E5Row | undefined;
    for (const block of this.blocks(stored)) {
      const { kind, id, text } = block;
      if (kind === "h") {
        const heading: E5HeadingView = { kind: "heading", id, name: text };
        if (stored.headings[id]) removedHeadings.push(heading);
        else { outline.push(heading); shown = hidden = undefined; }
        continue;
      }
      const beat = required(stored.beats[id], id), removed = beat.removed;
      let row = removed ? hidden : shown;
      if (!row || !beat.into) {
        row = { kind: "row", id, members: [], audio: "", visual: "", parts: { audio: [], visual: [] } };
        if (removed) removedBeats.push(row); else outline.push(row);
      }
      row.members.push(id);
      const visualText = required(stored.visuals[id], `visual ${id}`);
      for (const [field, value, glue] of [["audio", text, " "], ["visual", visualText, "\n"]] as const) {
        if (row[field] && value) {
          row[field] += glue;
          row.parts[field].push({ beat: null, length: 1 });
        }
        row[field] += value;
        row.parts[field].push({ beat: id, length: value.length });
      }
      if (removed) hidden = row; else { shown = row; hidden = undefined; }
    }
    return {
      outline, removedHeadings,
      removedBeats: removedBeats.map(({ kind, id, members, audio, visual }) => ({ kind, id, members, audio, visual }))
    };
  }

  plan(command: E5Command, by: number, seen: ReadonlySet<number>, index: number, removal: E5Removal): E5Event {
    const changes: Change[] = [], stored = this.stored(), blocks = this.blocks(stored), view = this.project(stored);
    const event: E5Event = { by, command, seen: new Set(seen), changes };
    const block = (id: string, kind: "h" | "b"): Block => {
      const found = blocks.find(item => item.id === id && item.kind === kind);
      if (!found) throw new Error(`Missing ${kind} ${id}`);
      return found;
    };
    const push = (change: Change): void => { changes.push(change); };
    const put = (list: string, value: E5Unit, left: string | null, right: string | null): Item => {
      const item = { id: `event/${index}/${changes.length}`, by, left, right, value };
      push({ type: "put", list, item });
      return item;
    };
    const insert = (list: string, at: number, values: E5Unit[]): void => {
      const all = this.lists.get(list) ?? [], next = this.live(list)[at];
      const physical = next ? all.indexOf(next) : all.length;
      let left = all[physical - 1]?.id ?? null;
      for (const value of values) left = put(list, value, left, next?.id ?? null).id;
    };
    const erase = (list: string, at: number): void => {
      push({ type: "erase", id: required(this.live(list)[at], `${list} unit at ${at}`).id });
    };
    const set = (key: string, value: string): void => { put(key, value, this.last(key)?.id ?? null, null); };
    const clear = (key: string): void => { push({ type: "erase", id: required(this.last(key), key).id }); };
    const rows = view.outline.filter(entry => entry.kind === "row");
    const row = (id: string): E5Row => required(rows.find(entry => entry.id === id), `row ${id}`);

    switch (command.op) {
      case "create": {
        const target = block(command.beat, "b"), head = { kind: "h", id: command.id } as const;
        push({ type: "record", kind: "h", id: command.id });
        if (target.start) insert(script(target.segment), target.start - 1, [head, ...command.name]);
        else {
          const id = `seg-h-${command.id}`;
          push({ type: "segment", id, head });
          insert(script(id), 0, [...command.name]);
          insert("order", stored.order.indexOf(target.segment), [id]);
        }
        break;
      }
      case "renameType":
      case "renameDelete":
      case "removeHeading": {
        const heading = block(command.id, "h"), key = script(heading.segment);
        if (command.op === "renameType") insert(key, heading.start + command.at, [command.value]);
        else if (command.op === "renameDelete") erase(key, heading.start + command.at);
        else if (removal === "flag") set(flag("removedHeading", command.id), "true");
        else if (heading.start) erase(key, heading.start - 1);
        else push({ type: "clearHead", id: heading.segment });
        break;
      }
      case "restoreHeading": clear(flag("removedHeading", command.id)); break;
      case "typeBeat":
      case "deleteBeat":
      case "split":
      case "unjoin": {
        const field = "field" in command ? command.field : "audio";
        const at = spot(row(command.row), field, command.at, command.op === "deleteBeat");
        const beat = block(at.id, "b"), key = field === "audio" ? script(beat.segment) : visual(beat.id);
        const offset = at.offset + (field === "audio" ? beat.start : 0);
        if (command.op === "typeBeat") insert(key, offset, [command.value]);
        else if (command.op === "deleteBeat") erase(key, offset);
        else if (command.op === "unjoin") clear(flag("joined", required(at.seam, "join seam")));
        else {
          insert(key, offset, [{ kind: "b", id: command.id }]);
          push({ type: "record", kind: "b", id: command.id });
        }
        break;
      }
      case "join": {
        const above = required(rows[rows.indexOf(row(command.row)) - 1], "row above join");
        event.joinInto = required(above.members.at(-1), "beat above join");
        set(flag("joined", command.row), event.joinInto);
        break;
      }
      case "removeBeat":
        for (const id of row(command.row).members) set(flag("removedBeat", id), "true");
        break;
      case "restoreBeat": {
        const recovery = required(view.removedBeats.find(entry => entry.id === command.id), "beat recovery entry");
        for (const id of recovery.members) clear(flag("removedBeat", id));
        break;
      }
    }
    return event;
  }
}

export function spot(row: E5Row, field: E5Field, at: number, deleting = false): { id: string; offset: number; seam?: string } {
  let offset = 0;
  const beats = row.parts[field].flatMap(part => {
    const start = offset;
    offset += part.length;
    return part.beat === null ? [] : [{ id: part.beat, start, end: offset }];
  });
  if (!deleting) for (let index = 1; index < beats.length; index++) {
    const left = required(beats[index - 1], "part before join"), right = required(beats[index], "part after join");
    if (left.end <= at && at <= right.start) return { id: left.id, offset: left.end - left.start, seam: right.id };
  }
  const beat = beats.find(item => item.start <= at && (deleting ? at < item.end : at <= item.end));
  if (!beat) throw new Error(`Missing ${field} position ${at} in ${row.id}`);
  return { id: beat.id, offset: at - beat.start };
}
