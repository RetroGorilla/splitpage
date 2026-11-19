import { BEATS, HEADINGS, INITIAL, required, spot } from "../native/e5-model.ts";
import type { E5Boundary, E5Command, E5Field, E5HeadingView, E5Projection, E5Row, E5Stored, E5Unit } from "../native/e5-model.ts";

export interface E7Place { a: string | null; n: number; u: string | null }
export type E7Move = { op: "move"; unit: "row" | "rows" | "scene" | "into"; first: string; last: string; after: string | null };
export type E7Command = E5Command | E7Move;
export type E7Write = E7Command["op"];
export type E7Step = { by: number; command: E7Command } | { from: number; to: number };
export interface E7Stored extends E5Stored { places: Record<string, E7Place | null> }
export type E7Part = "member" | "dependent" | "repoint" | "headingPlace" | "record" | "boundary" | "name" | "visualCell";

interface Item { id: string; by: number; left: string | null; right: string | null; value: E5Unit }
type Change =
  | { type: "put"; list: string; item: Item; part?: E7Part }
  | { type: "erase"; id: string }
  | { type: "segment"; id: string; head: E5Boundary; part?: E7Part }
  | { type: "record"; kind: "b" | "h"; id: string; part?: E7Part };
export interface E7Event {
  by: number; command: E7Command; seen: ReadonlySet<number>; changes: Change[]; joinInto?: string; parts: Partial<Record<E7Part, string[]>>;
  target?: string; members?: string[];
}
export interface E7Block { kind: "b" | "h"; id: string; ref: string; segment: string; start: number; text: string }
export interface E7Arrangement { order: string[]; parent: Map<string, string | null>; placed: Set<string>; following: Set<string> }

const script = (segment: string): string => `text:${segment}`;
const visual = (beat: string): string => `visual:${beat}`;
const flag = (key: "joined" | "removedBeat" | "removedHeading" | "place", id: string): string => `${key}:${id}`;
export const refOf = (kind: "b" | "h", id: string): string => `${kind}:${id}`;

// why: the model reads stored order by its own rules; it shares the written rule with the prototype, not its code
export function arrangeBlocks(blocks: readonly E7Block[], places: Readonly<Record<string, E7Place | null>>): E7Arrangement {
  const known = new Map(blocks.map(block => [block.ref, block]));
  const active = new Map<string, E7Place>();
  for (const block of blocks) {
    const place = places[block.ref];
    if (place && place.a !== block.ref && (place.a === null || known.has(place.a))) active.set(block.ref, place);
  }
  const followers = (): Map<string, string> => {
    const lead = new Map<string, string>();
    const bySegment = new Map<string, E7Block[]>();
    for (const block of blocks) bySegment.set(block.segment, [...(bySegment.get(block.segment) ?? []), block]);
    for (const list of bySegment.values()) {
      list.forEach((block, index) => {
        if (active.has(block.ref) || block.kind === "h") return;
        for (let back = index - 1; back >= 0; back--) {
          const before = required(list[back], "earlier block");
          if (before.kind === "h" && !active.has(before.ref)) return;
          const place = active.get(before.ref);
          if (!place) continue;
          const end = place.u === null ? null : known.get(place.u);
          const inside = place.u === null || (end !== undefined && end !== null && end.segment === before.segment && end.start > before.start && block.start < end.start);
          if (inside) { lead.set(block.ref, before.ref); return; }
        }
      });
    }
    return lead;
  };
  let lead = followers();
  const up = (ref: string): string | null | undefined => active.has(ref) ? required(active.get(ref), ref).a : lead.get(ref);
  for (;;) {
    let loop: string[] | null = null;
    const done = new Set<string>();
    for (const start of blocks.map(block => block.ref).filter(ref => active.has(ref))) {
      if (done.has(start)) continue;
      const path: string[] = [];
      let current: string | null | undefined = start;
      while (typeof current === "string" && !done.has(current) && !path.includes(current)) { path.push(current); current = up(current); }
      if (typeof current === "string" && path.includes(current)) { loop = path.slice(path.indexOf(current)); break; }
      for (const ref of path) done.add(ref);
    }
    if (!loop) break;
    const candidates = loop.filter(ref => active.has(ref));
    const oldest = candidates.reduce((best, ref) => {
      const one = required(active.get(ref), ref).n, other = required(active.get(best), best).n;
      return one < other || (one === other && ref > best) ? ref : best;
    });
    active.delete(oldest);
    lead = followers();
  }
  const parent = new Map<string, string | null>();
  const childrenOf = (anchor: string | null): string[] => [...active].filter(([, place]) => place.a === anchor)
    .sort(([left, one], [right, other]) => other.n - one.n || (left < right ? -1 : 1)).map(([ref]) => ref);
  const order: string[] = [];
  const visit = (ref: string): void => {
    order.push(ref);
    for (const child of childrenOf(ref)) { parent.set(child, ref); visit(child); }
    if (active.has(ref)) for (const block of blocks) if (lead.get(block.ref) === ref) { parent.set(block.ref, ref); visit(block.ref); }
  };
  for (const child of childrenOf(null)) { parent.set(child, null); visit(child); }
  for (const block of blocks) if (!active.has(block.ref) && !lead.has(block.ref)) visit(block.ref);
  return { order, parent, placed: new Set(active.keys()), following: new Set(lead.keys()) };
}

export class E7Model {
  private readonly lists = new Map<string, Item[]>();
  private readonly erased = new Set<string>();
  private readonly heads = new Map<string, E5Boundary | null>();
  private readonly headingIds = new Set(HEADINGS);
  private readonly beatIds = new Set(BEATS);

  constructor(events: readonly E7Event[], seen: ReadonlySet<number>) {
    const seed = (list: string, values: readonly E5Unit[]): void => {
      this.lists.set(list, values.map((value, index) => ({ id: `${list}/${index}`, by: 900, left: index ? `${list}/${index - 1}` : null, right: null, value })));
    };
    seed("order", INITIAL.order);
    for (const [id, segment] of Object.entries(INITIAL.segments)) {
      this.heads.set(id, segment.head);
      seed(script(id), segment.units);
    }
    for (const [id, text] of Object.entries(INITIAL.visuals)) seed(visual(id), [...text]);
    for (const [index, event] of events.entries()) if (seen.has(index)) for (const change of event.changes) this.apply(change);
  }

  private apply(change: Change): void {
    if (change.type === "put") this.integrate(change.list, change.item);
    else if (change.type === "erase") this.erased.add(change.id);
    else if (change.type === "segment") this.heads.set(change.id, change.head);
    else (change.kind === "h" ? this.headingIds : this.beatIds).add(change.id);
  }

  // why: the list rule of the E5 model: deleted units still anchor concurrent inserts, and the lower writer goes first
  private integrate(key: string, item: Item): void {
    const items = this.lists.get(key) ?? [], left = items.findIndex(other => other.id === item.left);
    let slot = left + 1;
    const scanned = new Set<string>(), tied = new Set<string>();
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

  private live(key: string): Item[] { return (this.lists.get(key) ?? []).filter(item => !this.erased.has(item.id)); }

  private last(key: string): Item | undefined { return this.lists.get(key)?.at(-1); }

  private value(key: string): string | null {
    const last = this.last(key);
    return last && !this.erased.has(last.id) ? String(last.value) : null;
  }

  private place(ref: string): E7Place | null {
    const value = this.value(flag("place", ref));
    return value === null ? null : JSON.parse(value) as E7Place;
  }

  stored(): E7Stored {
    return {
      order: this.live("order").map(item => String(item.value)),
      segments: Object.fromEntries([...this.heads].map(([id, head]) => [id, { head, units: this.live(script(id)).map(item => item.value) }])),
      headings: Object.fromEntries([...this.headingIds].map(id => [id, this.value(flag("removedHeading", id)) !== null])),
      beats: Object.fromEntries([...this.beatIds].map(id => [id, { removed: this.value(flag("removedBeat", id)) !== null, into: this.value(flag("joined", id)) }])),
      visuals: Object.fromEntries([...this.beatIds].map(id => [id, this.live(visual(id)).map(item => item.value).join("")])),
      places: Object.fromEntries([...[...this.beatIds].map(id => refOf("b", id)), ...[...this.headingIds].map(id => refOf("h", id))].map(ref => [ref, this.place(ref)]))
    };
  }

  blocks(stored: E7Stored): E7Block[] {
    const blocks: E7Block[] = [], seen = new Set<string>();
    for (const segment of stored.order) {
      const { head, units } = required(stored.segments[segment], segment);
      let block: E7Block | null = null;
      const open = (boundary: E5Boundary, start: number): void => {
        const ref = refOf(boundary.kind, boundary.id);
        block = { kind: boundary.kind, id: boundary.id, ref, segment, start, text: "" };
        if (!seen.has(ref)) { seen.add(ref); blocks.push(block); }
      };
      if (head) open(head, 0);
      units.forEach((unit, index) => {
        if (typeof unit !== "string") open(unit, index + 1);
        else if (block) block.text += unit;
      });
    }
    return blocks;
  }

  arrangement(stored = this.stored()): E7Arrangement { return arrangeBlocks(this.blocks(stored), stored.places); }

  project(stored = this.stored()): E5Projection {
    const outline: E5Projection["outline"] = [], removedBeats: E5Row[] = [], removedHeadings: E5HeadingView[] = [];
    const byRef = new Map(this.blocks(stored).map(block => [block.ref, block]));
    let shown: E5Row | undefined, hidden: E5Row | undefined;
    for (const ref of this.arrangement(stored).order) {
      const { kind, id, text } = required(byRef.get(ref), ref);
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
        if (row[field] && value) { row[field] += glue; row.parts[field].push({ beat: null, length: 1 }); }
        row[field] += value;
        row.parts[field].push({ beat: id, length: value.length });
      }
      if (removed) hidden = row; else { shown = row; hidden = undefined; }
    }
    return { outline, removedHeadings, removedBeats: removedBeats.map(({ kind, id, members, audio, visual }) => ({ kind, id, members, audio, visual })) };
  }

  private stamp(stored: E7Stored): number {
    return Object.values(stored.places).reduce((top, place) => Math.max(top, place?.n ?? 0), 0) + 1;
  }

  private untilOf(blocks: readonly E7Block[]): Map<string, string | null> {
    return new Map(blocks.map((block, index) => {
      const next = blocks[index + 1];
      return [block.ref, next && next.segment === block.segment ? next.ref : null];
    }));
  }

  plan(command: E7Command, by: number, seen: ReadonlySet<number>, index: number): E7Event {
    const changes: Change[] = [], stored = this.stored(), blocks = this.blocks(stored), view = this.project(stored);
    const arrangement = arrangeBlocks(blocks, stored.places);
    const event: E7Event = { by, command, seen: new Set(seen), changes, parts: {} };
    const note = (part: E7Part, ref: string): void => { event.parts[part] = [...(event.parts[part] ?? []), ref]; };
    const block = (id: string, kind: "h" | "b"): E7Block => required(blocks.find(item => item.id === id && item.kind === kind), `${kind} ${id}`);
    const put = (list: string, value: E5Unit, left: string | null, right: string | null, part?: E7Part): Item => {
      const item = { id: `event/${index}/${changes.length}`, by, left, right, value };
      changes.push(part ? { type: "put", list, item, part } : { type: "put", list, item });
      return item;
    };
    const insert = (list: string, at: number, values: E5Unit[], part?: E7Part, rest = part): void => {
      const all = this.lists.get(list) ?? [], next = this.live(list)[at], physical = next ? all.indexOf(next) : all.length;
      let left = all[physical - 1]?.id ?? null;
      values.forEach((value, offset) => { left = put(list, value, left, next?.id ?? null, offset ? rest : part).id; });
    };
    const erase = (list: string, at: number): void => { changes.push({ type: "erase", id: required(this.live(list)[at], `${list} unit at ${at}`).id }); };
    const set = (key: string, value: string, part?: E7Part): void => { put(key, value, this.last(key)?.id ?? null, null, part); };
    const clear = (key: string): void => { changes.push({ type: "erase", id: required(this.last(key), key).id }); };
    const setPlace = (ref: string, place: E7Place, part: E7Part): void => { set(flag("place", ref), JSON.stringify(place), part); };
    const rows = view.outline.filter(entry => entry.kind === "row");
    const row = (id: string): E5Row => required(rows.find(entry => entry.id === id), `row ${id}`);

    switch (command.op) {
      case "create": {
        const target = block(command.beat, "b"), head = { kind: "h", id: command.id } as const, ref = target.ref;
        const moved = arrangement.placed.has(ref) || arrangement.following.has(ref);
        const above = arrangement.order[arrangement.order.indexOf(ref) - 1] ?? null;
        changes.push({ type: "record", kind: "h", id: command.id, part: "record" });
        if (target.start) insert(script(target.segment), target.start - 1, [head, ...command.name], "boundary", "name");
        else {
          const id = `seg-h-${command.id}`;
          changes.push({ type: "segment", id, head, part: "boundary" });
          insert(script(id), 0, [...command.name], "name");
          insert("order", stored.order.indexOf(target.segment), [id], "boundary");
        }
        if (moved) setPlace(refOf("h", command.id), { a: above, n: this.stamp(stored), u: target.start ? ref : null }, "headingPlace");
        break;
      }
      case "renameType":
      case "renameDelete":
      case "removeHeading": {
        const heading = block(command.id, "h"), key = script(heading.segment);
        if (command.op === "renameType") insert(key, heading.start + command.at, [command.value]);
        else if (command.op === "renameDelete") erase(key, heading.start + command.at);
        else set(flag("removedHeading", command.id), "true");
        break;
      }
      case "restoreHeading": clear(flag("removedHeading", command.id)); break;
      case "typeBeat":
      case "deleteBeat":
      case "split":
      case "unjoin": {
        const field: E5Field = "field" in command ? command.field : "audio";
        const at = spot(row(command.row), field, command.at, command.op === "deleteBeat");
        const beat = block(at.id, "b"), key = field === "audio" ? script(beat.segment) : visual(beat.id);
        const offset = at.offset + (field === "audio" ? beat.start : 0);
        event.target = beat.ref;
        if (command.op === "typeBeat") insert(key, offset, [command.value]);
        else if (command.op === "deleteBeat") erase(key, offset);
        else if (command.op === "unjoin") clear(flag("joined", required(at.seam, "join seam")));
        else {
          insert(key, offset, [{ kind: "b", id: command.id }], "boundary");
          changes.push({ type: "record", kind: "b", id: command.id, part: "record" });
          note("visualCell", refOf("b", command.id));
          for (const [ref, place] of Object.entries(stored.places)) {
            if (place?.a === beat.ref && arrangement.placed.has(ref)) setPlace(ref, { ...place, a: refOf("b", command.id) }, "repoint");
          }
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
      case "move": {
        const order = arrangement.order, from = order.indexOf(command.first), to = order.indexOf(command.last);
        if (from < 0 || to < from) throw new Error(`No run ${command.first}..${command.last}`);
        const members = order.slice(from, to + 1), moving = new Set(members);
        if (command.after !== null && moving.has(command.after)) throw new Error("Move into itself");
        event.members = members;
        const rest = order.filter(ref => !moving.has(ref));
        rest.splice(command.after === null ? 0 : rest.indexOf(command.after) + 1, 0, ...members);
        const until = this.untilOf(blocks), n = this.stamp(stored), planned = new Map<string, [E7Place, E7Part]>();
        const write = (ref: string, part: E7Part): void => {
          const end = arrangement.placed.has(ref) ? (stored.places[ref] as E7Place).u : until.get(ref) ?? null;
          planned.set(ref, [{ a: rest[rest.indexOf(ref) - 1] ?? null, n, u: end }, part]);
        };
        for (const ref of members) write(ref, "member");
        for (const ref of order) if (!moving.has(ref) && moving.has(arrangement.parent.get(ref) ?? "")) write(ref, "dependent");
        for (let round = 0; ; round++) {
          const trial = { ...stored.places, ...Object.fromEntries([...planned].map(([ref, [place]]) => [ref, place])) };
          const shown = arrangeBlocks(blocks, trial).order, wrong = rest.findIndex((ref, at) => shown[at] !== ref);
          if (wrong < 0) break;
          if (round > rest.length) { for (const ref of rest) write(ref, "dependent"); break; }
          write(required(rest[wrong], "misplaced block"), "dependent");
        }
        for (const [ref, [place, part]] of planned) setPlace(ref, place, part);
        break;
      }
    }
    for (const change of changes) {
      if (change.type === "put" && change.part) note(change.part, change.list.startsWith("place:") ? change.list.slice(6) : change.list);
      else if ((change.type === "record" || change.type === "segment") && change.part) note(change.part, change.id);
    }
    return event;
  }

  // why: the order a move must leave, from the commands alone: the run cut out and put back after its anchor
  static expectedOrder(before: readonly string[], command: E7Move): string[] {
    const from = before.indexOf(command.first), to = before.indexOf(command.last), members = before.slice(from, to + 1);
    const rest = before.filter(ref => !members.includes(ref));
    rest.splice(command.after === null ? 0 : rest.indexOf(command.after) + 1, 0, ...members);
    return rest;
  }
}

export { spot };
