import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import * as Y from "yjs";
import { random } from "../format-keys/life.ts";
import { UndoLayer } from "../native-undo/layer.ts";
import type { UndoCaret } from "../native-undo/layer.ts";
import { NativeReplica } from "../native/variant.ts";
import type { NativeBlock } from "../native/variant.ts";
import { buildSizeFixture, loadSizeReplica, readSizeScript, sizeSignature } from "./fixture.ts";
import type { SizeFixture } from "./fixture.ts";

const AUDIO = "audioText";
const BEAT_TEXT = "the camera pans across a quiet harbour in morning light".slice(0, 54);
const ENTRY_TARGETS = [500, 1_500, 4_000, 8_000, 16_000, 24_000, 32_000, 64_000, 96_000, 140_000];
const POSITIONS = ["start", "middle", "end"] as const;
const HISTORIES = ["plain", "formatted"] as const;
const KEYS_PER_COPY = 11;
const TEXT_WRITER = 5;
const OTHER_WRITER = 6;

type Position = (typeof POSITIONS)[number] | "sweep";
type History = (typeof HISTORIES)[number];
type HistoryPlacement = "prefix" | "suffix";
type BaseManifest = Pick<SizeFixture, "expected" | "middle">;
type HotBase = BaseManifest & { state: Uint8Array };
interface KeyParts { insert: number; observer: number; view: number; toDelta: number; caret: number; total: number }

function items(text: Y.Text): Y.Item[] {
  const entries: Y.Item[] = [];
  for (let item = text._start; item; item = item.right) entries.push(item);
  return entries;
}

function composition(text: Y.Text) {
  const entries = items(text);
  return {
    total: entries.length,
    deleted: entries.filter(item => item.deleted).length,
    liveFormats: entries.filter(item => !item.deleted && item.content instanceof Y.ContentFormat).length,
    deletedByTextWriter: entries.filter(item => item.deleted && item.id.client === TEXT_WRITER).length,
    deletedByOtherWriter: entries.filter(item => item.deleted && item.id.client === OTHER_WRITER).length,
  };
}

function singleBeat(): HotBase {
  const replica = new NativeReplica(1);
  const middle = "r0";
  replica.hydrate({ rows: [{ id: middle, audioText: BEAT_TEXT, visualText: "wide shot" }] });
  const base = { middle, state: replica.encode(), expected: sizeSignature(readSizeScript(replica)) };
  replica.destroy();
  return base;
}

function addHistory(base: HotBase, history: History, target: number, placement: HistoryPlacement) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, base.state);
    const cell = doc.getMap<Y.Map<Y.Text>>("segments").get(`seg-b-${base.middle}`)?.get("text");
    assert(cell instanceof Y.Text);
    const before = composition(cell), visible = cell.toString();
    const width = Math.ceil((target - before.total) / 2);
    const at = placement === "prefix" ? 0 : visible.length;
    assert(width > 0);
    doc.clientID = TEXT_WRITER;
    cell.insert(at, "x".repeat(width), {});
    doc.clientID = OTHER_WRITER;
    const delta = Array.from({ length: width }, (_, index) => history === "plain"
      ? [{ retain: 1 }, { insert: "y", attributes: {} }]
      : [{ retain: 1, attributes: { u: index % 2 ? null : true } }]).flat();
    cell.applyDelta(at ? [{ retain: at }, ...delta] : delta);
    const beforeDelete = items(cell).filter(item => !item.deleted
      && (item.id.client === TEXT_WRITER || item.id.client === OTHER_WRITER));
    const textItems = beforeDelete.filter(item => item.content instanceof Y.ContentString).length;
    const formatItems = beforeDelete.filter(item => item.content instanceof Y.ContentFormat).length;
    cell.delete(at, history === "plain" ? width * 2 : width);
    assert.equal(cell.toString(), visible);
    const after = composition(cell);
    assert.equal(after.deletedByTextWriter + after.deletedByOtherWriter, textItems + formatItems);
    assert(Math.abs(after.total - target) <= 4);
    return { state: Y.encodeStateAsUpdate(doc), before, after, textItems, formatItems, width };
  } finally {
    doc.destroy();
  }
}

function offset(position: Position, length: number, index: number): number {
  if (position === "start") return index;
  if (position === "middle") return Math.floor(length / 2) + index;
  if (position === "end") return length + index;
  return Math.floor(length * (index + 1) / (KEYS_PER_COPY + 1)) + index;
}

function profile(replica: NativeReplica, undo: UndoLayer, cell: Y.Text, segment: string) {
  const proto = Y.YTextEvent.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "delta");
  const originalDelta = descriptor?.get as ((this: Y.YTextEvent) => unknown) | undefined;
  assert(descriptor && originalDelta && descriptor.configurable);
  const view = Reflect.get(replica, "view") as (segment: string) => NativeBlock[];
  const relative = Reflect.get(undo, "relative") as (caret: UndoCaret) => Y.RelativePosition;
  const insert = cell.insert;
  const toDelta: (this: Y.Text, ...args: Parameters<Y.Text["toDelta"]>) => unknown = cell.toDelta;
  let current: KeyParts | undefined;
  Object.defineProperty(proto, "delta", {
    ...descriptor,
    get(this: Y.YTextEvent) {
      if (this.target !== cell || !current) return originalDelta.call(this);
      const t = performance.now(), delta = originalDelta.call(this);
      current.observer += performance.now() - t;
      return delta;
    }
  });
  Reflect.set(replica, "view", (id: string) => {
    if (!current || segment !== id) return view.call(replica, id);
    const t = performance.now(), value = view.call(replica, id);
    current.view += performance.now() - t;
    return value;
  });
  Reflect.set(undo, "relative", (caret: UndoCaret) => {
    if (!current) return relative.call(undo, caret);
    const previousView = current.view;
    const t = performance.now(), value = relative.call(undo, caret);
    current.caret += performance.now() - t - (current.view - previousView);
    return value;
  });
  cell.insert = function (...args: Parameters<Y.Text["insert"]>) {
    if (!current) return insert.apply(this, args);
    const t = performance.now();
    insert.apply(this, args);
    current.insert += performance.now() - t;
  };
  cell.toDelta = function (...args: Parameters<Y.Text["toDelta"]>) {
    if (!current) return toDelta.apply(this, args);
    const t = performance.now(), value = toDelta.apply(this, args);
    current.toDelta += performance.now() - t;
    return value;
  };
  return {
    key(beat: string, at: number) {
      current = { insert: 0, observer: 0, view: 0, toDelta: 0, caret: 0, total: 0 };
      const t = performance.now();
      undo.type(beat, AUDIO, at, "L");
      const change = replica.changes();
      current.total = performance.now() - t;
      const result = current;
      current = undefined;
      assert(change.rows.some(row => row.id === beat));
      return { ...result, other: result.total - result.insert - result.observer - result.view - result.caret };
    },
    restore() {
      Object.defineProperty(proto, "delta", descriptor);
      Reflect.deleteProperty(replica, "view");
      Reflect.deleteProperty(undo, "relative");
      Reflect.deleteProperty(cell, "insert");
      Reflect.deleteProperty(cell, "toDelta");
    }
  };
}

type KeyMeasurement = ReturnType<ReturnType<typeof profile>["key"]>;

function spread(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const lower = sorted[Math.floor((sorted.length - 1) / 2)], upper = sorted[Math.floor(sorted.length / 2)];
  assert(lower !== undefined && upper !== undefined);
  return { median: (lower + upper) / 2, min: sorted[0], max: sorted.at(-1) };
}

function summarize(keys: KeyMeasurement[]) {
  const first = keys[0];
  assert(first);
  return Object.fromEntries(Object.keys(first).map(key =>
    [key, spread(keys.map(sample => sample[key as keyof KeyMeasurement]))]));
}

async function trial(base: HotBase, history: ReturnType<typeof addHistory>, position: Position) {
  await setImmediate();
  assert(global.gc, "Run with --expose-gc");
  global.gc();
  const replica = loadSizeReplica(history.state, true);
  try {
    assert.deepEqual(sizeSignature(readSizeScript(replica)), base.expected);
    let now = 0;
    const undo = new UndoLayer(replica, { now: () => now });
    const beat = base.middle, { text: cell } = replica.cell(beat, AUDIO), block = replica.block(beat);
    assert.deepEqual(composition(cell), history.after);
    const initial = cell.toString(), keys = [], meter = profile(replica, undo, cell, block.segment);
    let intended = initial;
    try {
      for (let i = 0; i < KEYS_PER_COPY; i++) {
        now += 120;
        const at = offset(position, initial.length, i);
        keys.push(meter.key(beat, at));
        intended = intended.slice(0, at) + "L" + intended.slice(at);
      }
    } finally {
      meter.restore();
    }
    assert.equal(cell.toString(), intended);
    assert.equal(replica.block(beat).delta.map(part => part.insert).join(""), intended);
    return keys;
  } finally {
    replica.destroy();
  }
}

async function measure(base: HotBase, history: History, target: number, positions: readonly Position[], copies: number,
  placement: HistoryPlacement = "prefix") {
  const hot = addHistory(base, history, target, placement);
  const { state, ...build } = hot;
  const timings = [];
  for (const position of positions) {
    const first = [], warm = [], all = [];
    for (let i = 0; i < copies; i++) {
      const [key, ...rest] = await trial(base, hot, position);
      assert(key);
      first.push(key);
      warm.push(...rest);
      all.push(key, ...rest);
    }
    timings.push({ position, first: summarize(first), warm: summarize(warm), all: summarize(all) });
  }
  console.log(JSON.stringify({ history, placement, target, bytes: state.length, copies, ...build, timings }));
}

function rewritingExamples() {
  const doc = new Y.Doc();
  try {
    const full = doc.getText("full"), partial = doc.getText("partial"), next = random(8001);
    full.insert(0, BEAT_TEXT);
    partial.insert(0, BEAT_TEXT);
    let revised = 0;
    const revisions = 1_000;
    for (let i = 0; i < revisions; i++) {
      full.delete(0, full.length);
      for (const char of BEAT_TEXT) full.insert(full.length, char);
      const width = 5 + Math.floor(next() * 16), at = Math.floor(next() * (BEAT_TEXT.length - width + 1));
      doc.transact(() => {
        partial.delete(at, width);
        partial.insert(at, BEAT_TEXT.slice(at, at + width));
      });
      revised += width;
    }
    assert.equal(full.toString(), BEAT_TEXT);
    assert.equal(partial.toString(), BEAT_TEXT);
    console.log(JSON.stringify({ revisions, beatLength: BEAT_TEXT.length, revised, full: composition(full), partial: composition(partial) }));
  } finally {
    doc.destroy();
  }
}

const [mode, directory] = process.argv.slice(2);
const started = performance.now();
if (mode === "matrix") {
  const base = singleBeat();
  rewritingExamples();
  for (const target of ENTRY_TARGETS) for (const history of HISTORIES) {
    assert(performance.now() - started < 420_000, "Hot-cell matrix time limit");
    await measure(base, history, target, POSITIONS, 3);
  }
} else {
  assert(directory, "Pass a scratch directory with prepare or e8");
  if (mode === "prepare") {
    const fixture = buildSizeFixture(15, { days: 11_232 });
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "state.yjs"), fixture.state);
    writeFileSync(join(directory, "fixture.json"), JSON.stringify({ expected: fixture.expected, middle: fixture.middle }));
  } else {
    assert.equal(mode, "e8", "Pass matrix, prepare or e8");
    const manifest = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8")) as BaseManifest;
    const base = { ...manifest, state: readFileSync(join(directory, "state.yjs")) };
    await measure(base, "formatted", 140_000, ["sweep", ...POSITIONS], 5);
    await measure(base, "plain", 140_000, POSITIONS, 3);
    for (const history of HISTORIES) {
      assert(performance.now() - started < 420_000, "Hot-cell E8 time limit");
      await measure(base, history, 140_000, POSITIONS, 3, "suffix");
    }
  }
}
