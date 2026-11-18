import * as Y from "yjs";
import type { Marks } from "../../../../src/core/text/runs.ts";
import { NativeReplica, nativeCopy, nativeMarkName, usesActionKey } from "../native/variant.ts";
import type { NativeDeltaItem, NativeField, NativeScheme } from "../native/variant.ts";
import { RECORD_ROOTS, UndoLayer, readRecords, readStatus } from "./layer.ts";
import type { CreationRule, RecordRoot, UndoCaret, UndoStackItem } from "./layer.ts";
import { ANY_KIND, UndoModel, changesMark, changesPlainMarkers, markCommand } from "./model.ts";
import type { CommandChar, Creation, ModelChar, ModelItem, PressResult, Seen, TypingSpec } from "./model.ts";

export type Delivery = "forward" | "reverse" | "twice";
export interface WorldRow { id: string; audioText: string; visualText?: string; status?: string }
export interface WorldOptions {
  names?: readonly string[]; clients?: readonly number[]; scheme?: NativeScheme; creations?: CreationRule;
  onExtraPressUpdates?: (count: number) => void; auditTags?: boolean
}
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
export type WriteCommand = "type" | "erase" | "format" | "split" | "join" | "field" | "undo" | "redo";
export type ProbedWrite = WriteCommand | "tag" | "untag";
export interface CommandDifference {
  readonly step: number; readonly perAction: boolean; readonly predicted: boolean; readonly updated: boolean;
  readonly formats: readonly FormatProbe[]; readonly markerOnly: boolean
}
interface FormatProbe {
  readonly mark: string; readonly on: boolean; readonly displayed: string; readonly modeled: string; readonly requested: string; readonly range: string;
  readonly cell: string; readonly restored: string; readonly pending: boolean; readonly markerOnly: boolean
}
export interface TagDifference {
  readonly step: number; readonly at: string; readonly copy: string; readonly container: string;
  readonly id: string; readonly original: string; readonly value: string; readonly kind: string; readonly requests: number[];
  readonly cell: string
}
export interface WorldStats {
  presses: number; uncertainPresses: number; uncertainCommands: number; markMismatches: MarkMismatch[]; checks: number;
  undoPresses: number; uncertainUndos: number; uncertainRedos: number; writes: Set<WriteCommand>;
  formatSkips: number; formatSkipExample: string[] | null; undone: number; redone: number;
  formatRemains: number; inheritedTagLost: number; differentStep: number; skippedToOlder: number;
  pressUpdates: Record<number, number>; commandDifferences: CommandDifference[];
  used: Set<ProbedWrite>; effective: Set<ProbedWrite>; tagDifferences: TagDifference[]
}

interface Logged { readonly update: Uint8Array; readonly op: string }
interface OpRecord { readonly copy: string; readonly client: number; readonly start: number; readonly end: number; readonly context: ReadonlySet<string> }
interface Watched { updates: number; added: { item: UndoStackItem; type: string }[]; updated: number }
interface YChar { readonly id: Y.ID; readonly value: string; readonly names: ReadonlySet<string> }
interface TextEdit {
  readonly container: string;
  readonly before: CommandChar[];
  readonly apply: (chars: CommandChar[]) => CommandChar[];
}
interface PlannedPart { expected: Creation[]; run: () => void; text?: TextEdit; check?: () => void }
interface MarkBeforeUndo { char: ModelChar; kind: string; sources: string[] }
interface UndoMarkProbe { remains: MarkBeforeUndo[]; lost: MarkBeforeUndo[] }

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

function liveMarkers(text: Y.Text): { index: number; key: string; on: boolean; id: string }[] {
  const markers: ReturnType<typeof liveMarkers> = [];
  let index = 0;
  for (let item = text._start; item; item = item.right) {
    if (item.deleted) continue;
    if (item.content instanceof Y.ContentFormat) markers.push({ index, key: item.content.key, on: item.content.value === true, id: key(item.id) });
    else if (item.countable) index += item.length;
  }
  return markers;
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
  readonly stats: WorldStats = {
    presses: 0, uncertainPresses: 0, uncertainCommands: 0, markMismatches: [], checks: 0, formatSkips: 0, formatSkipExample: null,
    undone: 0, redone: 0, undoPresses: 0, uncertainUndos: 0, uncertainRedos: 0, writes: new Set(), formatRemains: 0, inheritedTagLost: 0,
    differentStep: 0, skippedToOlder: 0, pressUpdates: {}, commandDifferences: [], used: new Set(), effective: new Set(), tagDifferences: []
  };
  clock = 1_000_000;
  strictMarks = false;
  private readonly toModel = new Map<string, string>();
  private readonly toYjs = new Map<string, Y.ID>();
  private readonly records = new Map<string, OpRecord>();
  private readonly keys = new Map<UndoStackItem, number>();
  private readonly read = new Map<string, number>();
  private readonly undoMarks: UndoMarkProbe[] = [];
  private readonly formats: FormatProbe[] = [];
  private readonly operationSteps = new Map<string, number>();
  private readonly seedBeats: readonly string[];
  private readonly scheme: NativeScheme;
  private readonly onExtraPressUpdates: WorldOptions["onExtraPressUpdates"];
  private readonly auditTags: boolean;
  private late = 0;

  constructor(rows: readonly WorldRow[], options: WorldOptions = {}) {
    const names = options.names ?? ["A", "B", "C"], clients = options.clients ?? names.map((_, index) => index + 1);
    this.scheme = options.scheme ?? "act";
    this.model.predictKindKeys = this.scheme !== "act";
    this.onExtraPressUpdates = options.onExtraPressUpdates;
    this.auditTags = options.auditTags ?? false;
    this.seedBeats = rows.map(row => row.id);
    const seed = new NativeReplica(900, 0, this.scheme);
    const inputs = rows.map(row => ({ visualText: "", status: "todo", ...row }));
    seed.hydrate({ rows: inputs });
    this.bindSeed(seed, inputs);
    const creations = options.creations ?? "keep-always";
    this.model.keepCreated = creations;
    this.copies = names.map((name, index) => {
      const client = clients[index] as number, replica = nativeCopy(seed, client);
      const layer = new UndoLayer(replica, { now: () => this.clock, creations });
      const copy = new Copy(name, client, replica, layer);
      this.model.addCopy(name, client);
      replica.doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (copy.watched) copy.watched.updates++;
        if (origin !== "remote") copy.log.push({ update, op: copy.current ?? "cleanup" });
      });
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

  private bindSeed(seed: NativeReplica, rows: readonly Required<WorldRow>[]): void {
    for (const name of ["beats", "visuals", ...RECORD_ROOTS]) this.model.root(`root:${name}`, "map");
    for (const row of rows) {
      const beat = row.id, segment = `seg-b-${beat}`, record = seed.beat(beat);
      this.model.root(`seg:${segment}`, "text");
      this.bindText(seed.cell(beat, "audioText").text, `seg:${segment}`, row.audioText);
      const holder = itemOf(record), id = `y${key(holder.id)}`;
      this.bind(holder.id, id);
      this.model.hydrateItem(id, "root:beats", beat, "", holder.id.client, "map");
      const status = record._map.get("status") as Y.Item, statusId = `y${key(status.id)}`;
      if (record.get("status") !== row.status) this.fail(`Hydration differs for ${beat}.status`);
      this.bind(status.id, statusId);
      this.model.hydrateItem(statusId, `k:${id}`, "status", JSON.stringify(row.status), status.id.client, null);
      const text = seed.cell(beat, "visualText").text, visual = itemOf(text), visualId = `y${key(visual.id)}`;
      this.bind(visual.id, visualId);
      this.model.hydrateItem(visualId, "root:visuals", beat, "", visual.id.client, "text");
      this.bindText(text, `k:${visualId}`, row.visualText);
    }
  }

  private bindText(text: Y.Text, container: string, input: string): void {
    const chars = textChars(text);
    if (chars.map(char => char.value).join("") !== input || chars.some(char => char.names.size)) this.fail(`Hydration differs for ${container}`);
    let left: string | null = null;
    for (const [index, char] of chars.entries()) {
      const id = `y${key(char.id)}`;
      this.bind(char.id, id);
      this.model.hydrateChar(id, container, input.charAt(index), left);
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
      if (found.kind === "item") {
        const childType = this.model.containers.get(`k:${creation.id}`)?.type;
        const matches = childType === "map" ? found.value instanceof Y.Map : childType === "text" ? found.value instanceof Y.Text
          : JSON.stringify(found.value) === creation.value;
        if (!matches) this.fail(`${copy.name}: wrote the wrong value for ${found.key}; the model expected ${creation.value}`);
      }
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

  private edit(view: { container: string; chars: YChar[] }, apply: TextEdit["apply"]): TextEdit {
    return { container: view.container, before: this.commandChars(view.chars), apply };
  }

  private commandChars(chars: YChar[]): CommandChar[] {
    return chars.map(char => ({ ...char, id: this.modelOf(char.id) }));
  }

  private write(kind: ProbedWrite, effective = true): void {
    this.stats.used.add(kind);
    if (effective) this.stats.effective.add(kind);
  }

  private checkText(copy: Copy, edits: readonly TextEdit[]): void {
    const expected = new Map<string, CommandChar[]>();
    for (const edit of edits) expected.set(edit.container, edit.apply(expected.get(edit.container) ?? edit.before));
    for (const [container, chars] of expected) {
      const actual = this.commandChars(textChars(this.typeOf(copy.replica.doc, container) as Y.Text));
      if (actual.length !== chars.length || actual.some((char, index) => char.id !== chars[index]?.id || char.value !== chars[index]?.value)) {
        this.fail(`${copy.name} after command: ${container} text ${JSON.stringify(actual.map(char => char.value).join(""))}; the model expected ${JSON.stringify(chars.map(char => char.value).join(""))}`);
      }
      for (const [index, char] of chars.entries()) {
        const names = (actual[index] as CommandChar).names;
        if (names.size !== char.names.size || [...char.names].some(name => !names.has(name))) {
          this.fail(`${copy.name} after command: marks on ${JSON.stringify(char.value)} (${char.id}) are [${[...names]}]; the model expected [${[...char.names]}]`);
        }
      }
    }
  }

  private part(copy: Copy, op: string, part: Part, seen: Seen): PlannedPart {
    const replica = copy.replica, model = this.model;
    switch (part.do) {
      case "insert": case "delete": case "format": {
        const view = this.cellView(copy, part.beat, part.field);
        if (part.do === "insert") {
          const at = view.start + part.at, left = view.chars[at - 1], right = view.chars[at];
          const expected = model.insert(op, view.container, part.text.split(""), left ? this.modelOf(left.id) : null, right ? this.modelOf(right.id) : null, part.marks ?? [], seen);
          const inserted = expected.map(char => ({ id: char.id, value: char.value, names: new Set(part.marks) }));
          return { expected, text: this.edit(view, chars => [...chars.slice(0, at), ...inserted, ...chars.slice(at)]),
            run: () => { replica.splice(part.beat, part.field, part.at, part.at, [{ text: part.text, marks: marksOf(part.marks ?? []) }]); } };
        }
        const ids = view.chars.slice(view.start + part.from, view.start + part.to).map(char => this.modelOf(char.id));
        if (part.do === "delete") {
          model.remove(op, ids, seen);
          return { expected: [], text: this.edit(view, chars => chars.filter(char => !ids.includes(char.id))),
            run: () => { replica.splice(part.beat, part.field, part.from, part.to, []); } };
        }
        const targets = new Set(ids);
        const text = this.edit(view, chars => markCommand(chars, targets, part.mark, part.on));
        const selected = text.before.filter(char => targets.has(char.id));
        const actionKey = usesActionKey(this.scheme, part.mark);
        const visibleOrFresh = changesMark(selected, part.mark, part.on, actionKey);
        const from = view.start + part.from, to = view.start + part.to;
        const beforeMarkers = !actionKey && !visibleOrFresh && to > from ? liveMarkers(view.text) : [];
        const markerOnly = beforeMarkers.length > 0 &&
          changesPlainMarkers(part.mark, part.on, text.before[from - 1]?.names.has(part.mark) ?? false, from, to, beforeMarkers);
        const expectedChange = visibleOrFresh || markerOnly;
        const modelChars = ids.map(id => model.chars.get(id) as ModelChar);
        this.formats.push({
          mark: part.mark, on: part.on, cell: `${part.beat}.${part.field}`,
          range: selected.map(char => char.value).join(""),
          displayed: selected.map(char => Number(char.names.has(part.mark))).join(""),
          modeled: modelChars.map(char => Number(model.kinds(char, seen).has(part.mark))).join(""),
          requested: part.mark.startsWith("t:") ? modelChars.map(char => Number(model.requestedTags(char, seen).has(part.mark))).join("") : "",
          restored: modelChars.map(char => Number(char.restoredFrom !== null)).join(""),
          pending: !!(replica.doc.store.pendingStructs || replica.doc.store.pendingDs),
          markerOnly
        });
        model.expectFormat(expectedChange);
        model.format(op, view.container, ids, part.mark, part.on, seen);
        const freshKey = actionKey && part.on && targets.size > 0;
        const clock = Y.getState(replica.doc.store, copy.client);
        if (visibleOrFresh) this.stats.writes.add("format");
        this.write(part.mark.startsWith("t:") ? (part.on ? "tag" : "untag") : "format", expectedChange);
        return {
          expected: [], text, run: () => { replica.format(part.beat, part.field, part.from, part.to, { [part.mark]: part.on ? true : null }); },
          check: () => {
            if (freshKey && Y.getState(replica.doc.store, copy.client) === clock) this.fail(`${copy.name}: formatting on did not write its fresh mark key`);
            if (markerOnly) {
              const idsOf = (markers: ReturnType<typeof liveMarkers>): string => markers.filter(marker => marker.key === part.mark).map(marker => marker.id).join(",");
              if (idsOf(beforeMarkers) === idsOf(liveMarkers(view.text))) this.fail(`${copy.name}: formatting did not rewrite the expected markers for ${part.mark}`);
            }
          }
        };
      }
      case "split": {
        const view = this.cellView(copy, part.beat, "audioText"), at = view.start + part.at, left = view.chars[at - 1], right = view.chars[at];
        const expected = model.insert(op, view.container, [JSON.stringify({ b: part.created })], left ? this.modelOf(left.id) : null, right ? this.modelOf(right.id) : null, [], seen, true);
        expected.push(model.createContainer(op, "root:beats", part.created, "map", seen));
        expected.push(model.createContainer(op, "root:visuals", part.created, "text", seen));
        const boundary = expected[0] as Creation, inserted = { id: boundary.id, value: boundary.value, names: left?.names ?? new Set<string>() };
        this.stats.writes.add("split");
        this.write("split");
        return { expected, text: this.edit(view, chars => [...chars.slice(0, at), inserted, ...chars.slice(at)]),
          run: () => { replica.split(part.beat, part.at, part.created); } };
      }
      case "set": case "clear": {
        const container = this.mapContainer(replica.beats.get(part.beat), `beat ${part.beat}`);
        if (part.do === "clear") {
          const changed = model.clear(op, container, part.key, seen);
          if (changed && part.key === "joined") this.stats.writes.add("join");
          if (part.key === "joined") this.write("join", changed);
          return {
            expected: [],
            run: () => {
              if (part.key === "joined") replica.unjoin(part.beat);
              else replica.transact(() => { replica.beat(part.beat).delete(part.key); });
            },
            check: () => { if (replica.beat(part.beat).has(part.key)) this.fail(`${copy.name}: ${part.beat}.${part.key} was not cleared`); }
          };
        }
        if (part.key === "joined") { this.stats.writes.add("join"); this.write("join"); }
        const expected = [model.set(op, container, part.key, () => ({ json: JSON.stringify(part.value) }), seen)];
        return { expected, run: () => { replica.setField(part.beat, part.key, part.value); } };
      }
      case "record": {
        const holder = model.createContainer(op, `root:${part.root}`, part.id, "map", seen), expected = [holder];
        for (const [field, value] of Object.entries(part.fields)) expected.push(model.set(op, `k:${holder.id}`, field, () => ({ json: JSON.stringify(value) }), seen));
        return { expected, run: () => { copy.layer.createRecord(part.root, part.id, part.fields); } };
      }
      case "field": {
        this.stats.writes.add("field");
        this.write("field");
        const container = this.mapContainer(replica.doc.getMap<Y.Map<unknown>>(part.root).get(part.id), `record ${part.root}/${part.id}`);
        const expected = [model.set(op, container, part.key, () => ({ json: JSON.stringify(part.value) }), seen)];
        return { expected, run: () => { copy.layer.setRecordField(part.root, part.id, part.key, part.value); } };
      }
    }
  }

  private open(copy: Copy, op: string): { from: number; updates: number; context: Set<string> } {
    const context = this.contextOf(copy);
    copy.current = op;
    this.operationSteps.set(op, this.steps.length);
    copy.watched = { updates: 0, added: [], updated: 0 };
    return { from: Y.getState(copy.replica.doc.store, copy.client), updates: copy.layer.updates, context };
  }

  private close(copy: Copy, op: string, opened: ReturnType<World["open"]>): Watched {
    const watched = copy.watched as Watched;
    copy.current = null; copy.watched = null;
    this.records.set(op, { copy: copy.name, client: copy.client, start: opened.from, end: Y.getState(copy.replica.doc.store, copy.client), context: opened.context });
    if (copy.layer.updates - opened.updates !== watched.updates) this.fail(`${copy.name}: layer's update count differs from Yjs update events`);
    return watched;
  }

  private settleEntry(copy: Copy, watched: Watched, label: string): void {
    if (watched.updates > 1) this.fail(`${copy.name}: one command emitted ${watched.updates} Yjs update events`);
    const end = this.model.end(watched.updates > 0);
    const updated = watched.updates > 0;
    const markerOnly = this.formats.some(format => format.markerOnly);
    if (end.perAction !== updated || end.predicted !== updated || markerOnly) {
      if (!end.involved) this.fail(`${copy.name} ${label}: changed ${watched.updates > 0}, the model expected ${end.predicted}`);
      if (end.perAction !== updated) this.stats.uncertainCommands++;
      this.stats.commandDifferences.push({ step: this.steps.length, perAction: end.perAction, predicted: end.predicted, updated, formats: [...this.formats], markerOnly });
    }
    this.formats.length = 0;
    if (watched.updates > 0 && end.merged && (watched.added.length || watched.updated !== 1)) {
      this.fail(`${copy.name} ${label}: the model joined the open group; the library added ${watched.added.length} and updated ${watched.updated}`);
    }
    if (watched.updates > 0 && !end.merged) {
      const added = watched.added.filter(entry => entry.type === "undo");
      if (added.length !== 1) this.fail(`${copy.name} ${label}: the model added an entry; the library added ${added.length} and updated ${watched.updated}`);
      this.keys.set((added[0] as { item: UndoStackItem }).item, end.key as number);
    }
    this.checkStacks(copy, label);
    this.checkLocalTags(copy, label);
  }

  type(name: string, beat: string, field: NativeField, at: number, text: string, marks: readonly string[] = []): void {
    this.write("type", text.length > 0);
    if (text.length) this.stats.writes.add("type");
    this.steps.push({ act: "type", by: name, at: this.clock, beat, field, offset: at, text, marks });
    this.typing(name, `type ${JSON.stringify(text)} at ${beat}.${field}:${at}${marks.length ? ` [${marks.join(",")}]` : ""}`,
      { cell: `${field}:${beat}`, typed: text, replacing: false, now: this.clock }, [{ do: "insert", beat, field, at, text, marks }],
      layer => { layer.type(beat, field, at, text, marksOf(marks)); });
  }

  erase(name: string, beat: string, field: NativeField, from: number, to: number): void {
    this.write("erase", to > from);
    if (to > from) this.stats.writes.add("erase");
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
    this.checkText(copy, planned.flatMap(part => part.text ? [part.text] : []));
    this.settleEntry(copy, watched, label);
  }

  private guarded<T>(copy: Copy, op: string, opened: ReturnType<World["open"]>, run: () => T): { value: T; watched: Watched } {
    let value: T;
    try { value = run(); } catch (error) { this.close(copy, op, opened); throw error; }
    return { value, watched: this.close(copy, op, opened) };
  }

  command(name: string, parts: readonly Part[], caret: UndoCaret | null = null): void {
    const copy = this.copy(name), seen = this.seenBy(copy);
    this.steps.push({ act: "command", by: name, at: this.clock, parts });
    this.history.push(`${name} command ${JSON.stringify(parts)} @${this.clock}`);
    const op = this.model.begin(name, null), opened = this.open(copy, op);
    const edits: TextEdit[] = [];
    const { watched } = this.guarded(copy, op, opened, () => {
      copy.layer.command(() => {
        for (const part of parts) {
          const from = Y.getState(copy.replica.doc.store, copy.client), planned = this.part(copy, op, part, seen);
          planned.run();
          this.bindCreations(copy, from, planned.expected);
          if (planned.text) { this.checkText(copy, [planned.text]); edits.push(planned.text); }
          planned.check?.();
        }
      }, caret);
    });
    this.checkText(copy, edits);
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
    const before = back && copy.layer.manager.undoStack.length ? this.marksBeforeUndo(copy, seen) : [];
    const stacked = (back ? copy.layer.manager.undoStack : copy.layer.manager.redoStack).at(-1);
    const top = stacked ? this.keys.get(stacked) ?? -1 : null;
    if (top !== this.model.top(name, back)) this.fail(`${name} ${label}: top stack entry disagrees with the model`);
    const op = this.model.op(name), opened = this.open(copy, op);
    const { value: applied, watched } = this.guarded(copy, op, opened, () => back ? copy.layer.undo(caret) : copy.layer.redo(caret));
    this.stats.presses++;
    if (back) this.stats.undoPresses++;
    const appliedKey = applied ? this.keys.get(applied) ?? -1 : null;
    if (top !== appliedKey) this.stats.differentStep++;
    if (top !== appliedKey && appliedKey !== null) this.stats.skippedToOlder++;
    this.stats.pressUpdates[watched.updates] = (this.stats.pressUpdates[watched.updates] ?? 0) + 1;
    this.write(label, appliedKey !== null);
    const result = back ? this.model.undo(name, op, seen, entry => entry === appliedKey) : this.model.redo(name, op, seen, entry => entry === appliedKey);
    if (result.uncertain) { this.stats.uncertainPresses++; this.stats[back ? "uncertainUndos" : "uncertainRedos"]++; }
    if (result.applied !== null) { this.stats[back ? "undone" : "redone"]++; this.stats.writes.add(label); }
    if (result.formatSkips) { this.stats.formatSkips++; this.stats.formatSkipExample ??= [...this.history]; }
    if (result.applied !== appliedKey) this.fail(`${name} ${label}: the library applied entry ${String(appliedKey)}; the model expected ${String(result.applied)}`);
    if (applied && watched.updates > 1 && this.onExtraPressUpdates) this.onExtraPressUpdates(watched.updates);
    else if (watched.updates !== (applied ? 1 : 0)) this.fail(`${name} ${label}: ${watched.updates} Yjs update events for one press`);
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
    const after = this.seenBy(copy);
    this.checkPressText(doc, result, after, `${name} after ${label}`);
    if (!doc.store.pendingStructs && !doc.store.pendingDs) this.compare(doc, after, `${name} after ${label}`, false);
    if (before.length && applied) this.observeUndoMarks(copy, before, result, after);
    this.checkLocalTags(copy, label);
    return applied;
  }

  private checkPressText(doc: Y.Doc, result: PressResult, seen: Seen, label: string): void {
    const deleted = new Set(result.deletes);
    const relevant = [...deleted, ...result.restored.map(item => item.to)].flatMap(id => {
      const char = this.model.chars.get(id);
      return char && !this.model.containerDeleted(char.container, seen) ? [char] : [];
    });
    const byContainer = new Map<string, Map<string, YChar>>();
    for (const char of relevant) {
      let chars = byContainer.get(char.container);
      if (!chars) {
        chars = new Map(textChars(this.typeOf(doc, char.container) as Y.Text).map(value => [this.modelOf(value.id), value]));
        byContainer.set(char.container, chars);
      }
      if (deleted.has(char.id) ? chars.has(char.id) : chars.get(char.id)?.value !== char.value) {
        this.fail(`${label}: the model's ${deleted.has(char.id) ? "deletion" : "restoration"} of ${JSON.stringify(char.value)} (${char.id}) is missing`);
      }
    }
  }

  private marksBeforeUndo(copy: Copy, seen: Seen): MarkBeforeUndo[] {
    const before: MarkBeforeUndo[] = [];
    for (const container of this.model.containers.values()) {
      if (container.type !== "text" || container.holder && !seen(container.holder) || this.model.containerDeleted(container.id, seen)) continue;
      for (const actual of textChars(this.typeOf(copy.replica.doc, container.id) as Y.Text)) {
        const char = this.model.chars.get(this.modelOf(actual.id)) as ModelChar;
        for (const kind of actual.names) {
          const sources = this.model.liveSources(char, kind, seen);
          if (sources.length) before.push({ char, kind, sources });
        }
      }
    }
    return before;
  }

  private observeUndoMarks(copy: Copy, before: readonly MarkBeforeUndo[], result: PressResult, seen: Seen): void {
    const deleted = new Set(result.deletes), sourcesUndone = new Set(result.formatSources);
    const deletedTags = new Set(before.flatMap(mark => deleted.has(mark.char.id) && mark.kind.startsWith("t:") ? mark.sources : []));
    const others = deletedTags.size ? this.copies.filter(other => other !== copy).flatMap(other => this.marksBeforeUndo(other, this.seenBy(other))) : [];
    const probe: UndoMarkProbe = {
      remains: before.filter(mark => !deleted.has(mark.char.id) && mark.sources.some(source => sourcesUndone.has(source))),
      lost: [...before, ...others].filter(mark => !deleted.has(mark.char.id) && mark.char.author !== copy.name && mark.sources.some(source => deletedTags.has(source)))
    };
    this.countUndoMarks(copy.replica.doc, probe, seen);
    if (probe.remains.length || probe.lost.length) this.undoMarks.push(probe);
  }

  private countUndoMarks(doc: Y.Doc, probe: UndoMarkProbe, seen: Seen): void {
    const after = new Map<string, ReadonlySet<string>>();
    const marks = [...probe.remains, ...probe.lost];
    for (const container of new Set(marks.map(mark => mark.char.container))) {
      const holder = this.model.containers.get(container)?.holder;
      if (holder && !seen(holder)) continue;
      if (this.model.containerDeleted(container, seen)) continue;
      for (const char of textChars(this.typeOf(doc, container) as Y.Text)) after.set(this.modelOf(char.id), char.names);
    }
    const differs = ({ char, kind }: MarkBeforeUndo, expected: boolean): boolean => {
      const shown = after.get(char.id);
      return !!shown && !char.value.startsWith('{"b":') && shown.has(kind) !== expected && this.model.kinds(char, seen).has(kind) === expected;
    };
    if (probe.remains.some(mark => differs(mark, false))) { this.stats.formatRemains++; probe.remains = []; }
    if (probe.lost.some(mark => differs(mark, true))) { this.stats.inheritedTagLost++; probe.lost = []; }
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
    const replica = new NativeReplica(800 + ++this.late, 0, this.scheme);
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
    if (this.auditTags) {
      const tags = this.checkTags(late.doc, () => true, label, "settled");
      for (const copy of this.copies) {
        if (this.tagView(copy.replica.doc).join("|") !== tags.join("|")) this.fail(`${label}: ${copy.name}'s character tags differ from a late joiner`);
      }
    }
    for (const replica of [...this.copies.map(copy => copy.replica), late]) this.checkRowOrder(replica, label);
    for (const probe of this.undoMarks) this.countUndoMarks(late.doc, probe, () => true);
    this.undoMarks.length = 0;
    late.destroy();
    return this.losses();
  }

  private checkRowOrder(replica: NativeReplica, label: string): void {
    const beats = this.seedBeats.flatMap(beat => {
      const chars = textChars(this.typeOf(replica.doc, `seg:seg-b-${beat}`) as Y.Text).map(char => this.model.chars.get(this.modelOf(char.id)) as ModelChar);
      const positions = new Map(chars.map((char, index) => [char.id, index]));
      const splits = chars.flatMap((char, index) => {
        if (!char.value.startsWith('{"b":')) return [];
        const left = char.left === null ? undefined : positions.get(char.left);
        const right = char.right === null ? undefined : positions.get(char.right);
        if ((left !== undefined && left >= index) || (right !== undefined && right <= index)) this.fail(`${label}: split ${char.value} is outside its model gap`);
        return [(JSON.parse(char.value) as { b: string }).b];
      });
      return [beat, ...splits];
    });
    const expected = this.model.projectedRows(beats, () => true), actual = replica.rows().map(row => row.id);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) this.fail(`${label}: projected row order [${actual}]; the model expected [${expected}]`);
  }

  private compare(doc: Y.Doc, seen: Seen, label: string, marks = true): void {
    const model = this.model;
    for (const container of model.containers.values()) {
      const holder = container.holder ? model.items.get(container.holder) : undefined;
      if (holder && !seen(holder.id) || model.containerDeleted(container.id, seen)) continue;
      const type = this.typeOf(doc, container.id);
      if (container.type === "text") {
        const actual = textChars(type as Y.Text), expected = [...model.chars.values()].filter(char => char.container === container.id && model.visibleChar(char, seen));
        const known = new Set(actual.map(char => { const id = this.toModel.get(key(char.id)); if (!id) this.fail(`${label}: unexpected character ${char.value} in ${container.id}`); return id; }));
        for (const char of expected) if (!known.has(char.id)) this.fail(`${label}: character ${JSON.stringify(char.value)} (${char.id}, typed by ${char.author}) is missing from ${container.id}`);
        if (known.size !== expected.length) this.fail(`${label}: ${container.id} holds ${known.size} characters, the model ${expected.length}`);
        for (const char of actual) {
          const expectedChar = model.chars.get(this.modelOf(char.id)) as ModelChar;
          if (char.value !== expectedChar.value) this.fail(`${label}: ${expectedChar.id} holds ${JSON.stringify(char.value)}; the model expected ${JSON.stringify(expectedChar.value)}`);
          if (marks) this.compareMarks(expectedChar, char.names, seen, label);
        }
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

  private checkLocalTags(copy: Copy, label: string): void {
    const { doc } = copy.replica;
    if (this.auditTags && !doc.store.pendingStructs && !doc.store.pendingDs) this.checkTags(doc, this.seenBy(copy), label, copy.name);
  }

  private *tagText(doc: Y.Doc, seen: Seen): Iterable<{ container: string; text: Y.Text; chars: YChar[] }> {
    for (const container of this.model.containers.values()) {
      if (container.type !== "text" || (container.holder && !seen(container.holder)) || this.model.containerDeleted(container.id, seen)) continue;
      const text = this.typeOf(doc, container.id) as Y.Text;
      yield { container: container.id, text, chars: textChars(text).filter(char => !char.value.startsWith('{"b":')) };
    }
  }

  private tagNames(char: YChar): string[] { return [...char.names].filter(name => name.startsWith("t:")).sort(); }

  private tagView(doc: Y.Doc): string[] {
    return [...this.tagText(doc, () => true)].flatMap(({ chars }) => chars.map(char => JSON.stringify([key(char.id), this.tagNames(char)])));
  }

  private checkTags(doc: Y.Doc, seen: Seen, label: string, copy: string): string[] {
    const tags: string[] = [];
    for (const { container, text, chars } of this.tagText(doc, seen)) {
      for (const char of chars) {
        const id = this.modelOf(char.id), modelChar = this.model.chars.get(id) as ModelChar;
        const expected = this.model.requestedTags(modelChar, seen);
        const shown = this.tagNames(char);
        if (copy === "settled") tags.push(JSON.stringify([key(char.id), shown]));
        for (const kind of new Set([...expected.keys(), ...shown])) {
          const requests = expected.get(kind);
          if (shown.includes(kind) === !!requests) continue;
          this.stats.tagDifferences.push({
            step: this.steps.length, at: label, copy, container, id, original: this.model.originalCharId(modelChar), value: char.value, kind,
            requests: (requests ?? []).map(op => this.operationSteps.get(op) as number), cell: marked(text.toDelta() as NativeDeltaItem[])
          });
        }
      }
    }
    return tags;
  }

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
