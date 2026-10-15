import { test } from "node:test";
import assert from "node:assert/strict";
import { applyIncomingMerge, mergeKind } from "../../src/application/session/apply-merge.ts";
import type { ApplyMergeOptions, ApplyMergePorts, MergeOutcome, MergeUndoRecord, UndoPointTicket } from "../../src/application/session/apply-merge.ts";
import type { MergedStates } from "../../src/core/merge-states.ts";
import type { MergeInput } from "../../src/application/session/merge-incoming.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { rawScript } from "./session-fakes.ts";

function doc(v: string): Record<string, unknown> {
  return rawScript(v);
}

function titleOf(d: unknown): unknown {
  return typeof d === "object" && d !== null ? (d as Record<string, unknown>).title : undefined;
}

function merged(v: string): MergedStates {
  return {
    merged: migrateRows(rawScript(v), fakeMigration().ports),
    conflicts: [],
    stats: { rowsFromMe: 1, rowsFromThem: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 }
  };
}

function harness(start: Record<string, unknown> | null = doc("start")) {
  const calls: string[] = [];
  let current: unknown = start;
  let owner = 1;
  let undo: MergeUndoRecord | null | "untouched" = "untouched";
  let base: unknown = "untouched";
  let pending: ((v?: unknown) => void) | null = null;
  const tickets: UndoPointTicket[] = [];
  let merges = 0;
  const ports: ApplyMergePorts<number> = {
    isDocument: (raw) => typeof raw === "object" && raw !== null && "rows" in raw,
    merge: (input: MergeInput) => {
      merges++;
      calls.push("merge");
      return merged(String(titleOf(input.mine)) + "+" + String(titleOf(input.theirs)));
    },
    snapshot: (label, d) => {
      calls.push("snapshot:" + label + ":" + String(titleOf(d)));
      const t: UndoPointTicket = { id: "s" + tickets.length, docId: "d1", done: new Promise((r) => { pending = r; }) };
      tickets.push(t);
      return t;
    },
    current: () => current,
    adopt: (kind, next, wasMerged) => {
      calls.push("adopt:" + kind + ":" + wasMerged);
      current = { ...(next as Record<string, unknown>), adopted: kind };
      return current;
    },
    documentId: (d) => String((d as Record<string, unknown>).docId),
    noteHistoryFrom: (prev) => { calls.push("historyFrom:" + prev); },
    armUndo: (record) => { calls.push("armUndo"); undo = record; },
    setBase: (next, why) => { calls.push("setBase:" + why); base = next; },
    capture: () => owner,
    stillOwns: (ctx) => ctx === owner,
    view: {
      redraw: () => { calls.push("redraw"); },
      chips: () => { calls.push("chips"); },
      report: (_r, opts) => { calls.push("report:" + opts.kind + ":" + opts.noAutoSave); },
      absorbedDirty: (kind) => { calls.push("dirty:" + kind); },
      toast: (text, tone, sticky) => { calls.push("toast:" + text + ":" + tone + ":" + sticky); }
    }
  };
  return {
    ports, calls,
    get current() { return current; },
    get undo() { return undo; },
    get base() { return base; },
    get merges() { return merges; },
    release: () => { pending?.(); },
    replace: () => { owner++; }
  };
}

const sync = (out: MergeOutcome | Promise<MergeOutcome>): MergeOutcome => {
  if (out instanceof Promise) throw new Error("a synchronous answer was expected");
  return out;
};

test("a document that is not one changes nothing and answers the current state", () => {
  const h = harness();
  const out = sync(applyIncomingMerge({ theirs: { nope: 1 }, mine: doc("m") }, h.ports));
  assert.deepEqual(out, { state: h.current, result: null, snapshot: null });
  assert.deepEqual(h.calls, []);
  const out2 = sync(applyIncomingMerge({ theirs: doc("t"), mine: null }, h.ports));
  assert.equal(out2.result, null);
  assert.deepEqual(h.calls, []);
});

test("mergeOnly hands the merge back and touches no screen, baseline or document", () => {
  const h = harness();
  const out = sync(applyIncomingMerge({ base: doc("b"), mine: doc("m"), theirs: doc("t"), source: "stash", mergeOnly: true, undoPoint: doc("t") }, h.ports));
  assert.equal(titleOf(out.state), "m+t");
  assert.equal(out.snapshot?.id, "s0");
  assert.deepEqual(h.calls, ["snapshot:Before merging your unsaved changes:t", "merge", "armUndo"]);
  assert.deepEqual(h.undo, { id: "s0", docId: "d1", source: "stash" });
  assert.equal(titleOf(h.current), "start");
  assert.equal(h.base, "untouched");
});

test("an adopted merge runs in the documented order: adopt, history, undo point, baseline, redraw, chips, report, toast", () => {
  const h = harness();
  const opts: ApplyMergeOptions = {
    base: doc("b"), mine: doc("m"), theirs: doc("t"), source: "server-resume",
    undoPoint: doc("t"), keepLabel: "Kept", historyFrom: "d0", newBase: "nb", chips: true,
    toast: { text: () => "said " + titleOf(h.current), tone: "warn", sticky: true }
  };
  const out = sync(applyIncomingMerge(opts, h.ports));
  assert.deepEqual(h.calls, [
    "snapshot:Before merging your recovered changes:t", "snapshot:Kept:m", "merge",
    "adopt:recovery:true", "historyFrom:d0", "armUndo", "setBase:merge: server-resume",
    "redraw", "chips", "report:recovery:false", "toast:said m+t:warn:true"
  ]);
  assert.equal(out.state, h.current);
  assert.equal(h.base, "nb");
});

test("unchanged adopts theirs with no merge and no undo point; reporting marks it unsaved", () => {
  const h = harness();
  const out = sync(applyIncomingMerge({ theirs: doc("t"), unchanged: true, undoPoint: doc("x"), source: "stash" }, h.ports));
  assert.equal(out.result, null);
  assert.equal(out.snapshot, null);
  assert.equal(h.merges, 0);
  assert.deepEqual(h.calls, ["adopt:server:false", "armUndo", "redraw", "dirty:server"]);
  assert.equal(h.undo, null, "an undo point asked for and not taken is cleared, as before");
});

test("report: false neither reports nor marks unsaved; the kind follows recovery or server-resume", () => {
  const h = harness();
  sync(applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), report: false, noAutoSave: true }, h.ports));
  assert.deepEqual(h.calls, ["merge", "adopt:server:true", "redraw"]);
  assert.equal(mergeKind({ theirs: null, recovery: true }), "recovery");
  assert.equal(mergeKind({ theirs: null, source: "server-resume" }), "recovery");
  assert.equal(mergeKind({ theirs: null, source: "server-conflict" }), "server");
});

test("newBase: a function is read once at adoption; undefined leaves the baseline; null is a value", () => {
  const h = harness();
  let asked = 0;
  sync(applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), newBase: () => { asked++; return "fn"; }, report: false }, h.ports));
  assert.equal(asked, 1);
  assert.equal(h.base, "fn");
  const h2 = harness();
  sync(applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), newBase: undefined, report: false }, h2.ports));
  assert.equal(h2.base, "untouched");
  const h3 = harness();
  sync(applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), newBase: null, report: false }, h3.ports));
  assert.equal(h3.base, null);
});

test("an empty toast says nothing; a plain one defaults to ok and not sticky", () => {
  const h = harness();
  sync(applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), report: false, toast: { text: () => "" } }, h.ports));
  assert.ok(!h.calls.some((c) => c.startsWith("toast")));
  const h2 = harness();
  sync(applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), report: false, toast: { text: "hi" } }, h2.ports));
  assert.ok(h2.calls.includes("toast:hi:ok:false"));
});

test("a refused undo point clears Undo merge; none asked for leaves it alone", () => {
  const h = harness();
  const ports = { ...h.ports, snapshot: () => null };
  sync(applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), undoPoint: doc("t"), mergeOnly: true }, ports));
  assert.equal(h.undo, null);
  const h2 = harness();
  sync(applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), mergeOnly: true }, h2.ports));
  assert.equal(h2.undo, "untouched");
});

test("awaitUndoPoint adopts nothing until the undo point is written, then adopts", async () => {
  const h = harness();
  const p = applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), undoPoint: doc("t"), source: "stash", awaitUndoPoint: true, newBase: () => "late", report: false }, h.ports);
  assert.ok(p instanceof Promise, "a Promise, not the answer");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.calls, ["snapshot:Before merging your unsaved changes:t", "merge"]);
  assert.equal(h.base, "untouched");
  h.release();
  const out = await p;
  assert.equal(out.replaced, undefined);
  assert.equal(titleOf(h.current), "m+t");
  assert.equal(h.base, "late");
});

test("awaitUndoPoint: a document replaced while the undo point is written is left alone and answered as replaced", async () => {
  const h = harness();
  const p = applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), undoPoint: doc("t"), source: "stash", awaitUndoPoint: true, report: false }, h.ports);
  h.replace();
  h.release();
  const out = await p;
  assert.equal(out.replaced, true);
  assert.equal(out.result, null);
  assert.equal(out.state, h.current);
  assert.equal(titleOf(h.current), "start");
  assert.ok(!h.calls.some((c) => c.startsWith("adopt") || c === "redraw" || c === "armUndo"));
});

test("awaitUndoPoint with no undo point still answers a promise, and a failed write still adopts", async () => {
  const h = harness();
  const p = applyIncomingMerge({ theirs: doc("t"), unchanged: true, awaitUndoPoint: true, report: false }, h.ports);
  assert.ok(p instanceof Promise, "a Promise, not the answer");
  await p;
  assert.equal(titleOf(h.current), "t");

  const h2 = harness();
  const failing = { ...h2.ports, snapshot: (): UndoPointTicket => ({ id: "s9", docId: "d1", done: Promise.reject(new Error("quota")) }) };
  const out = await applyIncomingMerge({ mine: doc("m"), theirs: doc("t"), undoPoint: doc("t"), awaitUndoPoint: true, report: false }, failing);
  assert.equal(titleOf(out.state), "m+t");
});
