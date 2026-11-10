import { BufferHarness } from "../buffer-harness.ts";
import type { BufferMechanism } from "../editing-buffer.ts";
import type { DeliveryOrder } from "../delivery.ts";
import type { SchemaReplica } from "../schema.ts";
import { readReplica } from "../reader.ts";
import { bufferOracles } from "../../test/buffer-oracles.ts";
import type { BufferTrace } from "../../test/buffer-oracles.ts";
import { paintRuns, recordEvent, selectedOffsets, selectOffsets } from "./dom.ts";
import type { SliceEvent } from "./dom.ts";

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing slice element ${selector}`);
  return element;
}

const root = requiredElement("#writer");
const beat = requiredElement(".wr-beat");
let harness: BufferHarness | null = null;
let trace: BufferTrace = "T04";
let events: SliceEvent[] = [];
let errors: string[] = [];
let bound = false;
let hold = false;
let pending: { range: [number, number]; selection: [number, number]; before: string } | null = null;
let nextName = 1;
let commits: string[] = [];
let domVersion = "";
let cancelComposition = false;

function session(): BufferHarness {
  if (!harness) throw new Error("No browser session");
  return harness;
}

function names(length: number): string[] {
  return Array.from({ length }, () => `a${nextName++}`);
}

function liveVersion(): string {
  const h = session();
  const model = readReplica(h.alice.editor.doc, "A", h.identities);
  return JSON.stringify(model.rows.find(row => row.id === beat.dataset.id) ?? model.recovery.find(entry => entry.row.id === beat.dataset.id));
}

function paint(): void {
  const h = session();
  const buffer = h.alice;
  if (!buffer.painted || !buffer.caret) throw new Error("No paint base");
  beat.dataset.id = buffer.painted.id;
  paintRuns(beat, buffer.painted.runs);
  const model = readReplica(buffer.editor.doc, "A", h.identities, new Map([["A", buffer.caret]]));
  const caret = model.carets.A;
  if (!caret) throw new Error("Missing caret");
  selectOffsets(beat, caret.selection?.from ?? caret.offset, caret.selection?.to ?? caret.offset);
  domVersion = liveVersion();
}

function commit(where: string): void {
  const buffer = session().alice;
  if (buffer.dirty) {
    const edit = buffer.plan();
    if (buffer.composing) buffer.dispatch({ type: "compositionend", names: names(edit.insert.length) });
    else buffer.commit(names(edit.insert.length));
    commits.push(where);
  }
  paint();
}

for (const type of ["keydown", "keyup", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "copy", "cut", "paste"]) {
  root.addEventListener(type, event => {
    try {
      const observed = recordEvent(event, beat);
      events.push(observed);
      if (type === "beforeinput" && cancelComposition) { event.preventDefault(); observed.cancelled = event.defaultPrevented; }
      if (!bound) return;
      const buffer = session().alice;
      if (type === "compositionstart") {
        const selection = observed.selection;
        if (!selection) throw new Error("Composition has no beat selection");
        buffer.dispatch({ type: "compositionstart", from: Math.min(...selection), to: Math.max(...selection) });
      } else if (type === "compositionend") {
        commit("compositionend");
      } else if (type === "beforeinput" && !buffer.composing) {
        if (observed.inputType === "historyUndo") {
          event.preventDefault();
          observed.cancelled = event.defaultPrevented;
          buffer.undo();
          commits.push("beforeinput:historyUndo");
          paint();
          return;
        }
        const range = observed.ranges[0];
        if (!range || !observed.selection) throw new Error(`No target evidence for ${observed.inputType}`);
        pending = { range, selection: observed.selection, before: beat.textContent ?? "" };
        if (!buffer.dirty && domVersion !== liveVersion()) {
          if (!event.cancelable) throw new Error("Stale input cannot be cancelled");
          event.preventDefault();
          observed.cancelled = event.defaultPrevented;
          const data = observed.data ?? (event as InputEvent).dataTransfer?.getData("text/plain") ?? "";
          buffer.dispatch({ type: "beforeinput", from: range[0], to: range[1], data, selection: observed.selection, names: names(data.length) });
          commits.push("beforeinput:stale");
          paint();
          pending = null;
        }
      } else if (type === "input") {
        if (buffer.composing) {
          const input = event as InputEvent;
          buffer.dispatch({ type: "compositionupdate", data: input.data ?? "" });
        } else {
          if (!pending) throw new Error("Input without captured beforeinput");
          const { range, selection, before } = pending;
          const after = beat.textContent ?? "";
          const inserted = after.length - before.length + range[1] - range[0];
          if (inserted < 0) throw new Error("Native change is not a target-range splice");
          const data = after.slice(range[0], range[0] + inserted);
          if (before.slice(0, range[0]) + data + before.slice(range[1]) !== after) throw new Error("Native DOM changed outside target range");
          buffer.dispatch({ type: "beforeinput", from: range[0], to: range[1], data, selection, names: [] });
          pending = null;
        }
        if (buffer.nativeValue !== beat.textContent) throw new Error(`Buffer/DOM disagree: ${JSON.stringify(buffer.nativeValue)} / ${JSON.stringify(beat.textContent)}`);
        if (!hold && !buffer.composing) commit("input");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });
}

const api = {
  reset(kind: BufferTrace | "observe", mechanism: BufferMechanism = "M2", defer = false): void {
    harness?.destroy();
    harness = null;
    events = [];
    errors = [];
    commits = [];
    pending = null;
    nextName = 1;
    domVersion = "";
    cancelComposition = false;
    hold = defer;
    bound = kind !== "observe";
    const paragraph = document.createElement("div");
    paragraph.className = "wr-par";
    paragraph.append(beat);
    root.replaceChildren(paragraph);
    trace = kind === "observe" ? "T04" : kind;
    const fixture = bufferOracles[trace];
    harness = new BufferHarness("A", mechanism, fixture.seed);
    harness.alice.paint(fixture.beat, fixture.from, fixture.to);
    if (kind === "observe") {
      beat.dataset.id = "R1";
      paintRuns(beat, [{ insert: "the", attributes: { b: true } }, { insert: " the", attributes: {} }]);
    } else paint();
    root.focus();
    if (kind === "observe") selectOffsets(beat, 0);
  },
  clear(): void { events = []; },
  lag(): void { session().alice.paintHeld = true; },
  tryCancelComposition(): void { cancelComposition = true; },
  remote(order: DeliveryOrder): void {
    const h = session();
    const bob = h.bob.editor;
    if (trace === "T04") { bob.insert("R1", 0, "Z", ["b1"]); bob.deleteIdentities(["s4"]); }
    else if (trace === "T04 removed") bob.remove("R1", "rB", "Bob");
    else if (trace === "T01" || trace === "T01 composition") bob.insert("R1", 2, "X", ["b1"]);
    else if (trace === "T02") { api.lag(); bob.insert("R1", 0, "X", ["b1"]); }
    else if (trace === "T02 boundary") bob.insert("R1", 2, "Y", ["b1"]);
    else if (trace === "T03") bob.format("R1", 0, 3, { b: true });
    else bob.insert("R1", 7, "n", ["b1"]);
    if (order !== "D1") h.queue.deliverFrom("B", order);
    if (!h.alice.dirty && !h.alice.paintHeld) paint();
  },
  finish(order: DeliveryOrder): void {
    const h = session();
    if (h.alice.dirty) commit("driver:held-buffer");
    h.queue.flush(order);
    if (order === "late-C") h.lateJoin();
    h.check(bufferOracles[trace].expected);
    paint();
    api.checkDom(false);
    hold = false;
  },
  checkDom(undo: boolean): void {
    const expected = undo ? bufferOracles[trace].undo : bufferOracles[trace].expected;
    const caret = expected.carets.A;
    const row = expected.rows.find(row => row.id === caret?.beat);
    if (!caret || !row) throw new Error("Oracle has no active caret row");
    if (beat.textContent !== row.characters.map(character => character[1]).join("")) throw new Error("Painted DOM text differs from oracle");
    const selected = selectedOffsets(beat);
    if (JSON.stringify(selected) !== JSON.stringify([caret.selection?.from ?? caret.offset, caret.selection?.to ?? caret.offset])) throw new Error(`DOM selection differs from oracle: ${selected}`);
    for (const [index, character] of row.characters.entries()) {
      const walker = document.createTreeWalker(beat, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let offset = index;
      while (node && offset >= (node.textContent?.length ?? 0)) { offset -= node.textContent?.length ?? 0; node = walker.nextNode(); }
      if (!!node?.parentElement?.closest("strong") !== !!character[2].b) throw new Error("Painted DOM bold differs from oracle");
    }
  },
  checkUndo(order: DeliveryOrder): void {
    const h = session();
    h.queue.flush(order);
    h.check(bufferOracles[trace].undo);
    paint();
    api.checkDom(true);
    if (h.queue.pending.length || [...h.sessions.values()].some(session => session.heldBytes)) throw new Error("Undrained delivery queue");
  },
  repaint(mode: "whole" | "text", restore: boolean): void {
    const selected = selectedOffsets(beat);
    if (mode === "whole") {
      const html = beat.innerHTML;
      beat.innerHTML = html;
    }
    else {
      const node = window.getSelection()?.focusNode;
      if (node) node.parentNode?.replaceChild(document.createTextNode(node.textContent ?? ""), node);
    }
    if (restore && selected) selectOffsets(beat, selected[0], selected[1]);
  },
  snapshot(): unknown {
    const h = session();
    const anchors = h.alice.caret ? new Map([["A", h.alice.caret]]) : new Map();
    const read = (replica: SchemaReplica): ReturnType<typeof readReplica> => {
      try { return readReplica(replica.doc, "A", h.identities, anchors); }
      // why: Before delivery, Bob cannot resolve a caret inside Alice's unpublished insertion.
      catch { return readReplica(replica.doc, "A", h.identities); }
    };
    const models = bound ? Object.fromEntries([...h.sessions].flatMap(([name, buffer]) => [
      [`${name}.E`, read(buffer.editor)],
      ...(buffer.editor === buffer.network ? [] : [[`${name}.N`, read(buffer.network)]])
    ])) : {};
    const bindings: Record<string, unknown> = {};
    const seedLength = bufferOracles[trace].seed.reduce((length, row) => length + row.text.length, 0);
    for (const [prefix, count] of [["s", seedLength], ["a", nextName - 1], ["b", 1]] as const) {
      for (let index = 1; index <= count; index++) {
        for (const suffix of ["", "*"]) {
          const name = `${prefix}${index}${suffix}`;
          try { bindings[name] = h.identities.identity(name); } catch {}
        }
      }
    }
    return { events, errors, commits, text: beat.textContent, html: beat.innerHTML, rootHtml: root.innerHTML, selection: selectedOffsets(beat), history: h.history(), dirty: h.alice.dirty, composing: h.alice.composing, models, bindings };
  }
};

Object.assign(window, { slice: api });
api.reset("observe");
