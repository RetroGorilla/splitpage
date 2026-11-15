import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { applySharedUpdate, encodeSharedStateVector, encodeSharedUpdate, observeSharedUpdates, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { createSharedReplica } from "../../../src/adapters/collab/replica.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { timingMarks } from "../../../shared/timing-marks.ts";
import { replicas } from "./executor-support.ts";
import { nativeText } from "./incremental-support.ts";
import { markParts } from "../../collab/measure/mark-parts.mjs";

const SOURCE = { title: "Script", rows: [{ id: "R1", audioText: "one" }, { id: "R2", audioText: "two" }] };
const THROWS_WHILE_APPLYING = [1, 1, 7, 0, 168, 7, 5, 1, 125, 1, 0];
const ZERO_LENGTH_STRUCT = [1, 1, 1, 0, 40, 1, 4, 109, 101, 116, 97, 1, 120, 0, 0];

interface Span { readonly seam: string; readonly start: number; readonly end: number }

const marks = (): string[] => performance.getEntriesByType("mark").map(entry => entry.name).filter(name => name.startsWith("measure:"));

function spans(names: readonly string[]): Span[] {
  const open = new Map<string, number[]>(), out: Span[] = [];
  names.forEach((name, at) => {
    const [, seam = "", edge] = name.split(":");
    if (edge === "start") { open.set(seam, [...open.get(seam) ?? [], at]); return; }
    const start = open.get(seam)?.pop();
    assert.notEqual(start, undefined, "every end mark has its start: " + name);
    out.push({ seam, start: start ?? -1, end: at });
  });
  for (const [seam, starts] of open) assert.deepEqual(starts, [], "every start mark has its end: " + seam);
  return out;
}

const of = (found: readonly Span[], seam: string): Span[] => found.filter(span => span.seam === seam);
const inside = (inner: Span, outer: Span): boolean => outer.start < inner.start && inner.end < outer.end;

function timed(run: (shared: ReturnType<typeof replicas>) => void): void {
  const shared = replicas(2, SOURCE);
  timingMarks.marksOn = true;
  performance.clearMarks();
  try { run(shared); } finally { timingMarks.marksOn = false; performance.clearMarks(); shared.close(); }
}

function written(from: SharedDocumentHandle, to: SharedDocumentHandle, segment: string, text: string): Uint8Array {
  const vector = encodeSharedStateVector(to);
  transactSharedDocument(from, "local-command", () => nativeText(from, segment).insert(0, text));
  return encodeSharedUpdate(from, vector);
}

function pairedUpdate(shared: ReturnType<typeof replicas>, text: string): void {
  performance.clearMarks();
  assert.deepEqual(applySharedUpdate(shared.a, written(shared.b, shared.a, "b:R2", text)), { ok: true });
  const found = spans(marks());
  assert.deepEqual([of(found, "trial").length, of(found, "live-apply").length], [1, 1], "the next update marks one trial and one live apply");
}

test("timing marks: a throwing update listener still closes the live apply, and the next update's marks pair exactly", () => {
  timed(shared => {
    const stop = observeSharedUpdates(shared.a, () => { throw new Error("listener"); });
    try { assert.throws(() => applySharedUpdate(shared.a, written(shared.b, shared.a, "b:R1", "+")), /listener/); } finally { stop(); }
    const found = spans(marks());
    assert.equal(of(found, "live-apply").length, 1);
    pairedUpdate(shared, "!");
  });
});

test("timing marks: each refused update closes its trial and marks no live apply, and the next update's marks pair exactly", () => {
  timed(shared => {
    for (const [kind, bytes] of [["throws", THROWS_WHILE_APPLYING], ["zero-length", ZERO_LENGTH_STRUCT]] as const) {
      performance.clearMarks();
      assert.deepEqual(applySharedUpdate(shared.a, Uint8Array.from(bytes)), { ok: false, reason: "invalid-update" }, kind);
      const found = spans(marks());
      assert.deepEqual([of(found, "trial").length, of(found, "live-apply").length], [1, 0], kind);
      pairedUpdate(shared, kind);
    }
  });
});

test("timing marks: an update that arrives while a listener hears the first gets its own live apply, after the first closes", () => {
  timed(shared => {
    const first = written(shared.b, shared.a, "b:R1", "A"), vector = encodeSharedStateVector(shared.b);
    transactSharedDocument(shared.b, "local-command", () => nativeText(shared.b, "b:R2").insert(0, "B"));
    const second = encodeSharedUpdate(shared.b, vector);
    let arrived: unknown = null;
    const stop = observeSharedUpdates(shared.a, () => { if (arrived === null) arrived = applySharedUpdate(shared.a, second); });
    try { assert.deepEqual(applySharedUpdate(shared.a, first), { ok: true }); } finally { stop(); }
    assert.deepEqual(arrived, { ok: true });
    assert.deepEqual(marks().filter(name => name.startsWith("measure:live-apply:")),
      ["measure:live-apply:start", "measure:live-apply:end", "measure:live-apply:start", "measure:live-apply:end"]);
    const found = spans(marks()), [a, b] = of(found, "live-apply"), trials = of(found, "trial");
    assert.ok(a && b && a.end < b.start, "one span per live transaction, in arrival order");
    assert.equal(trials.length, 2);
    assert.ok(trials[0] && trials[0].end < a.start && trials[1] && inside(trials[1], a), "the second update is validated while the first is heard");
    assert.deepEqual([nativeText(shared.a, "b:R1").toString(), nativeText(shared.a, "b:R2").toString()], ["Aone", "Btwo"]);
  });
});

test("timing marks: after a projection failure, the failure delivery is a projection-listener span and the retried publication inside it marks its assembly", () => {
  timed(shared => {
    const broken = new Error("projection");
    let armed = false;
    const replica = createSharedReplica(shared.a, kind => { if (armed && kind === "compare-row") { armed = false; throw broken; } });
    const heard: unknown[] = [];
    const stop = replica.observe((_origin, failure) => { heard.push(failure?.error ?? null); replica.project(); });
    try {
      const update = written(shared.b, shared.a, "b:R1", "+");
      performance.clearMarks();
      armed = true;
      assert.deepEqual(applySharedUpdate(shared.a, update), { ok: true });
      assert.deepEqual(heard, [broken]);
      const found = spans(marks()), [live] = of(found, "live-apply"), listeners = of(found, "projection-listeners"), receives = of(found, "session-receive");
      const assemblies = of(found, "assembly");
      assert.ok(live);
      assert.equal(assemblies.length, 2, "the failed publication and its retry each mark an assembly");
      assert.ok(listeners.length === 1 && listeners[0] && receives.length === 1 && receives[0] && inside(receives[0], listeners[0]), "the failure is delivered inside a listener span");
      const [failed, retried] = assemblies;
      assert.ok(failed && retried && !inside(failed, listeners[0]) && inside(retried, receives[0]), "the retry's assembly runs inside the session receive");
      const [receive] = of(found, "receive");
      assert.ok(receive && inside(live, receive), "the live apply runs inside the received update's outer span");
      for (const span of found) if (span !== live && span !== receive) assert.ok(inside(span, live) || span.seam === "trial", span.seam + " inside the live apply");
    } finally { stop(); replica.dispose(); }
  });
});

test("timing marks: on the trial replica path a refused update marks one rebuild inside its trial and receive, an ordinary arrival none, and unattributed is 0", () => {
  const shared = replicas(2, SOURCE), replica = createSharedReplica(shared.a), recorded: { name: string; startTime: number }[] = [];
  const real = performance.mark.bind(performance), emit = Y.Doc.prototype.emit, from = Uint8Array.from;
  let now = 0;
  Y.Doc.prototype.emit = function (this: Y.Doc, ...args: Parameters<typeof emit>) { now++; return emit.apply(this, args); };
  Uint8Array.from = function (this: typeof Uint8Array, ...args: unknown[]) { now++; return (from as (...values: unknown[]) => Uint8Array).apply(this, args); } as typeof Uint8Array.from;
  performance.mark = ((name: string) => { recorded.push({ name, startTime: now }); if (!/:(receive|drain|event):/.test(name) && name.endsWith(":start")) now++; }) as typeof performance.mark;
  timingMarks.marksOn = true;
  const measured = (run: () => void) => {
    recorded.length = 0;
    run();
    const names = recorded.map(entry => entry.name).filter(name => name.startsWith("measure:"));
    return { found: spans(names), parts: markParts(recorded.filter(entry => entry.name.startsWith("measure:"))) };
  };
  try {
    const refused = measured(() => { assert.deepEqual(applySharedUpdate(shared.a, Uint8Array.from(THROWS_WHILE_APPLYING)), { ok: false, reason: "invalid-update" }); });
    const [receive] = of(refused.found, "receive"), [trial] = of(refused.found, "trial"), rebuilds = of(refused.found, "rebuild");
    assert.ok(receive && trial && rebuilds.length === 1 && rebuilds[0] && inside(rebuilds[0], trial) && inside(trial, receive));
    assert.ok(refused.parts.rebuild > 0 && refused.parts.unattributed === 0, JSON.stringify(refused.parts));
    const ordinary = measured(() => { assert.deepEqual(applySharedUpdate(shared.a, written(shared.b, shared.a, "b:R1", "+")), { ok: true }); });
    assert.deepEqual([of(ordinary.found, "rebuild").length, of(ordinary.found, "trial").length, of(ordinary.found, "live-apply").length], [0, 1, 1]);
    assert.ok(ordinary.parts.rebuild === 0 && ordinary.parts.unattributed === 0, JSON.stringify(ordinary.parts));
  } finally {
    timingMarks.marksOn = false; performance.mark = real; Y.Doc.prototype.emit = emit; Uint8Array.from = from;
    replica.dispose(); shared.close();
  }
});

test("timing marks: switched off, a valid update, a refused update and a local write make no mark", () => {
  const shared = replicas(2, SOURCE), calls: string[] = [], real = performance.mark.bind(performance);
  const replica = createSharedReplica(shared.a), stop = replica.observe(() => {});
  performance.mark = ((name: string) => { calls.push(name); return real(name); }) as typeof performance.mark;
  try {
    assert.deepEqual(applySharedUpdate(shared.a, written(shared.b, shared.a, "b:R1", "+")), { ok: true });
    assert.deepEqual(applySharedUpdate(shared.a, Uint8Array.from(THROWS_WHILE_APPLYING)), { ok: false, reason: "invalid-update" });
    transactSharedDocument(shared.a, "local-command", () => nativeText(shared.a, "b:R2").insert(0, "!"));
    assert.deepEqual(calls, []);
  } finally { performance.mark = real; stop(); replica.dispose(); shared.close(); }
});
