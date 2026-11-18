import * as Y from "yjs";
import type { Marks } from "../../../../src/core/text/runs.ts";
import { NativeReplica, nativeCopy, nativeMarkName } from "../native/variant.ts";
import type { NativeDeltaItem, NativeField } from "../native/variant.ts";
import { RECORD_ROOTS, UndoLayer, changedDocument, readRecords, readStatus } from "./layer.ts";
import type { CreationRule, RecordRoot, UndoCaret, UndoStackItem } from "./layer.ts";
import { ANY_KIND, UndoModel } from "./model.ts";
import type { Creation, ModelChar, ModelItem, Seen, TypingSpec } from "./model.ts";

export type Delivery = "forward" | "reverse" | "twice";
export interface WorldRow { id: string; audioText: string; visualText?: string; status?: string }
export interface WorldOptions { names?: readonly string[]; clients?: readonly number[]; bound?: number; creations?: CreationRule }
export type Part =
  | { do: "insert"; beat: string; field: NativeField; at: number; text: string; marks?: readonly string[] }
  | { do: "delete"; beat: string; field: NativeField; from: number; to: number }
  | { do: "format"; beat: string; field: NativeField; from: number; to: number; mark: string; on: boolean }
  | { do: "set"; beat: string; key: string; value: unknown }
  | { do: "clear"; beat: string; key: string }
  | { do: "split"; beat: string; at: number; created: string }
  | { do: "record"; root: RecordRoot; id: string; fields: Record<string, unknown> }
  | { do: "field"; root: RecordRoot; id: string; key: string; value: unknown };
export type Step =
  | { readonly act: "type"; readonly by: string; readonly at: number; readonly beat: string; readonly field: NativeField; readonly offset: number; readonly text: string; readonly marks: readonly string[] }
  | { readonly act: "erase"; readonly by: string; readonly at: number; readonly beat: string; readonly field: NativeField; readonly from: number; readonly to: number }
  | { readonly act: "replace"; readonly by: string; readonly at: number; readonly beat: string; readonly field: NativeField; readonly from: number; readonly to: number; readonly text: string }
  | { readonly act: "command"; readonly by: string; readonly at: number; readonly parts: readonly Part[] }
  | { readonly act: "undo" | "redo"; readonly by: string; readonly at: number }
  | { readonly act: "deliver"; readonly from: string; readonly to: string; readonly mode: Delivery; readonly count: number }
  | { readonly act: "settle"; readonly mode: Delivery };
export interface Loss { readonly what: string; readonly author: string; readonly by: string; readonly unseen: boolean }

export class CheckFailure extends Error {}
export type E3Type = Y.Text | Y.Map<unknown> | Y.Array<unknown>;
export interface MarkMismatch { readonly at: string; readonly char: string; readonly kind: string; readonly expected: boolean }
export interface WorldStats {
  presses: number; uncertainPresses: number; uncertainCommands: number; markMismatches: MarkMismatch[]; checks: number;
  formatSkips: number; formatSkipExample: string[] | null; undone: number; redone: number
}

interface Logged { readonly update: Uint8Array; readonly op: string }
interface OpRecord { readonly copy: string; readonly client: number; readonly start: number; readonly end: number; readonly context: ReadonlySet<string> }
interface Watched { changed: number; added: { item: UndoStackItem; type: string }[]; updated: number }
interface YChar { readonly id: Y.ID; readonly value: string; readonly names: ReadonlySet<string> }

export class Copy {
  readonly name: string;
  readonly client: number;
  readonly replica: NativeReplica;
  readonly layer: UndoLayer;
  readonly log: Logged[] = [];
  readonly delivered = new Set<string>();
  current: string | null = null;
  watched: Watched | null = null;

  constructor(name: string, client: number, replica: NativeReplica, layer: UndoLayer) {
    this.name = name; this.client = client; this.replica = replica; this.layer = layer;
  }
}

const key = (id: Y.ID): string => `${id.client}:${id.clock}`;

export function itemOf(type: E3Type): Y.Item {
  const item = type._item;
  if (!item) throw new Error("A root type has no item");
  return item;
}

export function textChars(text: Y.Text): YChar[] {
  const result: YChar[] = [], attributes = new Map<string, unknown>();
  for (let item = text._start; item; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentFormat) {
      if (content.value === null) attributes.delete(content.key); else attributes.set(content.key, content.value);
      continue;
    }
    const names = new Set([...attributes].filter(([, value]) => value === true).map(([name]) => nativeMarkName(name)));
    if (content instanceof Y.ContentString) {
      for (let index = 0; index < content.str.length; index++) result.push({ id: Y.createID(item.id.client, item.id.clock + index), value: content.str.charAt(index), names });
    } else if (content instanceof Y.ContentEmbed) result.push({ id: item.id, value: JSON.stringify(content.embed), names });
  }
  return result;
}

export function marked(delta: readonly NativeDeltaItem[]): string {
  const parts: { text: string; names: string }[] = [];
  for (const item of delta) {
    const names = [...new Set(Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([name]) => nativeMarkName(name)))].sort().join(",");
    const text = typeof item.insert === "string" ? item.insert : "◆", last = parts.at(-1);
    if (last?.names === names) last.text += text; else parts.push({ text, names });
  }
  return parts.map(part => part.names ? `[${part.text}|${part.names}]` : part.text).join("");
}

export function rowsOf(replica: NativeReplica): string[] {
  return replica.rows().map(row => {
    const flags = ["removed", "joined"].filter(flag => row.fields[flag] !== undefined).map(flag => ` {${flag}}`).join("");
    return `${row.id}: ${marked(row.audio)}${row.visual.length ? ` / ${marked(row.visual)}` : ""} (${readStatus(replica, row.id)})${flags}`;
  });
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, inner]) => [name, sorted(inner)]));
}

function marksOf(names: readonly string[]): Marks {
  const marks: Record<string, unknown> = {};
  for (const name of names) if (name.startsWith("t:")) marks.tag = name.slice(2); else marks[name] = true;
  return marks as Marks;
}

export class World {
  readonly model = new UndoModel();
  readonly copies: Copy[];
  readonly history: string[] = [];
  readonly steps: Step[] = [];
  private settling = false;
  readonly stats: WorldStats = { presses: 0, uncertainPresses: 0, uncertainCommands: 0, markMismatches: [], checks: 0, formatSkips: 0, formatSkipExample: null, undone: 0, redone: 0 };
  clock = 1_000_000;
  strictMarks = false;
  private readonly toModel = new Map<string, string>();
  private readonly toYjs = new Map<string, Y.ID>();
  private readonly records = new Map<string, OpRecord>();
  private readonly keys = new Map<UndoStackItem, number>();
  private readonly read = new Map<string, number>();
  private late = 0;

  constructor(rows: readonly WorldRow[], options: WorldOptions = {}) {
    const names = options.names ?? ["A", "B", "C"], clients = options.clients ?? names.map((_, index) => index + 1);
    const seed = new NativeReplica(900, 0, "act");
    seed.hydrate({ rows: rows.map(row => ({ visualText: "", status: "todo", ...row })) });
    this.bindSeed(seed.doc);
    if (options.bound !== undefined) this.model.bound = options.bound;
    const creations = options.creations ?? "keep-always";
    this.model.keepCreated = creations;
    this.copies = names.map((name, index) => {
      const client = clients[index] as number, replica = nativeCopy(seed, client);
      const layer = new UndoLayer(replica, { now: () => this.clock, creations, ...(options.bound !== undefined ? { bound: options.bound } : {}) });
      const copy = new Copy(name, client, replica, layer);
      this.model.addCopy(name, client);
      replica.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") copy.log.push({ update, op: copy.current ?? "cleanup" }); });
      replica.doc.on("afterTransaction", (transaction: Y.Transaction) => { if (copy.watched && changedDocument(transaction)) copy.watched.changed++; });
      layer.manager.on("stack-item-added", event => { copy.watched?.added.push({ item: event.stackItem, type: event.type }); });
      layer.manager.on("stack-item-updated", () => { if (copy.watched) copy.watched.updated++; });
      return copy;
    });
    seed.destroy();
  }

  copy(name: string): Copy {
    const found = this.copies.find(copy => copy.name === name);
    if (!found) throw new Error(`No copy ${name}`);
    return found;
  }

  private bind(id: Y.ID, model: string): void {
    this.toModel.set(key(id), model);
    this.toYjs.set(model, id);
  }

  private modelOf(id: Y.ID): string {
    const found = this.toModel.get(key(id));
    if (!found) throw new Error(`Unbound identity ${key(id)}`);
    return found;
  }

  private bindSeed(doc: Y.Doc): void {
    for (const name of ["beats", "visuals", ...RECORD_ROOTS]) this.model.root(`root:${name}`, "map");
    for (const [segment, record] of doc.getMap<Y.Map<unknown>>("segments")) {
      this.model.root(`seg:${segment}`, "text");
      this.bindText(record.get("text") as Y.Text, `seg:${segment}`);
    }
    for (const [beat, record] of doc.getMap<Y.Map<unknown>>("beats")) {
      const holder = itemOf(record), id = `y${key(holder.id)}`;
      this.bind(holder.id, id);
      this.model.hydrateItem(id, "root:beats", beat, "", holder.id.client, "map");
      for (const [field, value] of record) {
        const item = record._map.get(field) as Y.Item, child = `y${key(item.id)}`;
        this.bind(item.id, child);
        this.model.hydrateItem(child, `k:${id}`, field, JSON.stringify(value), item.id.client, null);
      }
    }
    for (const [beat, text] of doc.getMap<Y.Text>("visuals")) {
      const holder = itemOf(text), id = `y${key(holder.id)}`;
      this.bind(holder.id, id);
      this.model.hydrateItem(id, "root:visuals", beat, "", holder.id.client, "text");
      this.bindText(text, `k:${id}`);
    }
  }

  private bindText(text: Y.Text, container: string): void {
    let left: string | null = null;
    for (const char of textChars(text)) {
      const id = `y${key(char.id)}`;
      this.bind(char.id, id);
      this.model.hydrateChar(id, container, char.value, left);
      left = id;
    }
  }

  typeOf(doc: Y.Doc, container: string): E3Type {
    if (container.startsWith("root:")) return doc.getMap(container.slice(5));
    if (container.startsWith("seg:")) return (doc.getMap<Y.Map<unknown>>("segments").get(container.slice(4)) as Y.Map<unknown>).get("text") as Y.Text;
    const holder = this.toYjs.get(container.slice(2));
    if (!holder) throw new Error(`Unbound container ${container}`);
    const item = Y.getItem(doc.store, holder) as Y.Item;
    return (item.content as Y.ContentType).type as E3Type;
  }

  seenBy(copy: Copy): Seen {
    const vector = Y.decodeStateVector(Y.encodeStateVector(copy.replica.doc));
    return id => {
      if (id === "hydration") return true;
      const op = this.model.ops.get(id);
      if (op) return op.copy === copy.name || copy.delivered.has(id);
      const element = this.model.chars.get(id) ?? this.model.items.get(id);
      if (element && this.model.ops.get(element.op)?.copy === copy.name) return true;
      const bound = this.toYjs.get(id);
      return !!bound && (vector.get(bound.client) ?? 0) > bound.clock;
    };
  }

  private contextOf(copy: Copy): Set<string> {
    const seen = this.seenBy(copy);
    return new Set([...this.model.ops.keys(), ...this.model.chars.keys(), ...this.model.items.keys()].filter(seen));
  }

  private fail(message: string): never {
    throw new CheckFailure(`${message}\nHistory:\n  ${this.history.join("\n  ")}`);
  }

  private created(doc: Y.Doc, client: number, from: number, to: number): ({ kind: "char"; id: Y.ID; value: string; parent: E3Type } | { kind: "item"; id: Y.ID; key: string; value: unknown; parent: E3Type })[] {
    const result: ReturnType<World["created"]> = [];
    for (const struct of doc.store.clients.get(client) ?? []) {
      if (!(struct instanceof Y.Item) || struct.id.clock + struct.length <= from || struct.id.clock >= to) continue;
      const content = struct.content, parent = struct.parent as E3Type;
      if (content instanceof Y.ContentFormat || content instanceof Y.ContentDeleted) continue;
      if (struct.parentSub !== null) {
        const value = content instanceof Y.ContentType ? content.type : (content.getContent()[0] as unknown);
        result.push({ kind: "item", id: struct.id, key: struct.parentSub, value, parent });
      } else if (content instanceof Y.ContentString) {
        for (let index = 0; index < content.str.length; index++) {
          const clock = struct.id.clock + index;
          if (clock >= from && clock < to) result.push({ kind: "char", id: Y.createID(client, clock), value: content.str.charAt(index), parent });
        }
      } else if (content instanceof Y.ContentEmbed) result.push({ kind: "char", id: struct.id, value: JSON.stringify(content.embed), parent });
      else this.fail(`Unexpected content created: ${content.constructor.name}`);
    }
    return result;
  }

  private bindCreations(copy: Copy, from: number, expected: readonly Creation[]): void {
    const doc = copy.replica.doc, made = this.created(doc, copy.client, from, Y.getState(doc.store, copy.client));
    if (made.length !== expected.length) this.fail(`${copy.name} created ${made.length} items; the model expected ${expected.length}`);
    expected.forEach((creation, index) => {
      const found = made[index];
      if (!found || found.kind !== creation.kind || found.parent !== this.typeOf(doc, creation.container)) this.fail(`${copy.name}: creation ${index} does not match ${JSON.stringify(creation)}`);
      if (found.kind === "char" && found.value !== creation.value) this.fail(`${copy.name}: typed ${found.value}, expected ${creation.value}`);
      if (found.kind === "item" && found.key !== creation.key) this.fail(`${copy.name}: wrote ${found.key}, expected ${creation.key}`);
      this.bind(found.id, creation.id);
    });
  }

  private cellView(copy: Copy, beat: string, field: NativeField): { container: string; text: Y.Text; start: number; chars: YChar[] } {
    const cell = copy.replica.cell(beat, field);
    const container = field === "visualText" ? `k:${this.modelOf(itemOf(cell.text).id)}` : `seg:${copy.replica.block(beat).segment}`;
    return { container, text: cell.text, start: cell.start, chars: textChars(cell.text) };
  }

  private mapContainer(type: E3Type | undefined, what: string): string {
    if (!type) this.fail(`Missing ${what}`);
    return `k:${this.modelOf(itemOf(type).id)}`;
  }

  private part(copy: Copy, op: string, part: Part, seen: Seen): { expected: Creation[]; run: () => void } {
    const replica = copy.replica, model = this.model;
    switch (part.do) {
      case "insert": case "delete": case "format": {
        const view = this.cellView(copy, part.beat, part.field);
        if (part.do === "insert") {
          const at = view.start + part.at, left = view.chars[at - 1], right = view.chars[at];
          const expected = model.insert(op, view.container, [...part.text], left ? this.modelOf(left.id) : null, right ? this.modelOf(right.id) : null, part.marks ?? [], seen);
          return { expected, run: () => { replica.splice(part.beat, part.field, part.at, part.at, [{ text: part.text, marks: marksOf(part.marks ?? []) }]); } };
        }
        const ids = view.chars.slice(view.start + part.from, view.start + part.to).map(char => this.modelOf(char.id));
        if (part.do === "delete") {
          model.remove(op, ids, seen);
          return { expected: [], run: () => { replica.splice(part.beat, part.field, part.from, part.to, []); } };
        }
        model.format(op, view.container, ids, part.mark, part.on, seen);
        return { expected: [], run: () => { replica.format(part.beat, part.field, part.from, part.to, { [part.mark]: part.on ? true : null }); } };
      }
      case "split": {
        const view = this.cellView(copy, part.beat, "audioText"), at = view.start + part.at, left = view.chars[at - 1], right = view.chars[at];
        const expected = model.insert(op, view.container, [JSON.stringify({ b: part.created })], left ? this.modelOf(left.id) : null, right ? this.modelOf(right.id) : null, [], seen, true);
        expected.push(model.createContainer(op, "root:beats", part.created, "map", seen));
        expected.push(model.createContainer(op, "root:visuals", part.created, "text", seen));
        return { expected, run: () => { replica.split(part.beat, part.at, part.created); } };
      }
      case "set": case "clear": {
        const container = this.mapContainer(replica.beats.get(part.beat), `beat ${part.beat}`);
        if (part.do === "clear") {
          model.clear(op, container, part.key, seen);
          return { expected: [], run: () => { replica.transact(() => { replica.beat(part.beat).delete(part.key); }); } };
        }
        const expected = [model.set(op, container, part.key, () => ({ json: JSON.stringify(part.value) }), seen)];
        return { expected, run: () => { replica.setField(part.beat, part.key, part.value); } };
      }
      case "record": {
        const holder = model.createContainer(op, `root:${part.root}`, part.id, "map", seen), expected = [holder];
        for (const [field, value] of Object.entries(part.fields)) expected.push(model.set(op, `k:${holder.id}`, field, () => ({ json: JSON.stringify(value) }), seen));
        return { expected, run: () => { copy.layer.createRecord(part.root, part.id, part.fields); } };
      }
      case "field": {
        const container = this.mapContainer(replica.doc.getMap<Y.Map<unknown>>(part.root).get(part.id), `record ${part.root}/${part.id}`);
        const expected = [model.set(op, container, part.key, () => ({ json: JSON.stringify(part.value) }), seen)];
        return { expected, run: () => { copy.layer.setRecordField(part.root, part.id, part.key, part.value); } };
      }
    }
  }

  private open(copy: Copy, op: string): { from: number; notices: number; context: Set<string> } {
    const context = this.contextOf(copy);
    copy.current = op;
    copy.watched = { changed: 0, added: [], updated: 0 };
    return { from: Y.getState(copy.replica.doc.store, copy.client), notices: copy.layer.notices, context };
  }

  private close(copy: Copy, op: string, opened: { from: number; context: Set<string> }): Watched {
    const watched = copy.watched as Watched;
    copy.current = null; copy.watched = null;
    this.records.set(op, { copy: copy.name, client: copy.client, start: opened.from, end: Y.getState(copy.replica.doc.store, copy.client), context: opened.context });
    if (watched.changed > 1) this.fail(`${copy.name}: one command or press made ${watched.changed} change notifications`);
    return watched;
  }

  private settleEntry(copy: Copy, watched: Watched, label: string): void {
    const end = this.model.end(watched.changed > 0);
    if (end.predicted !== (watched.changed > 0)) {
      if (!end.involved) this.fail(`${copy.name} ${label}: changed ${watched.changed > 0}, the model expected ${end.predicted}`);
      this.stats.uncertainCommands++;
    }
    if (watched.changed > 0 && end.merged && (watched.added.length || watched.updated !== 1)) {
      this.fail(`${copy.name} ${label}: the model joined the open group; the library added ${watched.added.length} and updated ${watched.updated}`);
    }
    if (watched.changed > 0 && !end.merged) {
      const added = watched.added.filter(entry => entry.type === "undo");
      if (added.length !== 1) this.fail(`${copy.name} ${label}: the model added an entry; the library added ${added.length} and updated ${watched.updated}`);
      this.keys.set((added[0] as { item: UndoStackItem }).item, end.key as number);
    }
    this.checkStacks(copy, label);
  }

  type(name: string, beat: string, field: NativeField, at: number, text: string, marks: readonly string[] = []): void {
    this.steps.push({ act: "type", by: name, at: this.clock, beat, field, offset: at, text, marks });
    this.typing(name, `type ${JSON.stringify(text)} at ${beat}.${field}:${at}${marks.length ? ` [${marks.join(",")}]` : ""}`,
      { cell: `${field}:${beat}`, typed: text, replacing: false, now: this.clock }, [{ do: "insert", beat, field, at, text, marks }],
      layer => { layer.type(beat, field, at, text, marksOf(marks)); });
  }

  erase(name: string, beat: string, field: NativeField, from: number, to: number): void {
    this.steps.push({ act: "erase", by: name, at: this.clock, beat, field, from, to });
    this.typing(name, `erase ${beat}.${field}:${from}-${to}`, { cell: `${field}:${beat}`, typed: "", replacing: false, now: this.clock },
      [{ do: "delete", beat, field, from, to }], layer => { layer.erase(beat, field, from, to); });
  }

  replace(name: string, beat: string, field: NativeField, from: number, to: number, text: string): void {
    this.steps.push({ act: "replace", by: name, at: this.clock, beat, field, from, to, text });
    this.typing(name, `replace ${beat}.${field}:${from}-${to} with ${JSON.stringify(text)}`, { cell: `${field}:${beat}`, typed: text, replacing: true, now: this.clock },
      [{ do: "insert", beat, field, at: from, text }, { do: "delete", beat, field, from, to }],
      layer => { layer.replace(beat, field, from, to, text); });
  }

  private typing(name: string, label: string, spec: TypingSpec, parts: readonly Part[], run: (layer: UndoLayer) => void): void {
    const copy = this.copy(name), seen = this.seenBy(copy);
    this.history.push(`${name} ${label} @${this.clock}`);
    const op = this.model.begin(name, spec), opened = this.open(copy, op);
    const planned = parts.map(part => this.part(copy, op, part, seen));
    const { watched } = this.guarded(copy, op, opened, () => { run(copy.layer); });
    this.bindCreations(copy, opened.from, planned.flatMap(part => part.expected));
    this.settleEntry(copy, watched, label);
  }

  private guarded<T>(copy: Copy, op: string, opened: { from: number; context: Set<string> }, run: () => T): { value: T; watched: Watched } {
    let value: T;
    try { value = run(); } catch (error) { this.close(copy, op, opened); throw error; }
    return { value, watched: this.close(copy, op, opened) };
  }

  command(name: string, parts: readonly Part[], caret: UndoCaret | null = null): void {
    const copy = this.copy(name), seen = this.seenBy(copy);
    this.steps.push({ act: "command", by: name, at: this.clock, parts });
    this.history.push(`${name} command ${JSON.stringify(parts)} @${this.clock}`);
    const op = this.model.begin(name, null), opened = this.open(copy, op);
    const { watched } = this.guarded(copy, op, opened, () => {
      copy.layer.command(() => {
        for (const part of parts) {
          const from = Y.getState(copy.replica.doc.store, copy.client), planned = this.part(copy, op, part, seen);
          planned.run();
          this.bindCreations(copy, from, planned.expected);
        }
      }, caret);
    });
    this.settleEntry(copy, watched, "command");
  }

  removal(name: string, by: string): Record<string, unknown> {
    const vector = Y.decodeStateVector(Y.encodeStateVector(this.copy(name).replica.doc));
    return { by, at: this.clock, seen: Object.fromEntries([...vector].map(([client, clock]) => [String(client), clock])) };
  }

  undo(name: string, caret: UndoCaret | null = null): UndoStackItem | null { return this.press(name, true, caret); }

  redo(name: string, caret: UndoCaret | null = null): UndoStackItem | null { return this.press(name, false, caret); }

  private press(name: string, back: boolean, caret: UndoCaret | null): UndoStackItem | null {
    const copy = this.copy(name), seen = this.seenBy(copy), label = back ? "undo" : "redo";
    this.steps.push({ act: label, by: name, at: this.clock });
    this.history.push(`${name} ${label} @${this.clock}`);
    const op = this.model.op(name), opened = this.open(copy, op);
    const { value: applied, watched } = this.guarded(copy, op, opened, () => back ? copy.layer.undo(caret) : copy.layer.redo(caret));
    this.stats.presses++;
    const appliedKey = applied ? this.keys.get(applied) ?? -1 : null;
    const result = back ? this.model.undo(name, op, seen, entry => entry === appliedKey) : this.model.redo(name, op, seen, entry => entry === appliedKey);
    if (result.uncertain) this.stats.uncertainPresses++;
    if (result.applied !== null) this.stats[back ? "undone" : "redone"]++;
    if (result.formatSkips) { this.stats.formatSkips++; this.stats.formatSkipExample ??= [...this.history]; }
    if (result.applied !== appliedKey) this.fail(`${name} ${label}: the library applied entry ${String(appliedKey)}; the model expected ${String(result.applied)}`);
    if (watched.changed !== (applied ? 1 : 0)) this.fail(`${name} ${label}: ${watched.changed} change notifications for one press`);
    const added = watched.added.filter(entry => entry.type === (back ? "redo" : "undo"));
    if (added.length !== (applied ? 1 : 0) || watched.updated) this.fail(`${name} ${label}: ${added.length} entries added to the other stack`);
    if (added[0]) this.keys.set(added[0].item, result.created as number);
    const doc = copy.replica.doc, end = Y.getState(doc.store, copy.client);
    for (const restoration of result.restored) {
      const original = this.toYjs.get(restoration.from);
      if (!original) this.fail(`Restored ${restoration.from} has no identity`);
      const item = Y.getItem(doc.store, original) as Y.Item;
      if (!item.redone) this.fail(`${name} ${label}: the model restored ${restoration.kind} ${restoration.from}; the library did not`);
      const copied = Y.createID(item.redone.client, item.redone.clock + original.clock - item.id.clock);
      if (copied.client !== copy.client || copied.clock < opened.from || copied.clock >= end) this.fail(`${name} ${label}: ${restoration.from} was restored earlier, not by this press`);
      this.bind(copied, restoration.to);
    }
    for (const made of this.created(doc, copy.client, opened.from, end)) {
      if (!this.toModel.has(key(made.id))) this.fail(`${name} ${label}: the library restored ${made.kind} ${made.kind === "char" ? made.value : made.key} that the model did not (model: ${JSON.stringify(result.restored)})`);
    }
    this.checkStacks(copy, label);
    return applied;
  }

  checkStacks(copy: Copy, label: string): void {
    const expected = this.model.stacks(copy.name), manager = copy.layer.manager;
    if (manager.undoStack.length !== expected.undo || manager.redoStack.length !== expected.redo) {
      this.fail(`${copy.name} after ${label}: stacks ${manager.undoStack.length}/${manager.redoStack.length}, the model expected ${expected.undo}/${expected.redo}`);
    }
  }

  pending(from: Copy, to: Copy): number { return from.log.length - (this.read.get(`${from.name}>${to.name}`) ?? 0); }

  deliver(fromName: string, toName: string, mode: Delivery = "forward", count = Number.POSITIVE_INFINITY): void {
    const from = this.copy(fromName), to = this.copy(toName), name = `${from.name}>${to.name}`, start = this.read.get(name) ?? 0;
    const updates = from.log.slice(start, start + Math.min(count, from.log.length - start));
    if (!updates.length) return;
    this.read.set(name, start + updates.length);
    if (!this.settling) this.steps.push({ act: "deliver", from: fromName, to: toName, mode, count: updates.length });
    this.history.push(`deliver ${name} ${updates.length} ${mode}`);
    const sequence = mode === "reverse" ? [...updates].reverse() : mode === "twice" ? [...updates, ...updates] : updates;
    for (const logged of sequence) {
      Y.applyUpdate(to.replica.doc, logged.update, "remote");
      to.delivered.add(logged.op);
    }
  }

  settle(mode: Delivery = "forward"): void {
    this.steps.push({ act: "settle", mode });
    this.settling = true;
    try {
      for (let round = 0; round < 12; round++) {
        let moved = false;
        for (const from of this.copies) for (const to of this.copies) {
          if (from === to || !this.pending(from, to)) continue;
          this.deliver(from.name, to.name, mode); moved = true;
        }
        if (!moved) return;
      }
    } finally { this.settling = false; }
    this.fail("The copies never settled");
  }

  joiner(): NativeReplica {
    const replica = new NativeReplica(800 + ++this.late, 0, "act");
    Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate((this.copies[0] as Copy).replica.doc), "remote");
    replica.undo.destroy();
    return replica;
  }

  snapshot(replica: NativeReplica): string {
    return JSON.stringify(sorted({ rows: rowsOf(replica), recovery: replica.recovery(), records: readRecords(replica) }));
  }

  // why: run when every update has arrived everywhere: all copies and a copy loaded from stored state read the same,
  // and each holds exactly what the model holds
  check(label = "check"): Loss[] {
    this.stats.checks++;
    for (const from of this.copies) for (const to of this.copies) if (from !== to && this.pending(from, to)) this.fail(`${label}: not settled`);
    const late = this.joiner(), first = this.snapshot((this.copies[0] as Copy).replica);
    for (const replica of [...this.copies.map(copy => copy.replica), late]) {
      const other = this.snapshot(replica);
      if (other !== first) this.fail(`${label}: copies differ\n  ${first}\n  ${other}`);
    }
    for (const copy of this.copies) { this.compare(copy.replica.doc, this.seenBy(copy), `${label} on ${copy.name}`); this.checkStacks(copy, label); }
    this.compare(late.doc, () => true, `${label} on a late joiner`);
    late.destroy();
    return this.losses();
  }

  private compare(doc: Y.Doc, seen: Seen, label: string): void {
    const model = this.model;
    for (const container of model.containers.values()) {
      const holder = container.holder ? model.items.get(container.holder) : undefined;
      if (holder && !seen(holder.op) || model.containerDeleted(container.id, seen)) continue;
      const type = this.typeOf(doc, container.id);
      if (container.type === "text") {
        const actual = textChars(type as Y.Text), expected = [...model.chars.values()].filter(char => char.container === container.id && model.visibleChar(char, seen));
        const known = new Set(actual.map(char => { const id = this.toModel.get(key(char.id)); if (!id) this.fail(`${label}: unexpected character ${char.value} in ${container.id}`); return id; }));
        for (const char of expected) if (!known.has(char.id)) this.fail(`${label}: character ${JSON.stringify(char.value)} (${char.id}, typed by ${char.author}) is missing from ${container.id}`);
        if (known.size !== expected.length) this.fail(`${label}: ${container.id} holds ${known.size} characters, the model ${expected.length}`);
        for (const char of actual) this.compareMarks(model.chars.get(this.modelOf(char.id)) as ModelChar, char.names, seen, label);
        continue;
      }
      const map = type as Y.Map<unknown>, names = new Set([...model.keys(container.id), ...map.keys()]);
      for (const name of names) {
        const item = model.current(container.id, name, seen), has = map.has(name);
        if (!item) { if (has) this.fail(`${label}: ${container.id}.${name} holds ${JSON.stringify(map.get(name))}; the model has no value`); continue; }
        if (!has) this.fail(`${label}: ${container.id}.${name} (${this.describe(item)}) is missing`);
        const value = map.get(name);
        const actual = value instanceof Y.AbstractType ? `k:${this.modelOf(itemOf(value as E3Type).id)}` : JSON.stringify(value);
        const wanted = "container" in item.value ? item.value.container : item.value.json;
        if (actual !== wanted) this.fail(`${label}: ${container.id}.${name} is ${actual}; the model has ${wanted} (${this.describe(item)})`);
      }
    }
  }

  private describe(item: ModelItem): string { return `${item.id} written by ${item.author}`; }

  private compareMarks(char: ModelChar, names: ReadonlySet<string>, seen: Seen, label: string): void {
    if (char.uncertain.has(ANY_KIND)) return;
    const expected = this.model.kinds(char, seen);
    for (const kind of new Set([...expected, ...names])) {
      if (char.uncertain.has(kind) || expected.has(kind) === names.has(kind)) continue;
      const mismatch: MarkMismatch = { at: label, char: `${char.id} ${JSON.stringify(char.value)} by ${char.author}`, kind, expected: expected.has(kind) };
      if (this.strictMarks) this.fail(`${label}: ${kind} on ${mismatch.char} is ${names.has(kind)}; the model expected ${mismatch.expected}`);
      this.stats.markMismatches.push(mismatch);
      char.uncertain.add(kind);
    }
  }

  // why: content no one deleted that is gone because an undo deleted the record or cell holding it
  losses(): Loss[] {
    const model = this.model, all: Seen = () => true, result: Loss[] = [];
    const cause = (container: string): { by: string; op: string } | null => {
      const holder = model.containers.get(container)?.holder;
      const item = holder ? model.items.get(holder) : undefined;
      const op = item?.deleters[0];
      return item && op ? { by: model.ops.get(op)?.copy ?? "?", op } : null;
    };
    for (const char of model.chars.values()) {
      if (char.deleters.length || !model.containerDeleted(char.container, all)) continue;
      const found = cause(char.container);
      if (!found || found.by === char.author) continue;
      result.push({ what: `character ${JSON.stringify(char.value)} in ${char.container}`, author: char.author, by: found.by, unseen: !this.records.get(found.op)?.context.has(char.id) });
    }
    for (const item of model.items.values()) {
      if (item.deleters.length || !model.containerDeleted(item.container, all) || model.lastWrite(item.container, item.key) !== item.id) continue;
      const found = cause(item.container);
      if (!found || found.by === item.author) continue;
      result.push({ what: `field ${item.key} in ${item.container}`, author: item.author, by: found.by, unseen: !this.records.get(found.op)?.context.has(item.id) });
    }
    return result;
  }
}
