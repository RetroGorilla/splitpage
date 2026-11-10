import { bWriterBindingContext } from "./writer-page.ts";
import type { BufferMechanism } from "../editing-buffer.ts";
import type { DeliveryOrder } from "../delivery.ts";
import { addComment } from "../marks/commands.ts";
import { readStructure } from "../structure-reader.ts";
import { bufferOracles } from "../../test/buffer-oracles.ts";
import { bindingFollowupInput } from "../app-binding-2/cases.ts";
import type { BindingFollowupCase } from "../app-binding-2/cases.ts";
import { checkBindingFollowup } from "../app-binding-2/checker.ts";
import type { BindingFollowupFacts, BindingFollowupObservation } from "../app-binding-2/checker.ts";
import type { CollabIdentity, CollabModel } from "../model.ts";
import type { FlowOutcome, FlowRange } from "../../../../src/core/flow/flow.ts";
import { observeBSchema } from "./schema-observation.ts";

const context = bWriterBindingContext();
const { host, bridge, api } = context;
const commandBridge = bridge as typeof bridge & {
  command: (handler: ((name: string, before: FlowRange | null) => FlowOutcome | undefined) | null) => void;
  paintEvents: () => { phase: "start" | "end"; at: number }[];
  clearPaintEvents: () => void;
};
let current: BindingFollowupCase = "split-inside";
let order: DeliveryOrder = "D3";
let retained = false;
let paintGate = false;
let injected = false;
let clipboard = "";
let facts: BindingFollowupFacts = { inserted: [], deleted: [], marked: [], updates: 0, join: false, comment: false, split: null };
let timings: { phase: string; ms: number; at: number }[] = [];
let reentry: Record<string, unknown>[] = [];
let peak = { bytes: 0, messages: 0, transportMessages: 0 };
let remoteDOM: { sameNodes: boolean }[] = [];
const originalRepaint = bridge.repaint;
bridge.repaint = () => {
  const start = performance.now();
  try { originalRepaint(); } finally { timings.push({ phase: "app-repaint-request", ms: performance.now() - start, at: performance.now() }); }
};

function notePeak(): void {
  const h = context.session();
  peak.bytes = Math.max(peak.bytes, h.alice.heldBytes);
  peak.messages = Math.max(peak.messages, h.alice.held.length);
  peak.transportMessages = Math.max(peak.transportMessages, h.queue.pending.length);
}

function remote(): void {
  const h = context.session(); const bob = h.bob.editor;
  const nodes = (): Node[] => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_ALL);
    const found: Node[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) found.push(node);
    return found;
  };
  const beforeNodes = nodes();
  const insert = (beat: string, offset: number, value: string, name: string): void => {
    facts.inserted.push({ name, value }); facts.updates++;
    bob.insert(beat, offset, value, [name]);
  };
  const mark = (marks: Record<string, string | boolean>): void => {
    facts.marked.push(...Object.entries(marks).map(([key, value]) => ({ names: ["s2", "s3"], key, value })));
    facts.updates++; bob.format("R1", 1, 2, marks);
  };
  if (current.startsWith("split-")) {
    facts.updates++;
    facts.split = { source: "R1", offset: current === "split-before" ? 1 : current === "split-inside" ? 2 : 4, id: "Rb" };
    bob.split(facts.split.source, facts.split.offset, facts.split.id, "b1", "Bob");
  } else if (current === "join-previous") {
    facts.join = true; facts.updates++; bob.join("R2", "R1", "jB");
  } else if (current === "removed") {
    facts.updates++; bob.remove("R1", "rB", "Bob");
  } else if (current === "bold") mark({ b: true });
  else if (current === "comment-tag") {
    facts.comment = true; facts.updates += 2;
    facts.marked.push({ names: ["s2", "s3"], key: "c:C1", value: true }, { names: ["s2", "s3"], key: "tag", value: "P" });
    addComment(bob, "C1", "R1", 1, 2, "Bob");
    bob.doc.transact(() => bob.doc.getMap("tags").set("P", { kind: "Prop" }), bob.localOrigin);
    facts.updates++; bob.format("R1", 1, 2, { "t:oB": "P" });
  } else if (current === "long") {
    for (let index = 0; index < 160; index++) {
      const beat = index % 4 < 2 ? "R1" : "R2";
      const location = bob.locate(beat);
      insert(beat, location.end - location.start, beat === "R1" ? "Q" : "R", `b${index + 1}`);
      if (index % 2 === 1) { facts.deleted.push(`b${index}`); facts.updates++; bob.deleteIdentities([`b${index}`]); }
    }
  } else insert("R1", 0, "Z", "b1");
  notePeak();
  h.queue.deliverFrom("B", order);
  notePeak();
  context.project();
  if (!h.alice.dirty) context.paint();
  else if (h.alice.composing || !paintGate) bridge.repaint();
  const afterNodes = nodes();
  remoteDOM.push({ sameNodes: beforeNodes.length === afterNodes.length && beforeNodes.every((node, index) => node === afterNodes[index]) });
}

function inject(where: string): void {
  if (injected) throw new Error("Re-entry delivered twice");
  injected = true;
  reentry.push({ where, phase: "before-delivery", dirty: context.session().alice.dirty, dom: context.value(), selection: context.selected() });
  remote();
  reentry.push({ where, phase: "after-delivery", dirty: context.session().alice.dirty, dom: context.value(), selection: context.selected() });
}

host.addEventListener("beforeinput", event => {
  if (!current.startsWith("reentry-") || current === "reentry-paste" || !retained || (event as InputEvent).isComposing) return;
  const pending = context.state().pending;
  if (pending) context.session().alice.retainBeforeInput(Math.min(...pending.selection), Math.max(...pending.selection));
}, true);
host.addEventListener("beforeinput", event => {
  if (!current.startsWith("reentry-") || current === "reentry-paste" || injected) return;
  reentry.push({ where: "after-app-beforeinput", defaultPrevented: event.defaultPrevented, trusted: event.isTrusted, inputType: (event as InputEvent).inputType });
  inject("after-app-beforeinput");
});
host.addEventListener("paste", event => { clipboard = event.clipboardData?.getData("text/plain") ?? ""; }, true);

function command(name: string, before: FlowRange | null): FlowOutcome | undefined {
  if (name !== "paste" || current !== "reentry-paste") return undefined;
  if (!before || before.anchor.kind !== "beat" || before.head.kind !== "beat" || before.anchor.rowId !== before.head.rowId || /[\r\n]/.test(clipboard)) throw new Error("Only observed single-beat plain-text paste is bound");
  const buffer = context.session().alice;
  const from = Math.min(before.anchor.offset, before.head.offset); const to = Math.max(before.anchor.offset, before.head.offset);
  if (retained) buffer.retainBeforeInput(from, to);
  inject("inside-flow-writer-commit-after-paste-range-captured");
  const stale = buffer.nativeBaseChanged();
  buffer.dispatch({ type: "beforeinput", from, to, data: clipboard, selection: [before.anchor.offset, before.head.offset], names: stale ? context.names(clipboard.length) : [] });
  if (buffer.dirty) context.commit("paste:command-override");
  else { context.state().commits.push("paste:stale-reentry"); context.project(); }
  context.paint();
  const caret = context.model().carets.A;
  if (!caret) throw new Error("Paste has no mapped caret");
  return { rows: bridge.model().document.rows, sections: undefined, removedComments: [], selection: { anchor: { kind: "beat", rowId: caret.beat, offset: caret.offset }, head: { kind: "beat", rowId: caret.beat, offset: caret.offset } } };
}

function observation(): BindingFollowupObservation {
  const h = context.session();
  const bindings: Record<string, CollabIdentity> = {};
  const names = [...Array.from({ length: 6 }, (_, index) => `s${index + 1}`), ...Array.from({ length: 20 }, (_, index) => `a${index + 1}`), "b1", ...facts.inserted.map(item => item.name)];
  for (const name of new Set(names)) { try { bindings[name] = h.identities.identity(name); } catch {} }
  const models: Record<string, CollabModel> = {};
  for (const [name, buffer] of h.sessions) {
    for (const [suffix, replica] of [["E", buffer.editor], ...(buffer.editor === buffer.network ? [] : [["N", buffer.network]] as const)] as const) {
      try { models[`${name}.${suffix}`] = readStructure(replica.doc, "B", h.identities, h.alice.caret ? new Map([["A", h.alice.caret]]) : new Map()); }
      catch { models[`${name}.${suffix}`] = readStructure(replica.doc, "B", h.identities); }
    }
  }
  return { models, bindings, errors: [...context.state().errors], dirty: h.alice.dirty, composing: h.alice.composing,
    dom: [...host.querySelectorAll<HTMLElement>(".wr-beat")].map(el => ({ id: el.dataset.id ?? "", text: context.value(el), html: el.innerHTML, selection: context.selected(el) })) };
}

const followup = {
  reset(name: BindingFollowupCase, mechanism: BufferMechanism, delivery: DeliveryOrder = "D3", retain = false, gatePaint = false): void {
    commandBridge.command(null);
    api.reset(name === "removed" ? "T04 removed" : "T04", mechanism, false);
    current = name; order = delivery; retained = retain; paintGate = gatePaint; injected = false; clipboard = "";
    facts = { inserted: [], deleted: [], marked: [], updates: 0, join: false, comment: false, split: null };
    timings = []; reentry = []; peak = { bytes: 0, messages: 0, transportMessages: 0 };
    remoteDOM = [];
    context.profile((phase, ms) => { timings.push({ phase, ms, at: performance.now() }); });
    const input = bindingFollowupInput(current);
    const buffer = context.session().alice;
    buffer.paint(input.beat, input.from, input.to);
    context.paint(); api.clear();
    commandBridge.clearPaintEvents();
    const original = buffer.commit.bind(buffer);
    buffer.commit = (...args) => {
      const start = performance.now();
      try { original(...args); } finally { timings.push({ phase: "buffer-commit", ms: performance.now() - start, at: performance.now() }); }
    };
    commandBridge.command(command);
  },
  remote,
  finish(): { failures: string[]; literal: string | null } {
    const h = context.session();
    h.queue.flush(order);
    if (order === "late-C") h.lateJoin();
    try { context.paint(); } catch (error) { context.state().errors.push(error instanceof Error ? error.message : String(error)); }
    let literal: string | null = null;
    if (current === "removed") {
      try { h.check(bufferOracles["T04 removed"].expected); api.check(false); literal = "PASS"; }
      catch (error) { literal = error instanceof Error ? error.message : String(error); }
    }
    const failures = checkBindingFollowup(bindingFollowupInput(current), facts, observation(), h.alice.mechanism, order === "late-C");
    if (literal && literal !== "PASS") failures.push(literal);
    return { failures, literal };
  },
  removedUndo(): void { context.session().queue.flush(order); context.paint(); context.session().check(bufferOracles["T04 removed"].undo); api.check(true); },
  snapshot() {
    const h = context.session();
    const base = context.api.snapshot();
    const rawModels = base.models as Record<string, CollabModel>;
    return { schema: observeBSchema(h), ...observation(), facts, timings, reentry, remoteDOM, peak, paints: commandBridge.paintEvents(), history: h.history(), events: base.events,
      rawLocalMarks: rawModels["A.E"]?.rows.flatMap(row => row.characters.filter(character => character.identity?.client === 1).map(character => ({ name: character.notation, marks: character.marks }))),
      app: base.app, heldBytes: h.alice.heldBytes, heldMessages: h.alice.held.length,
      native: h.alice.nativeValue, commits: [...context.state().commits], syncs: [...context.state().syncs], queuePending: h.queue.pending.length };
  }
};

Object.assign(window, { appBindingFollowup: followup });
