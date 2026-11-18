// why: asked of an operation, whether its update has arrived; asked of a character or a written value, whether it
// is integrated, since the library keeps part of an arrived update pending until what it builds on arrives
export type Seen = (id: string) => boolean;
export type ModelValue = { json: string } | { container: string };
export type ContainerType = "text" | "map";

interface Source { readonly source: string; readonly added: string; readonly removed: string[] }
export interface ModelChar {
  readonly id: string; readonly container: string; readonly value: string; readonly op: string; readonly author: string;
  readonly left: string | null; readonly right: string | null; readonly context: ReadonlySet<string>; readonly deleters: string[];
  readonly sources: Map<string, Source[]>; readonly uncertain: Set<string>; readonly restoredFrom: string | null
}
export interface ModelItem {
  readonly id: string; readonly container: string; readonly key: string; readonly value: ModelValue; readonly client: number;
  readonly origin: string | null; readonly op: string; readonly author: string; readonly deleters: string[]; readonly restoredFrom: string | null
}
export interface ModelContainer { readonly id: string; readonly type: ContainerType; readonly holder: string | null }
interface Pair { readonly char: string; readonly source: string }
interface Effect { readonly kind: string; readonly container: string; readonly action: string | null; readonly add: Pair[]; readonly remove: Pair[]; readonly op: string }
interface TagIntent {
  readonly kind: string; readonly command: string; readonly reversals: string[]; readonly removes: readonly TagIntent[]; readonly on: boolean
}
export interface ModelEntry { readonly key: number; insertions: string[]; deletions: Set<string>; effects: Effect[]; tags: TagIntent[]; involved: boolean }
interface Group { cell: string; at: number; endsInSpace: boolean }
interface CopyState { readonly client: number; undo: ModelEntry[]; redo: ModelEntry[]; group: Group | null; capturing: boolean; readonly redone: Map<string, string> }
interface Building { readonly copy: string; readonly entry: ModelEntry; readonly joins: boolean; readonly typing: boolean; formatChanges: boolean }
// why: whether formatting undo changes anything depends on markers the model does not hold; a step that a person
// would expect to remove or restore formatting yet changes nothing is counted, not failed
interface Plan { readonly performed: boolean; readonly formats: boolean; readonly uncertain: boolean; readonly deletes: string[]; readonly restores: string[] }
interface FormatAction { readonly id: string; readonly op: string; readonly kind: string; readonly container: string; readonly on: boolean; readonly cover: Set<string>; readonly undone: string[]; readonly edge: Set<string> }
export interface ModelOp { readonly id: string; readonly copy: string; readonly index: number }
export interface Restoration { readonly from: string; readonly to: string; readonly kind: "char" | "item" }
export interface PressResult {
  readonly applied: number | null; readonly created: number | null; readonly restored: Restoration[];
  readonly uncertain: number; readonly formatSkips: number; readonly deletes: readonly string[]; readonly formatSources: readonly string[]
}
export interface Creation { readonly id: string; readonly kind: "char" | "item"; readonly container: string; readonly value: string; readonly key: string | null }
export interface ModelEnd { readonly predicted: boolean; readonly perAction: boolean; readonly merged: boolean; readonly key: number | null; readonly involved: boolean }
export interface TypingSpec { readonly cell: string; readonly typed: string; readonly replacing: boolean; readonly now: number }
export interface CommandChar { readonly id: string; readonly value: string; readonly names: ReadonlySet<string> }

export function changesMark(chars: readonly CommandChar[], kind: string, on: boolean, actionKey: boolean): boolean {
  return chars.length > 0 && ((actionKey && on) || chars.some(char => char.names.has(kind) !== on));
}

// why: a visually uniform range can still have a closing and an opening marker between its characters
export function changesPlainMarkers(
  kind: string, on: boolean, activeBefore: boolean, from: number, to: number,
  markers: readonly { readonly index: number; readonly key: string; readonly on: boolean }[]
): boolean {
  let startGap = true;
  for (const marker of markers) {
    if (marker.index < from) continue;
    if (marker.index >= to) break;
    if (startGap && marker.index === from && marker.on === (marker.key === kind && on)) {
      if (marker.key === kind) activeBefore = marker.on;
      continue;
    }
    startGap = false;
    if (marker.key === kind) return true;
  }
  return activeBefore !== on;
}

export function markCommand(chars: readonly CommandChar[], targets: ReadonlySet<string>, kind: string, on: boolean): CommandChar[] {
  return chars.map(char => {
    if (!targets.has(char.id)) return char;
    const names = new Set(char.names);
    if (on) names.add(kind); else names.delete(kind);
    return { ...char, names };
  });
}

export const MODEL_GROUP_MS = 1000;
export const ANY_KIND = "*";

// why: the order of writes to one map key is the library's documented rule: after the write it replaced, and of two
// writes after the same one, the lower client id first; the rightmost write is the value
export function integrateWrite(list: string[], item: ModelItem, items: ReadonlyMap<string, ModelItem>): void {
  const start = item.origin === null ? -1 : list.indexOf(item.origin);
  if (item.origin !== null && start < 0) throw new Error(`Write ${item.id} replaces unknown ${item.origin}`);
  const before = new Set<string>(), conflicting = new Set<string>();
  let position = start;
  for (let index = start + 1; index < list.length; index++) {
    const other = items.get(list[index] as string) as ModelItem;
    before.add(other.id); conflicting.add(other.id);
    if (other.origin === item.origin) {
      if (other.client < item.client) { position = index; conflicting.clear(); } else break;
    } else if (other.origin !== null && before.has(other.origin)) {
      if (!conflicting.has(other.origin)) { position = index; conflicting.clear(); }
    } else break;
  }
  list.splice(position + 1, 0, item.id);
}

export class UndoModel {
  readonly chars = new Map<string, ModelChar>();
  readonly items = new Map<string, ModelItem>();
  readonly containers = new Map<string, ModelContainer>();
  readonly ops = new Map<string, ModelOp>();
  keepCreated: "keep-holding" | "keep-always" = "keep-always";
  predictKindKeys = false;
  private readonly actions: FormatAction[] = [];
  private readonly lists = new Map<string, string[]>();
  private readonly copies = new Map<string, CopyState>();
  private readonly order = new Map<string, number>();
  private readonly tags = new Map<string, TagIntent[]>();
  private building: Building | null = null;
  private serial = 0;
  private entries = 0;

  addCopy(name: string, client: number): void {
    this.copies.set(name, { client, undo: [], redo: [], group: null, capturing: false, redone: new Map() });
  }

  private state(copy: string): CopyState {
    const state = this.copies.get(copy);
    if (!state) throw new Error(`Unknown copy ${copy}`);
    return state;
  }

  stacks(copy: string): { undo: number; redo: number } {
    const state = this.state(copy);
    return { undo: state.undo.length, redo: state.redo.length };
  }

  undoKeys(copy: string): number[] { return this.state(copy).undo.map(entry => entry.key); }

  private next(prefix: string): string {
    const id = `${prefix}${++this.serial}`;
    this.order.set(id, this.serial);
    return id;
  }

  private rank(id: string): number { return this.order.get(id) ?? 0; }

  op(copy: string): string {
    const id = this.next("op");
    this.ops.set(id, { id, copy, index: this.serial });
    return id;
  }

  private author(op: string): string { return this.ops.get(op)?.copy ?? "seed"; }

  private context(seen: Seen): Set<string> {
    return new Set(["hydration", ...[...this.ops.keys(), ...this.chars.keys(), ...this.items.keys()].filter(seen)]);
  }

  root(id: string, type: ContainerType): void { this.containers.set(id, { id, type, holder: null }); }

  hydrateChar(id: string, container: string, value: string, left: string | null): void {
    this.chars.set(id, { id, container, value, op: "hydration", author: "seed", left, right: null, context: new Set(["hydration"]), deleters: [], sources: new Map(), uncertain: new Set(), restoredFrom: null });
    this.order.set(id, ++this.serial);
  }

  hydrateItem(id: string, container: string, key: string, json: string, client: number, type: ContainerType | null): void {
    const value: ModelValue = type ? { container: `k:${id}` } : { json };
    this.items.set(id, { id, container, key, value, client, origin: null, op: "hydration", author: "seed", deleters: [], restoredFrom: null });
    this.list(container, key).push(id);
    this.order.set(id, ++this.serial);
    if (type) this.containers.set(`k:${id}`, { id: `k:${id}`, type, holder: id });
  }

  private list(container: string, key: string): string[] {
    const name = `${container}\u0000${key}`;
    let list = this.lists.get(name);
    if (!list) { list = []; this.lists.set(name, list); }
    return list;
  }

  keys(container: string): string[] {
    const prefix = `${container}\u0000`;
    return [...this.lists.keys()].filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
  }

  containerDeleted(id: string, seen: Seen): boolean {
    const container = this.containers.get(id);
    if (!container) throw new Error(`Unknown container ${id}`);
    return container.holder !== null && this.itemDeleted(this.items.get(container.holder) as ModelItem, seen);
  }

  itemDeleted(item: ModelItem, seen: Seen): boolean {
    if (item.deleters.some(seen) || this.containerDeleted(item.container, seen)) return true;
    const list = this.list(item.container, item.key);
    return list.slice(list.indexOf(item.id) + 1).some(seen);
  }

  charDeleted(char: ModelChar, seen: Seen): boolean {
    return char.deleters.some(seen) || this.containerDeleted(char.container, seen);
  }

  visibleChar(char: ModelChar, seen: Seen): boolean { return seen(char.id) && !this.charDeleted(char, seen); }

  current(container: string, key: string, seen: Seen): ModelItem | null {
    const last = this.rightmost(container, key, seen);
    return last && !this.itemDeleted(last, seen) ? last : null;
  }

  projectedRows(beats: readonly string[], seen: Seen): string[] {
    const placed = new Set(beats), rows = new Set<string>();
    const field = (beat: string, name: string): unknown => {
      const holder = this.current("root:beats", beat, seen);
      const value = holder && this.current(`k:${holder.id}`, name, seen)?.value;
      return value && "json" in value ? JSON.parse(value.json) : undefined;
    };
    for (const beat of placed) {
      const visited = new Set<string>();
      let target = beat;
      while (!field(target, "removed")) {
        const into = (field(target, "joined") as { into?: string } | undefined)?.into;
        if (!into || !placed.has(into) || visited.has(into)) { rows.add(target); break; }
        visited.add(target);
        target = into;
      }
    }
    return [...rows];
  }

  lastWrite(container: string, key: string): string | null { return this.list(container, key).at(-1) ?? null; }

  private rightmost(container: string, key: string, seen: Seen): ModelItem | null {
    return this.list(container, key).filter(seen).map(id => this.items.get(id) as ModelItem).at(-1) ?? null;
  }

  liveSources(char: ModelChar, kind: string, seen: Seen): string[] {
    return (char.sources.get(kind) ?? []).filter(source => seen(source.added) && !source.removed.some(seen)).map(source => source.source);
  }

  kinds(char: ModelChar, seen: Seen): Set<string> {
    const result = new Set<string>();
    for (const kind of char.sources.keys()) if (this.liveSources(char, kind, seen).length) result.add(kind);
    return result;
  }

  // why: a command is one entry, joined to the open typing group by the app's rule; the library adds nothing when
  // the transaction changed nothing, so the entry is settled at the end
  begin(copy: string, typing: TypingSpec | null): string {
    const state = this.state(copy), op = this.op(copy), last = state.group;
    let joins = false;
    if (typing) {
      joins = !typing.replacing && last !== null && last.cell === typing.cell && typing.now - last.at < MODEL_GROUP_MS && !(last.endsInSpace && /\S/.test(typing.typed));
      if (!joins) state.capturing = false;
      if (typing.replacing) state.group = null;
      else if (joins && last) { last.at = typing.now; if (typing.typed) last.endsInSpace = /\s$/.test(typing.typed); }
      else state.group = { cell: typing.cell, at: typing.now, endsInSpace: /\s$/.test(typing.typed) };
    } else { state.group = null; state.capturing = false; }
    this.building = { copy, entry: { key: -1, insertions: [], deletions: new Set(), effects: [], tags: [], involved: false }, joins, typing: !!typing && !typing.replacing, formatChanges: false };
    return op;
  }

  private entry(): ModelEntry {
    if (!this.building) throw new Error("No command is open");
    return this.building.entry;
  }

  end(changed: boolean): ModelEnd {
    const building = this.building;
    if (!building) throw new Error("No command is open");
    this.building = null;
    const state = this.state(building.copy), entry = building.entry;
    const content = entry.insertions.length > 0 || entry.deletions.size > 0;
    const perAction = content || entry.effects.length > 0;
    const predicted = this.predictKindKeys ? content || building.formatChanges : perAction;
    if (!changed) return { predicted, perAction, merged: false, key: null, involved: entry.involved };
    state.redo = [];
    const top = state.undo.at(-1);
    if (building.joins && state.capturing && top) {
      top.insertions.push(...entry.insertions);
      for (const id of entry.deletions) top.deletions.add(id);
      top.effects.push(...entry.effects);
      top.tags.push(...entry.tags);
      top.involved ||= entry.involved;
      return { predicted, perAction, merged: true, key: top.key, involved: entry.involved };
    }
    const added: ModelEntry = { ...entry, key: ++this.entries };
    state.undo.push(added);
    state.capturing = building.typing;
    return { predicted, perAction, merged: false, key: added.key, involved: entry.involved };
  }

  expectFormat(changed: boolean): void {
    if (!this.building) throw new Error("No command is open");
    this.building.formatChanges ||= changed;
  }

  top(copy: string, back: boolean): number | null {
    const state = this.state(copy);
    return (back ? state.undo : state.redo).at(-1)?.key ?? null;
  }

  originalCharId(char: ModelChar): string {
    while (char.restoredFrom !== null) char = this.chars.get(char.restoredFrom) as ModelChar;
    return char.id;
  }

  private activeTag(intent: TagIntent, seen: Seen): boolean {
    return seen(intent.command) && intent.reversals.filter(seen).length % 2 === 0;
  }

  private addTagIntent(char: ModelChar, kind: string, on: boolean, command: string, seen: Seen): void {
    const id = this.originalCharId(char), list = this.tags.get(id) ?? [];
    const removes = on ? [] : list.filter(intent => intent.kind === kind && intent.on && this.activeTag(intent, seen));
    const intent: TagIntent = { kind, on, command, reversals: [], removes };
    list.push(intent);
    this.tags.set(id, list);
    this.entry().tags.push(intent);
  }

  requestedTags(char: ModelChar, seen: Seen): Map<string, string[]> {
    const active = (this.tags.get(this.originalCharId(char)) ?? []).filter(intent => this.activeTag(intent, seen));
    const removed = new Set(active.flatMap(intent => intent.removes)), result = new Map<string, string[]>();
    for (const intent of active) {
      if (!intent.on || removed.has(intent)) continue;
      const requests = result.get(intent.kind) ?? [];
      requests.push(intent.command);
      result.set(intent.kind, requests);
    }
    return result;
  }

  private involve(container: string, seen: Seen): void {
    const entry = this.entry();
    if (!entry.involved) entry.involved = [...this.chars.values()].some(char => char.container === container && this.visibleChar(char, seen) && this.kinds(char, seen).size > 0);
  }

  insert(op: string, container: string, values: readonly string[], left: string | null, right: string | null, marks: readonly string[], seen: Seen, inheritAll = false): Creation[] {
    this.involve(container, seen);
    const leftChar = left ? this.chars.get(left) ?? null : null, created: Creation[] = [], context = this.context(seen);
    const wanted = inheritAll ? (leftChar ? [...this.kinds(leftChar, seen)] : []) : marks;
    let previous = left;
    for (const value of values) {
      const id = this.next("c"), sources = new Map<string, Source[]>();
      for (const kind of wanted) {
        const inherited = leftChar ? this.liveSources(leftChar, kind, seen) : [];
        sources.set(kind, (inherited.length ? inherited : [`${op}#${kind}`]).map(source => ({ source, added: op, removed: [] })));
      }
      const unknown = leftChar ? (leftChar.uncertain.has(ANY_KIND) ? (inheritAll ? [ANY_KIND] : wanted) : wanted.filter(kind => leftChar.uncertain.has(kind))) : [];
      const char: ModelChar = { id, container, value, op, author: this.author(op), left: previous, right, context, deleters: [], sources, uncertain: new Set(unknown), restoredFrom: null };
      this.chars.set(id, char);
      if (!inheritAll) for (const kind of marks) if (kind.startsWith("t:")) this.addTagIntent(char, kind, true, op, seen);
      for (const action of this.actions) if (action.container === container && !seen(action.op)) this.place(char, action);
      this.entry().insertions.push(id);
      created.push({ id, kind: "char", container, value, key: null });
      previous = id;
    }
    if (wanted.length) this.entry().involved = true;
    return created;
  }

  // why: a character typed unseen between two characters a formatting action covered lies inside its range; one typed
  // beside its edge, or where its typist could not see every covered character, may fall either side
  private place(char: ModelChar, action: FormatAction): void {
    const inLeft = char.left !== null && action.cover.has(char.left), inRight = char.right !== null && action.cover.has(char.right);
    const was: Seen = op => char.context.has(op);
    if (inLeft && inRight) {
      action.cover.add(char.id);
      if (!action.on) { char.uncertain.add(action.kind); return; }
      const list = char.sources.get(action.kind) ?? [];
      list.push({ source: action.id, added: action.op, removed: [...action.undone] });
      char.sources.set(action.kind, list);
      return;
    }
    const nearEdge = [char.left, char.right].some(id => id !== null && action.edge.has(id));
    if (inLeft || inRight || nearEdge || [...action.cover].some(id => !this.visibleChar(this.chars.get(id) as ModelChar, was))) {
      char.uncertain.add(action.kind);
      action.edge.add(char.id);
    }
  }

  remove(op: string, ids: readonly string[], seen: Seen): void {
    for (const id of ids) {
      const char = this.chars.get(id) as ModelChar;
      char.deleters.push(op);
      this.entry().deletions.add(id);
      this.involve(char.container, seen);
    }
  }

  format(op: string, container: string, ids: readonly string[], kind: string, on: boolean, seen: Seen): void {
    const entry = this.entry(), action: FormatAction = { id: `${op}#${kind}`, op, kind, container, on, cover: new Set(ids), undone: [], edge: new Set() };
    entry.involved = true;
    const add: Pair[] = [], remove: Pair[] = [];
    for (const id of ids) {
      const char = this.chars.get(id) as ModelChar, list = char.sources.get(kind) ?? [];
      if (kind.startsWith("t:")) this.addTagIntent(char, kind, on, op, seen);
      if (on) {
        list.push({ source: action.id, added: op, removed: [] });
        char.sources.set(kind, list);
        add.push({ char: id, source: action.id });
        continue;
      }
      for (const source of list) {
        if (!seen(source.added) || source.removed.some(seen)) continue;
        source.removed.push(op);
        remove.push({ char: id, source: source.source });
      }
    }
    const unseen = [...this.chars.values()].filter(char => char.container === container && !seen(char.id)).sort((a, b) => this.rank(a.id) - this.rank(b.id));
    for (const char of unseen) {
      const before = char.sources.get(kind)?.length ?? 0;
      this.place(char, action);
      if ((char.sources.get(kind)?.length ?? 0) > before) add.push({ char: char.id, source: action.id });
    }
    this.actions.push(action);
    if (add.length || remove.length) entry.effects.push({ kind, container, action: on ? action.id : null, add, remove, op });
  }

  set(op: string, container: string, key: string, value: (id: string) => ModelValue, seen: Seen): Creation {
    const state = this.state(this.author(op)), entry = this.entry(), origin = this.rightmost(container, key, seen);
    if (origin && !this.itemDeleted(origin, seen)) entry.deletions.add(origin.id);
    const id = this.next("m"), written = value(id);
    const item: ModelItem = { id, container, key, value: written, client: state.client, origin: origin?.id ?? null, op, author: this.author(op), deleters: [], restoredFrom: null };
    this.items.set(id, item);
    integrateWrite(this.list(container, key), item, this.items);
    entry.insertions.push(id);
    return { id, kind: "item", container, value: "json" in written ? written.json : "container", key };
  }

  createContainer(op: string, parent: string, key: string, type: ContainerType, seen: Seen): Creation {
    return this.set(op, parent, key, id => {
      this.containers.set(`k:${id}`, { id: `k:${id}`, type, holder: id });
      return { container: `k:${id}` };
    }, seen);
  }

  clear(op: string, container: string, key: string, seen: Seen): boolean {
    const item = this.current(container, key, seen);
    if (!item) return false;
    item.deleters.push(op);
    this.entry().deletions.add(item.id);
    return true;
  }

  undo(copy: string, op: string, seen: Seen, decide: (key: number) => boolean): PressResult { return this.press(copy, op, seen, decide, true); }

  redo(copy: string, op: string, seen: Seen, decide: (key: number) => boolean): PressResult { return this.press(copy, op, seen, decide, false); }

  private press(copy: string, op: string, seen: Seen, decide: (key: number) => boolean, back: boolean): PressResult {
    const state = this.state(copy), from = back ? state.undo : state.redo, to = back ? state.redo : state.undo;
    state.group = null; state.capturing = false;
    let uncertain = 0, formatSkips = 0;
    while (from.length) {
      const entry = from.pop() as ModelEntry, plan = this.plan(state, entry, seen);
      let performed = plan.performed;
      if (!performed && plan.uncertain) {
        uncertain++;
        performed = decide(entry.key);
        if (!performed && plan.formats) formatSkips++;
      }
      if (!performed) continue;
      const result = this.commit(state, entry, plan, op, seen);
      to.push(result.entry);
      const formatSources = entry.effects.flatMap(effect => effect.action === null ? [] : [effect.action]);
      return { applied: entry.key, created: result.entry.key, restored: result.restored, uncertain, formatSkips, deletes: plan.deletes, formatSources };
    }
    return { applied: null, created: null, restored: [], uncertain, formatSkips, deletes: [], formatSources: [] };
  }

  private follow(state: CopyState, id: string): string {
    let current = id;
    while (state.redone.has(current)) current = state.redone.get(current) as string;
    return current;
  }

  private stackDeleted(state: CopyState, id: string): boolean {
    return [...state.undo, ...state.redo].some(entry => entry.deletions.has(id));
  }

  private alive(id: string, seen: Seen): boolean {
    const char = this.chars.get(id);
    if (char) return this.visibleChar(char, seen);
    const item = this.items.get(id);
    return !!item && seen(item.id) && !this.itemDeleted(item, seen);
  }

  // why: the library puts a map value back only when every later write to that key is one this copy's history made
  private restorable(state: CopyState, entry: ModelEntry, item: ModelItem, seen: Seen): string | null {
    let left: ModelItem = item;
    for (;;) {
      const list = this.list(left.container, left.key);
      const after = list.slice(list.indexOf(left.id) + 1).filter(seen).map(id => this.items.get(id) as ModelItem)[0];
      if (!after) return left.id;
      if (!(state.redone.has(after.id) || entry.insertions.includes(after.id) || this.stackDeleted(state, after.id))) return null;
      left = after;
      while (state.redone.has(left.id)) left = this.items.get(state.redone.get(left.id) as string) as ModelItem;
    }
  }

  private canRestore(state: CopyState, entry: ModelEntry, id: string, seen: Seen, trail: Set<string>): boolean {
    if (state.redone.has(id)) return true;
    if (trail.has(id)) return false;
    trail.add(id);
    const char = this.chars.get(id), item = this.items.get(id), container = char?.container ?? item?.container;
    if (container === undefined) return false;
    const holder = this.containers.get(container)?.holder ?? null;
    if (holder !== null && this.containerDeleted(container, seen) && !state.redone.has(holder)) {
      if (!entry.deletions.has(holder) || entry.insertions.includes(holder) || !this.canRestore(state, entry, holder, seen, trail)) return false;
    }
    return char ? true : this.restorable(state, entry, item as ModelItem, seen) !== null;
  }

  private plan(state: CopyState, entry: ModelEntry, seen: Seen): Plan {
    const deletes: string[] = [];
    for (const id of entry.insertions) {
      const target = this.follow(state, id);
      if (this.alive(target, seen) && !deletes.includes(target)) deletes.push(target);
    }
    const restores = [...entry.deletions].filter(id => !entry.insertions.includes(id) && this.canRestore(state, entry, id, seen, new Set()));
    const effective = deletes.filter(id => {
      const item = this.items.get(id);
      if (!item || !("container" in item.value)) return true;
      if (this.keepCreated === "keep-always") return false;
      const inside = item.value.container;
      const chars = [...this.chars.values()].some(char => char.container === inside && this.visibleChar(char, seen) && !deletes.includes(char.id));
      const keys = this.keys(inside).some(key => { const live = this.current(inside, key, seen); return !!live && !deletes.includes(live.id); });
      return !chars && !keys;
    });
    const formats = entry.effects.some(effect => effect.action
      ? [...this.chars.values()].some(char => this.visibleChar(char, seen) && (char.sources.get(effect.kind) ?? []).some(source => source.source === effect.action && !source.removed.some(seen)))
      : [...effect.add, ...effect.remove].some(pair => this.visibleChar(this.chars.get(pair.char) as ModelChar, seen)));
    const performed = effective.length > 0 || restores.length > 0;
    return { performed, formats, uncertain: !performed && (entry.involved || entry.effects.length > 0), deletes: effective, restores };
  }

  private commit(state: CopyState, entry: ModelEntry, plan: Plan, op: string, seen: Seen): { entry: ModelEntry; restored: Restoration[] } {
    const made: ModelEntry = { key: ++this.entries, insertions: [], deletions: new Set(), effects: [], tags: entry.tags, involved: entry.involved };
    const restored: Restoration[] = [], view: Seen = id => id === op || seen(id), context = this.context(view);
    const restore = (id: string): string => {
      const existing = state.redone.get(id);
      if (existing) return existing;
      const char = this.chars.get(id), item = this.items.get(id);
      let container = (char?.container ?? item?.container) as string;
      const holder = this.containers.get(container)?.holder ?? null;
      if (holder !== null && this.containerDeleted(container, view)) container = `k:${this.follow(state, restore(holder))}`;
      if (char) {
        const copy: ModelChar = { id: this.next("c"), container, value: char.value, op, author: this.author(op), left: null, right: null, context, deleters: [], sources: new Map(), uncertain: new Set([ANY_KIND]), restoredFrom: char.id };
        this.chars.set(copy.id, copy);
        state.redone.set(id, copy.id);
        made.insertions.push(copy.id);
        restored.push({ from: id, to: copy.id, kind: "char" });
        return copy.id;
      }
      const source = item as ModelItem, left = this.restorable(state, entry, source, view);
      const origin = left !== null && (this.items.get(left) as ModelItem).container === container ? left : this.rightmost(container, source.key, view)?.id ?? null;
      const previous = this.rightmost(container, source.key, view), replaced = previous && !this.itemDeleted(previous, view) ? previous.id : null;
      const copyId = this.next("m");
      let value = source.value;
      if ("container" in source.value) {
        this.containers.set(`k:${copyId}`, { id: `k:${copyId}`, type: (this.containers.get(source.value.container) as ModelContainer).type, holder: copyId });
        value = { container: `k:${copyId}` };
      }
      const copy: ModelItem = { id: copyId, container, key: source.key, value, client: state.client, origin, op, author: this.author(op), deleters: [], restoredFrom: source.id };
      this.items.set(copyId, copy);
      integrateWrite(this.list(container, source.key), copy, this.items);
      if (replaced !== null) made.deletions.add(replaced);
      state.redone.set(id, copyId);
      made.insertions.push(copyId);
      restored.push({ from: id, to: copyId, kind: "item" });
      return copyId;
    };
    for (const id of plan.restores) restore(id);
    for (const id of [...plan.deletes].sort((a, b) => this.rank(b) - this.rank(a))) {
      const char = this.chars.get(id), item = this.items.get(id);
      if (char) { char.deleters.push(op); made.deletions.add(id); continue; }
      if (!item) continue;
      if (!this.itemDeleted(item, view)) made.deletions.add(item.id);
      item.deleters.push(op);
      if (!("container" in item.value)) continue;
      for (const child of this.chars.values()) if (child.container === item.value.container && seen(child.id) && !child.deleters.some(seen)) { made.deletions.add(child.id); child.deleters.push(op); }
      for (const child of this.items.values()) if (child.container === item.value.container && seen(child.id) && !this.itemDeleted(child, seen)) { made.deletions.add(child.id); child.deleters.push(op); }
    }
    for (const effect of entry.effects) made.effects.push(this.reverse(effect, op));
    for (const intent of entry.tags) intent.reversals.push(op);
    return { entry: made, restored };
  }

  // why: undoing a formatting action takes its mark from every character it reached, also those typed into it later;
  // characters typed into the cell after the action may be inside the restored range or not, so they are not predicted
  private reverse(effect: Effect, op: string): Effect {
    const affected = new Set<string>();
    let undone: Pair[] = [], redone: Pair[] = [];
    if (effect.action) {
      this.actions.find(action => action.id === effect.action)?.undone.push(op);
      for (const char of this.chars.values()) {
        for (const source of char.sources.get(effect.kind) ?? []) {
          if (source.source !== effect.action || source.removed.length) continue;
          source.removed.push(op);
          undone.push({ char: char.id, source: source.source });
          affected.add(char.id);
        }
      }
    } else {
      for (const pair of effect.add) this.take(pair, effect.kind, op);
      for (const pair of effect.remove) this.give(pair, effect.kind, op);
      undone = effect.add; redone = effect.remove;
      for (const pair of [...undone, ...redone]) affected.add(pair.char);
    }
    const origin = this.ops.get(effect.op)?.index ?? 0;
    for (const char of this.chars.values()) {
      if (char.container === effect.container && !affected.has(char.id) && (this.ops.get(char.op)?.index ?? 0) > origin) char.uncertain.add(effect.kind);
    }
    return { kind: effect.kind, container: effect.container, action: null, add: redone, remove: undone, op };
  }

  private give(pair: Pair, kind: string, op: string): void {
    const char = this.chars.get(pair.char) as ModelChar, list = char.sources.get(kind) ?? [];
    list.push({ source: pair.source, added: op, removed: [] });
    char.sources.set(kind, list);
  }

  private take(pair: Pair, kind: string, op: string): void {
    const char = this.chars.get(pair.char) as ModelChar;
    for (const source of char.sources.get(kind) ?? []) if (source.source === pair.source && !source.removed.length) source.removed.push(op);
  }
}
