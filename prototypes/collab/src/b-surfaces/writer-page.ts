import { BufferHarness } from "../buffer-harness.ts";
import type { BufferMechanism } from "../editing-buffer.ts";
import type { DeliveryOrder } from "../delivery.ts";
import { readReplica } from "../reader.ts";
import { checkModel } from "../model.ts";
import { toHtml } from "../../../../src/core/text/html.ts";
import { bufferOracles } from "../../test/buffer-oracles.ts";
import type { BufferTrace } from "../../test/buffer-oracles.ts";
import { observeBSchema } from "./schema-observation.ts";

interface ExperimentPoint { node: Node; offset: number }
interface ExperimentRange { anchor: { kind: "beat"; rowId: string; offset: number }; head: { kind: "beat"; rowId: string; offset: number } }
interface ExperimentBridge {
  install: (binding: { sync: (id: string, runs: readonly { text: string }[]) => void; undo: () => void } | null) => void;
  model: () => { document: { rows: { id: string; audioText: string }[] }; epoch: number; generation: number; undo: { undo: number; redo: number } };
  offset: (el: HTMLElement, node: Node, offset: number) => number;
  point: (el: HTMLElement, offset: number) => ExperimentPoint;
  hold: () => () => void;
  instrument: () => void;
  markProbe: () => boolean;
  heldUndoProbe: () => unknown;
  open: () => void;
  project: (rows: readonly { id: string; audioText: string }[]) => void;
  repaint: () => void;
  isolation: () => Record<string, unknown>;
}
interface ExperimentWriter { experiment: ExperimentBridge; place: (range: ExperimentRange) => void; selection: () => ExperimentRange | null; check: () => string[] }

const writer = (window as unknown as { __writerFlowTest: ExperimentWriter }).__writerFlowTest;
const bridge = writer.experiment;
if (!bridge) throw new Error("App binding switch is off");
const root = document.querySelector<HTMLElement>("#writer-doc");
if (!root) throw new Error("Missing app Writer host");
const host = root;
bridge.open();
bridge.instrument();
let harness: BufferHarness | null = null;
let trace: BufferTrace = "T04";
let bound = false;
let hold = false;
let repaintOwed = false;
let sequence = 1;
let events: Record<string, unknown>[] = [];
let errors: string[] = [];
let commits: string[] = [];
let pending: { from: number; to: number; selection: [number, number]; before: string } | null = null;
let targetId = "R1";
let inputKind = "";
let suppressPaint = false;
let releaseUndo: (() => void) | null = null;
let syncs: { id: string; text: string; composing: boolean }[] = [];
let generationAtReset = 0;
let breakSync = false;
let phaseObserver: ((phase: string, ms: number) => void) | null = null;

function appSnapshot(): unknown {
  const app = JSON.parse(JSON.stringify(bridge.model())) as { document: Record<string, unknown> & { rows: { id: string; audioText: string; updatedAt?: string; updatedBy?: string }[] } };
  return { ...app, document: { rows: app.document.rows.map(row => ({ id: row.id, audioText: row.audioText, ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}), ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}) })),
    ...Object.fromEntries(["title", "docId", "rev", "lastEditedBy", "lastEditedAt", "personColors"].filter(key => Object.hasOwn(app.document, key)).map(key => [key, app.document[key]])) } };
}

function session(): BufferHarness { if (!harness) throw new Error("No app binding session"); return harness; }
function beat(id = targetId): HTMLElement {
  const el = host.querySelector<HTMLElement>(`.wr-beat[data-id="${CSS.escape(id)}"]`);
  if (!el) throw new Error(`Missing app beat ${id}`);
  return el;
}
function value(el = beat()): string { return (el.textContent ?? "").replaceAll("\u200b", ""); }
function selected(el = beat()): [number, number] | null {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !selection.focusNode || !el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) return null;
  return [bridge.offset(el, selection.anchorNode, selection.anchorOffset), bridge.offset(el, selection.focusNode, selection.focusOffset)];
}
function names(length: number): string[] { return Array.from({ length }, () => `a${sequence++}`); }
function model() {
  const h = session();
  return readReplica(h.alice.editor.doc, "B", h.identities, h.alice.caret ? new Map([["A", h.alice.caret]]) : new Map());
}
function project(): void {
  bridge.project(model().rows.map(row => ({ id: row.id, audioText: toHtml(row.characters.map(character => ({ text: character.value, marks: character.marks }))) })));
}
function paint(): void {
  const h = session();
  if (h.alice.composing || h.alice.dirty || suppressPaint) { repaintOwed = true; return; }
  project();
  bridge.repaint();
  const caret = model().carets.A;
  if (!caret) throw new Error("No mapped caret");
  targetId = caret.beat;
  writer.place({ anchor: { kind: "beat", rowId: caret.beat, offset: caret.selection?.from ?? caret.offset }, head: { kind: "beat", rowId: caret.beat, offset: caret.selection?.to ?? caret.offset } });
  repaintOwed = false;
}
function commit(source: string): void {
  const buffer = session().alice;
  if (!buffer.dirty) return;
  const started = performance.now();
  try {
  const edit = buffer.plan();
  if (buffer.composing) buffer.dispatch({ type: "compositionend", names: names(edit.insert.length) });
  else buffer.commit(names(edit.insert.length));
  commits.push(source);
  project();
  repaintOwed = true;
  } finally { phaseObserver?.("commit-and-projection", performance.now() - started); }
}
function capture(event: Event): Record<string, unknown> {
  const input = event as InputEvent;
  const ranges = typeof input.getTargetRanges === "function" ? [...input.getTargetRanges()] : [];
  const el = beat();
  return {
    type: event.type, inputType: input.inputType ?? null, data: input.data ?? null, cancelable: event.cancelable,
    trusted: event.isTrusted, composing: input.isComposing ?? false, cancelled: event.defaultPrevented,
    ranges: ranges.map(range => ({ startBeat: (range.startContainer.parentElement?.closest(".wr-beat") as HTMLElement | null)?.dataset.id,
      endBeat: (range.endContainer.parentElement?.closest(".wr-beat") as HTMLElement | null)?.dataset.id,
      rawStart: range.startOffset, rawEnd: range.endOffset,
      from: bridge.offset(el, range.startContainer, range.startOffset), to: bridge.offset(el, range.endContainer, range.endOffset) })),
    selection: selected(el), text: value(el), rawText: el.textContent, app: appSnapshot()
  };
}
function guarded(run: () => void): void { try { run(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } }

for (const type of ["keydown", "keyup", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "paste", "cut", "focusout"]) {
  host.addEventListener(type, event => guarded(() => {
    const observation = capture(event);
    events.push({ phase: "capture", ...observation });
    if (!bound) return;
    const buffer = session().alice;
    if (type === "compositionstart") {
      const selection = selected();
      if (!selection) throw new Error("Composition has no app selection");
      buffer.dispatch({ type: "compositionstart", from: Math.min(...selection), to: Math.max(...selection) });
    } else if (type === "beforeinput" && !buffer.composing) {
      const input = event as InputEvent;
      inputKind = input.inputType;
      if (inputKind.startsWith("history")) return;
      const range = input.getTargetRanges()[0];
      const selection = selected();
      if (!range || !selection) throw new Error(`Missing target evidence ${inputKind}`);
      pending = { from: bridge.offset(beat(), range.startContainer, range.startOffset), to: bridge.offset(beat(), range.endContainer, range.endOffset), selection, before: value() };
      if (buffer.paintHeld) {
        if (!input.cancelable) throw new Error("Uncancelable stale input");
        input.preventDefault();
        const data = input.data ?? input.dataTransfer?.getData("text/plain") ?? "";
        buffer.dispatch({ type: "beforeinput", from: pending.from, to: pending.to, data, selection, names: names(data.length) });
        commits.push("beforeinput:stale");
        pending = null;
        paint();
      }
    } else if (type === "input") {
      inputKind = (event as InputEvent).inputType;
      if (buffer.composing) buffer.dispatch({ type: "compositionupdate", data: (event as InputEvent).data ?? "" });
      else native();
      if (buffer.dirty && buffer.nativeValue !== value()) throw new Error(`Buffer/DOM mismatch ${buffer.nativeValue} / ${value()}`);
    }
  }), true);
  host.addEventListener(type, event => guarded(() => {
    if (bound && repaintOwed && !session().alice.dirty && !session().alice.composing) paint();
    events.push({ phase: "bubble", ...capture(event) });
    if (bound && bridge.model().generation !== generationAtReset) throw new Error("App whole-field command bypassed replica binding");
  }));
}

function native(): void {
  if (!pending) throw new Error("Native sync lacks beforeinput evidence");
  const after = value();
  const { before, selection } = pending;
  let { from, to } = pending;
  if (inputKind === "insertText" && before.slice(0, from) + ((after.length > before.length) ? after.slice(from, from + after.length - before.length) : "") + before.slice(to) !== after && selection[0] === selection[1]) from = to = selection[0];
  const inserted = after.length - before.length + to - from;
  if (inserted < 0 || before.slice(0, from) + after.slice(from, from + inserted) + before.slice(to) !== after) throw new Error("App changed DOM outside observed native target");
  const data = after.slice(from, from + inserted);
  const buffer = session().alice;
  const stale = buffer.nativeBaseChanged();
  buffer.dispatch({ type: "beforeinput", from, to, data, selection, names: stale ? names(data.length) : [] });
  if (stale && !buffer.dirty) { commits.push("input:stale-reentry"); project(); repaintOwed = true; }
  pending = null;
}

const api = {
  reset(kind: BufferTrace | "observe", mechanism: BufferMechanism = "M2", defer = false): void {
    bound = false;
    bridge.install(null);
    releaseUndo?.(); releaseUndo = null;
    harness?.destroy();
    trace = kind === "observe" ? "T03 replace" : kind;
    const fixture = bufferOracles[trace];
    harness = new BufferHarness("B", mechanism, fixture.seed);
    harness.alice.paint(fixture.beat, fixture.from, fixture.to);
    targetId = fixture.beat;
    events = []; errors = []; commits = []; pending = null; sequence = 1; syncs = []; breakSync = false;
    hold = defer; suppressPaint = false;
    project(); bridge.open(); paint();
    generationAtReset = bridge.model().generation;
    bound = kind !== "observe";
    if (bound) bridge.install({
      sync(id, runs) {
        guarded(() => {
          if (id !== targetId) return;
          const buffer = session().alice;
          syncs.push({ id, text: runs.map(run => run.text).join(""), composing: buffer.composing });
          if (pending && !buffer.composing) native();
          if (buffer.dirty && runs.map(run => run.text).join("") !== buffer.nativeValue) throw new Error("syncBeatEl decoded a different native value");
          if (!hold || buffer.composing) commit(buffer.composing ? "syncComposition:syncBeatEl" : "onInput:syncBeatEl");
        });
      },
      undo() { guarded(() => { session().alice.undo(); commits.push("writer:selectiveUndo"); repaintOwed = true; }); }
    });
  },
  clear(): void { events = []; },
  bypassSync(): void { breakSync = true; bridge.install(null); },
  unbind(): void { bound = false; bridge.install(null); },
  isolation(): Record<string, unknown> { return bridge.isolation(); },
  markProbe(): boolean { return bridge.markProbe(); },
  heldUndoProbe(): unknown { return bridge.heldUndoProbe(); },
  repaint(): void { bridge.repaint(); },
  blur(): void { (document.querySelector("#writer-title") as HTMLElement).focus(); },
  rawRemote(): void {
    bridge.project([{ id: "R1", audioText: "Zabc" }, { id: "R2", audioText: "ef" }]);
    bridge.repaint();
  },
  select(from: number, to = from): void {
    writer.place({ anchor: { kind: "beat", rowId: targetId, offset: from }, head: { kind: "beat", rowId: targetId, offset: to } });
  },
  remote(order: DeliveryOrder): void {
    const h = session(); const bob = h.bob.editor;
    if (trace === "T04") { bob.insert("R1", 0, "Z", ["b1"]); bob.deleteIdentities(["s4"]); }
    else if (trace === "T04 removed") bob.remove("R1", "rB", "Bob");
    else if (trace === "T01" || trace === "T01 composition") bob.insert("R1", 2, "X", ["b1"]);
    else if (trace === "T02") { h.alice.paintHeld = true; bob.insert("R1", 0, "X", ["b1"]); }
    else if (trace === "T02 boundary") bob.insert("R1", 2, "Y", ["b1"]);
    else if (trace === "T03") bob.format("R1", 0, 3, { b: true });
    else bob.insert("R1", 7, "n", ["b1"]);
    if (order !== "D1") h.queue.deliverFrom("B", order);
    project();
    if (!h.alice.dirty && !h.alice.paintHeld) paint();
  },
  finish(order: DeliveryOrder): void {
    const h = session();
    if (errors.length) throw new Error(errors.join("; "));
    if (!syncs.length && trace !== "T02") throw new Error("Real app syncBeatEl never reached binding");
    if (h.alice.composing) throw new Error("Real app compositionend did not commit through syncBeatEl");
    if (h.alice.dirty) commit("driver:instrumented-held-sync");
    h.queue.flush(order);
    if (order === "late-C") h.lateJoin();
    paint(); api.check(false);
  },
  check(undo: boolean): void {
    const h = session(); const oracle = undo ? bufferOracles[trace].undo : bufferOracles[trace].expected;
    h.check(oracle);
    const observed = model();
    const selection = selected();
    if (!selection) throw new Error("No DOM caret after app paint");
    observed.carets.A = { beat: targetId, offset: selection[0], ...(selection[0] === selection[1] ? {} : { selection: { beat: targetId, from: Math.min(...selection), to: Math.max(...selection) } }) };
    checkModel(observed, oracle, h.identities, "DOM caret");
    for (const row of observed.rows) {
      if (value(beat(row.id)) !== row.characters.map(character => character.value).join("")) throw new Error(`DOM text mismatch ${row.id}`);
      const characters: { value: string; bold: boolean }[] = [];
      const walker = document.createTreeWalker(beat(row.id), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const character of (node.textContent ?? "").replaceAll("\u200b", "")) characters.push({ value: character, bold: !!node.parentElement?.closest("strong") });
      }
      if (characters.some((character, index) => character.bold !== (row.characters[index]?.marks.b === true))) throw new Error(`DOM bold differs from replica ${row.id}`);
    }
    const actual = bridge.model().document.rows.map(row => ({ id: row.id, text: row.audioText }));
    const projection = observed.rows.map(row => ({ id: row.id, text: toHtml(row.characters.map(character => ({ text: character.value, marks: character.marks }))) }));
    if (JSON.stringify(actual) !== JSON.stringify(projection)) throw new Error("Session differs from replica projection");
    if (writer.check().length) throw new Error(`Writer DOM check: ${writer.check().join("; ")}`);
  },
  checkUndo(order: DeliveryOrder): void { session().queue.flush(order); paint(); api.check(true); },
  holdUndo(): void { releaseUndo = bridge.hold(); },
  snapshot() {
    const h = session();
    const bindings: Record<string, unknown> = {};
    const seedLength = bufferOracles[trace].seed.reduce((count, row) => count + row.text.length, 0);
    for (const [prefix, count] of [["s", seedLength], ["a", sequence - 1], ["b", 1]] as const) {
      for (let index = 1; index <= count; index++) {
        for (const suffix of ["", "*"]) {
          const name = `${prefix}${index}${suffix}`;
          try { bindings[name] = h.identities.identity(name); } catch {}
        }
      }
    }
    return { candidate: h.alice.editor.candidate, schema: observeBSchema(h), segments: h.alice.editor.doc.getArray("order").toArray(), events, errors, commits, syncs, breakSync, html: host.innerHTML, text: value(), rawText: beat().textContent, selection: selected(), app: appSnapshot(),
      history: h.history(), dirty: h.alice.dirty, composing: h.alice.composing, heldBytes: h.alice.heldBytes,
      models: Object.fromEntries([...h.sessions].flatMap(([name, buffer]) => {
        const read = (doc: typeof buffer.editor.doc) => {
          try { return readReplica(doc, "B", h.identities, h.alice.caret ? new Map([["A", h.alice.caret]]) : new Map()); }
          catch { return readReplica(doc, "B", h.identities); }
        };
        return [[`${name}.E`, read(buffer.editor.doc)], ...(buffer.editor === buffer.network ? [] : [[`${name}.N`, read(buffer.network.doc)]])];
      })), bindings };
  }
};

Object.assign(window, { appBinding: api });

export function bWriterBindingContext() {
  return { session, bridge, writer, host, model, project, paint, commit, value, selected, names, api,
    profile: (observer: typeof phaseObserver) => { phaseObserver = observer; },
    state: () => ({ pending, targetId, errors, commits, syncs }) };
}
