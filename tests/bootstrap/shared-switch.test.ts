import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { startDocumentGuard } from "../../src/application/identity/document-guard.ts";
import { createSessionCapabilities } from "../../src/application/session/capabilities.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import type { Command } from "../../src/application/session/document-session.ts";
import { readOperation } from "../../src/core/collab/read-operation.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import {
  currentCapabilities, currentDocument, holdMergeBase, liveSession, mergeBase, sharedRecoverySession, onDocumentReplaced, onRefresh, runCommand, sessionEntryRefusal, sharedSession, standaloneSession, startSessionBridge
} from "../../src/bootstrap/wiring/session-owner.ts";
import { routeUndoReplays, sharedUndoRoute, startUndo, stepSharedUndo, undoOwner, undoPorts, undoSessionPort } from "../../src/bootstrap/wiring/undo.ts";
import {
  enterSharedSession, forceLeaveSharedSession, leaveSharedSession, leaveRunningSharedSession, SHARED_ALREADY, SHARED_ENTER_FAILED,
  SHARED_LEAVE_FAILED, SHARED_NOT_RUNNING, SHARED_SWITCHING
} from "../../src/bootstrap/wiring/shared-session.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { fakeClock } from "../application/session-fakes.ts";
import { fakeReplica } from "../application/session/shared-session-support.ts";
import { createSharedUndo } from "../../src/application/editing/undo/shared-undo.ts";
import { sharedUndoActions } from "../../src/application/editing/undo/shared-undo-actions.ts";
import type { SharedUndo } from "../../src/application/editing/undo/shared-undo.ts";
import type { SharedDocumentSession } from "../../src/application/session/shared-session.ts";
import type { SharedEditorBackend, SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";

interface SwitchParts {
  readonly session: SharedDocumentSession;
  readonly undo: SharedUndo;
  readonly closed: () => boolean;
  readonly observers: () => number;
  readonly author: { readonly next: () => string | null };
}

interface SwitchPorts extends SharedSwitchPorts {
  readonly bindings: {
    readonly enter: (parts: SwitchParts) => void;
    readonly settle: () => string | null;
    readonly leave: () => void;
    readonly abandon?: () => void;
    readonly drop?: () => void;
  };
  readonly fault?: (fault: Fault) => void;
}

const mountedParts = new WeakMap<object, SwitchParts>();

function switchParts(): SwitchParts | null {
  const session = sharedRecoverySession();
  return session ? mountedParts.get(session) ?? null : null;
}

function enterTestSession(ports: SwitchPorts) {
  return enterSharedSession(ports, document => {
    const fake = fakeReplica(), subscriptions = new Set<() => void>();
    let parts: SwitchParts | undefined, live = true, closed = false, serial = 0, length = 3;
    let snapshot: ValidatedDocument = document;
    const setLength = (next: number) => {
      length = next;
      snapshot = { ...snapshot, rows: snapshot.rows.map(row => row.id === "R1" ? { ...row, lengthSeconds: length } : row) };
      fake.write("local-command", snapshot);
    };
    const undo = createSharedUndo({
      now: ports.now,
      supports: kind => kind === "scalar",
      reverse: record => {
        const part = record.parts[0];
        assert.ok(part?.kind === "scalar" && !part.prior.clear && typeof part.prior.value === "number");
        setLength(part.prior.value);
        return { ok: true, effective: true, selection: null, inverse: { ...record, parts: [{ ...part, prior: part.written, written: part.prior }] } };
      }
    });
    fake.script(operations => {
      const operation = operations[0];
      assert.ok(operations.length === 1 && operation?.kind === "scalar" && !operation.clear && typeof operation.value === "number");
      const written = operation.value, prior = length;
      undo.perform(() => {
        setLength(written);
        return { label: "length", parts: [{ kind: "scalar", target: operation.target, field: operation.field, prior: { value: prior }, written: { value: written } }], selection: null, typing: null };
      });
      return { ok: true };
    });
    const backend: SharedEditorBackend = {
      replica: {
        ...fake.port,
        execute: (operations, options) => closed ? { ok: false, reason: "closed" } : fake.port.execute(operations, options),
        observe: listener => {
          const stop = fake.port.observe(listener);
          subscriptions.add(stop);
          return () => { subscriptions.delete(stop); stop(); };
        }
      },
      undo: admission => ({ actions: sharedUndoActions(admission, undo), breakGroup: undo.breakGroup }),
      bind: session => {
        parts ??= { session, undo, closed: () => closed, observers: fake.observers, author: { next: () => live ? "test-writer_" + ++serial : null } };
        mountedParts.set(session, parts);
        ports.bindings.enter(parts);
      },
      unbind: ports.bindings.leave,
      settle: ports.bindings.settle,
      abandon: () => { ports.bindings.abandon?.(); },
      drop: () => { ports.bindings.drop?.(); },
      start: () => {
        length = Number(snapshot.rows[0]?.lengthSeconds ?? 3);
        fake.write("hydration", snapshot);
        ports.fault?.("hydration");
      },
      landing: currentDocument,
      live: value => { live = value; },
      dispose: report => {
        if (parts) mountedParts.delete(parts.session);
        closed = true;
        for (const stop of subscriptions) stop();
        subscriptions.clear();
        report(() => { ports.fault?.("destroy"); });
      }
    };
    return backend;
  });
}

const CAN = { edit: () => ({ allowed: true as const }), comment: () => ({ allowed: true as const }) };
const START_ID = "d" + "1".repeat(32), newId = (n: number): string => "d" + String(n).padStart(32, "0");
const source = (): Record<string, unknown> => ({ docId: START_ID, title: "Pilot", rows: [{ id: "R1", audioText: "ab", lengthSeconds: 3 }] });

type Fault = "refusal" | "settle" | "docId" | "migrate" | "replaced-while-shared" | "replaced-while-standalone" | "bindings.enter" | "bindings.settle"
  | "bindings.leave" | "hydration" | "detach" | "destroy" | "report" | "bridge entry" | "timers.stop" | "reattach" | "left" | "undo.reset";

interface Switch {
  readonly ports: SwitchPorts;
  readonly log: string[];
  readonly reported: string[];
  readonly entered: () => SwitchParts;
  readonly refuse: (reason: string | null) => void;
  readonly hold: (reason: string | null) => void;
  readonly arm: (...faults: Fault[]) => void;
  readonly onSettle: (run: () => void) => void;
  readonly onLeave: (run: () => void) => void;
  readonly onReplaced: (run: () => void) => void;
  readonly onDocId: (run: () => void) => void;
  readonly onMigrate: (run: () => void) => void;
  readonly advance: (ms: number) => void;
  readonly stop: () => void;
}

function start(): Switch {
  const migration = fakeMigration();
  const log: string[] = [], reported: string[] = [], armed = new Set<Fault>();
  let refusal: string | null = null, held: string | null = null, ids = 0;
  let settleHook = (): void => {}, leaveHook = (): void => {}, replacedHook = (): void => {}, docIdHook = (): void => {}, migrateHook = (): void => {};
  let parts: SwitchParts | null = null;
  const trip = (at: Fault): void => { if (armed.delete(at)) throw new Error("fault at " + at); };
  const clock = fakeClock();
  const stops = [startDocumentGuard(false, error => { throw error; }), startUndo(undoPorts())];
  stops.push(startSessionBridge({
    entry: raw => { trip("bridge entry"); return migrateRows(raw, migration.ports); },
    undo: { adapter: undoSessionPort(), route: routeUndoReplays },
    effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: () => {} },
    capability: createSessionCapabilities("standalone", CAN), editor: { name: () => "Ada" }, records: () => null,
    attribution: { attribute: () => null }, report: error => { throw error; }, timers: fakeClock()
  }));
  const owner = undoOwner(), adopt = owner.adopt;
  Object.assign(owner, { adopt: (doc: Parameters<typeof adopt>[0]) => {
    if (doc === null) log.push("undo.reset");
    adopt(doc);
    if (doc === null) trip("undo.reset");
  } });
  stops.push(onDocumentReplaced(() => {
    replacedHook();
    trip(sharedSession() ? "replaced-while-shared" : "replaced-while-standalone");
  }));
  standaloneSession().adopt(source());
  const ports: SwitchPorts = {
    opening: { openingPending: () => false },
    refusal: () => { trip("refusal"); return refusal; },
    commandRefused: undefined,
    settle: () => { log.push("settle"); settleHook(); trip("settle"); },
    detach: () => { log.push("detach"); trip("detach"); },
    reattach: () => { log.push("reattach"); trip("reattach"); },
    left: landed => { log.push("left:" + String(landed)); trip("left"); },
    bindings: {
      enter: given => {
        parts = given;
        log.push("bindings.enter:" + String(currentDocument() === null));
        trip("bindings.enter");
      },
      settle: () => { trip("bindings.settle"); return held; },
      abandon: () => { log.push("bindings.abandon"); if (held === "buffer-composition") held = null; },
      drop: () => { log.push("bindings.drop"); },
      leave: () => { log.push("bindings.leave:" + String(sharedSession())); leaveHook(); trip("bindings.leave"); }
    },
    common: CAN,
    standalone: createSessionCapabilities("standalone", { edit: CAN.edit, comment: () => ({ allowed: false, reason: "left" }) }),
    migrate: raw => { migrateHook(); trip("migrate"); return migrateRows(raw, migration.ports); },
    docId: () => { docIdHook(); trip("docId"); return newId(++ids); },
    editor: () => "Ada",
    fault: trip,
    report: error => { reported.push(String(error)); trip("report"); },
    timers: { now: clock.now, start: clock.start, stop: handle => { trip("timers.stop"); clock.stop(handle); } },
    now: () => 0
  };
  return {
    ports, log, reported,
    entered: () => { assert.ok(parts); return parts; },
    refuse: reason => { refusal = reason; },
    hold: reason => { held = reason; },
    arm: (...faults) => { faults.forEach(fault => armed.add(fault)); },
    onSettle: run => { settleHook = run; },
    onLeave: run => { leaveHook = run; },
    onReplaced: run => { replacedHook = run; },
    onDocId: run => { docIdHook = run; },
    onMigrate: run => { migrateHook = run; },
    advance: ms => { clock.advance(ms); },
    stop: () => {
      armed.clear();
      try { if (switchParts()) leaveSharedSession(ports); } finally { while (stops.length) stops.pop()?.(); }
    }
  };
}

function lengthCommand(value = 7): Command {
  const operation = readOperation({ kind: "scalar", id: "len" + String(value), by: "Ada", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value });
  assert.ok(operation);
  return { name: "length", needs: "edit", plan: () => ({ changes: changeSet({ cells: [{ rowId: "R1", field: "lengthSeconds" }] }),
    apply: () => { throw new Error("standalone"); }, shared: { operations: [operation] } }) };
}

const titleCommand = (title: string): Command => ({ name: "title", needs: "edit", plan: () => ({ changes: changeSet({ docFields: ["title"] }), apply: live => { live.title = title; } }) });
const textCommand = (text: string): Command => ({ name: "text", needs: "edit", plan: () => ({ changes: changeSet({ cells: [{ rowId: "R1", field: "audioText" }] }),
  apply: live => { const row = live.rows[0]; if (row) row.audioText = text; } }) });
const length = (): unknown => currentDocument()?.rows[0]?.["lengthSeconds"];

test("command refusals reach the supplied callback once while entry refusal is consulted only on entry", async () => {
  const s = start(), refusals: string[] = [];
  let entries = 0;
  const ports: SwitchPorts = { ...s.ports,
    refusal: () => { entries++; return s.ports.refusal(); },
    commandRefused: reason => { refusals.push(reason); }
  };
  try {
    assert.deepEqual(await enterTestSession(ports), { ok: true });
    assert.equal(entries, 2);
    assert.deepEqual(s.entered().session.run({ name: "refused-command", needs: "edit", plan: () => ({ refused: "command-refused" }) }),
      { kind: "rejected", reason: "command-refused", notified: true });
    assert.deepEqual(refusals, ["command-refused"]);
    assert.equal(entries, 2);
    assert.equal(currentDocument()?.title, "Pilot");
    assert.deepEqual(leaveSharedSession(ports), { ok: true });
    assert.equal(entries, 2);
  } finally { s.stop(); }
});

const state =(): unknown[] => [sharedSession(), sharedUndoRoute() !== null, switchParts() !== null, currentDocument()?.title];

function standaloneUsable(title = "Again"): void {
  assert.equal(runCommand(titleCommand(title)).kind, "applied");
  assert.ok(undoOwner().last());
}

function sharedGone(parts: SwitchParts): void {
  assert.deepEqual([parts.closed(), parts.observers(), parts.author.next(), parts.session.run(lengthCommand()).kind], [true, 0, null, "rejected"]);
}

test("C8 a nested switch refuses through the same entry hold and cannot replace its scope", async () => {
  const s = start(); let nested: Promise<unknown> | null = null, entered = false;
  s.onSettle(() => { if (!entered) { entered = true; nested = enterTestSession(s.ports); } });
  try {
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    assert.ok(nested); assert.deepEqual(await nested, { ok: false, reason: SHARED_SWITCHING });
    const outcomes: unknown[] = []; let leaving = false;
    s.onLeave(() => { if (!leaving) { leaving = true; outcomes.push(leaveSharedSession(s.ports)); } });
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.deepEqual(outcomes, [{ ok: false, reason: SHARED_SWITCHING }]);
    assert.equal(sessionEntryRefusal(), null);
  } finally { s.stop(); }
});

test("C8 no-argument leave equals the entry-owned explicit leave step for step", async () => {
  const results: unknown[] = [];
  for (const implicit of [false, true]) {
    const s = start();
    try {
      assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: SHARED_NOT_RUNNING });
      assert.deepEqual(await enterTestSession(s.ports), { ok: true });
      s.log.length = 0;
      const result = implicit ? leaveRunningSharedSession() : leaveSharedSession(s.ports);
      results.push([result, [...s.log], currentDocument(), state(), s.reported]);
      assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: SHARED_NOT_RUNNING });
    } finally { s.stop(); }
  }
  assert.deepEqual(results[0], results[1]);
});

test("C8 foreign leave ports cannot replace the mounted bindings or retained migration and identity", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    const wrong = (): never => { assert.fail("foreign switch ports were used"); };
    const foreign: SwitchPorts = { ...s.ports, bindings: { enter: wrong, settle: wrong, leave: wrong }, migrate: wrong, docId: wrong, report: wrong };
    assert.deepEqual(leaveSharedSession(foreign), { ok: true });
    assert.equal(currentDocument()?.docId, newId(2));
  } finally { s.stop(); }
});

test("C8 rolled-back entry and a completed leave with a callback fault retain no running leave", async () => {
  const s = start();
  try {
    s.arm("detach");
    assert.deepEqual(await enterTestSession(s.ports), { ok: false, reason: SHARED_ENTER_FAILED });
    assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: SHARED_NOT_RUNNING });
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    s.arm("destroy");
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: SHARED_NOT_RUNNING });
  } finally { s.stop(); }
});

test("C8 a later shared session leaves through its own ports", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    let settled = 0, left = 0;
    const next: SwitchPorts = { ...s.ports, bindings: { enter: () => {}, settle: () => { settled++; return null; }, leave: () => { left++; } }, docId: () => newId(99) };
    assert.deepEqual(await enterTestSession(next), { ok: true });
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    assert.deepEqual([settled, left, currentDocument()?.docId], [1, 1, newId(99)]);
  } finally { s.stop(); }
});

async function roundTrip(s: Switch, title: string): Promise<void> {
  assert.deepEqual(await enterTestSession(s.ports), { ok: true });
  assert.deepEqual(state(), [true, true, true, title]);
  assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
  assert.deepEqual(state(), [false, false, false, title]);
  assert.deepEqual(await enterTestSession(s.ports), { ok: true });
  assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
}

test("entering settles, waits a microtask, routes undo before the owner is seen, hydrates, detaches, and resets the standalone undo only once detached", async () => {
  const s = start();
  try {
    holdMergeBase(currentDocument());
    assert.equal(runCommand(titleCommand("Pilot 2")).kind, "applied");
    assert.ok(undoOwner().last());
    const lifetime = undoOwner().lifetime();
    const seen: unknown[] = [];
    s.onReplaced(() => { seen.push([sharedSession(), sharedUndoRoute() !== null]); });
    const entering = enterTestSession(s.ports);
    assert.deepEqual([s.log, sharedSession()], [["settle"], false]);
    assert.deepEqual(await entering, { ok: true });
    assert.deepEqual(s.log, ["settle", "bindings.enter:true", "detach", "undo.reset"]);
    assert.deepEqual(seen, [[true, true]]);
    assert.deepEqual([sharedSession(), currentDocument()?.docId, currentDocument()?.title, mergeBase(), currentCapabilities().edit()], [true, newId(1), "Pilot 2", null, { allowed: true }]);
    assert.equal(s.entered().author.next(), "test-writer_1");
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.equal(undoOwner().lifetime() - lifetime, 2);
  } finally { s.stop(); }
});

test("each refusal of step 1 changes nothing and settles nothing, and so does entering twice", async () => {
  const s = start();
  try {
    for (const reason of ["startup-not-settled", "composition", "draft-restore-pending"]) {
      s.refuse(reason);
      assert.deepEqual(await enterTestSession(s.ports), { ok: false, reason });
      assert.deepEqual([s.log, sharedSession(), currentDocument()?.docId], [[], false, START_ID]);
    }
    s.refuse(null);
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    assert.deepEqual(await enterTestSession(s.ports), { ok: false, reason: SHARED_ALREADY });
  } finally { s.stop(); }
});

for (const duringSettle of [false, true]) test("C8 opening admission " + (duringSettle ? "appears while settling" : "is pending before entry") + " and writes nothing", async () => {
  const s = start(); let pending = !duringSettle;
  const ports = { ...s.ports, opening: { openingPending: () => pending } };
  try {
    if (duringSettle) s.onSettle(() => { pending = true; });
    assert.deepEqual(await enterTestSession(ports), { ok: false, reason: "opening-pending" });
    assert.deepEqual([s.log, sharedSession(), currentDocument()?.docId, switchParts(), s.reported],
      [duringSettle ? ["settle"] : [], false, START_ID, null, []]);
  } finally { s.stop(); }
});

test("a refusal that arises while entering waits for the microtask is honoured after it, with nothing replaced", async () => {
  const s = start();
  try {
    s.onSettle(() => { void Promise.resolve().then(() => { s.refuse("composition"); }); });
    assert.deepEqual(await enterTestSession(s.ports), { ok: false, reason: "composition" });
    assert.deepEqual([s.log, sharedSession(), currentDocument()?.docId], [["settle"], false, START_ID]);
  } finally { s.stop(); }
});

test("a standalone undo note queued while settling flushes before the owner swap, so no rejection escapes", async () => {
  const s = start();
  const escaped: unknown[] = [];
  const caught = (error: unknown): void => { escaped.push(error); };
  process.on("unhandledRejection", caught);
  try {
    s.onSettle(() => { undoOwner().noteEdit(); });
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    await new Promise(resolve => { setTimeout(resolve, 0); });
    assert.deepEqual(escaped, []);
  } finally { process.off("unhandledRejection", caught); s.stop(); }
});

test("class A, a replacement listener throwing while the shared owner is adopted is a callback, not a step: entering completes, and the error is reported", async () => {
  const s = start();
  try {
    s.arm("replaced-while-shared");
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    assert.deepEqual([state(), s.reported], [[true, true, true, "Pilot"], ["Error: fault at replaced-while-shared"]]);
    assert.equal(runCommand(lengthCommand()).kind, "applied");
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.deepEqual([state(), length()], [[false, false, false, "Pilot"], 7]);
    await roundTrip(s, "Pilot");
  } finally { s.stop(); }
});

const ENTER_FAULTS_A: readonly Fault[] = ["refusal", "settle", "docId", "migrate", "bindings.enter", "hydration", "detach"];

for (const fault of ENTER_FAULTS_A) {
  test(`class A, entering with one fault at ${fault}: the kept document is the one standalone session, everything shared is gone, and entering and leaving work again`, async () => {
    const s = start();
    try {
      const base = currentDocument();
      holdMergeBase(base);
      assert.equal(runCommand(textCommand("abc")).kind, "applied");
      undoOwner().flush();
      const history = undoOwner().sizes(), lifetime = undoOwner().lifetime();
      assert.equal(history.undo > 0, true);
      s.arm(fault);
      assert.deepEqual(await enterTestSession(s.ports), { ok: false, reason: SHARED_ENTER_FAILED });
      assert.deepEqual([state(), currentDocument()?.docId, mergeBase() === base, s.reported[0], currentCapabilities().comment()],
        [[false, false, false, "Pilot"], START_ID, true, "Error: fault at " + fault, { allowed: true }]);
      assert.deepEqual([undoOwner().sizes(), undoOwner().lifetime(), s.log.includes("undo.reset")], [history, lifetime, false], "a failed entry keeps the standalone undo history");
      assert.deepEqual(s.log.filter(line => line === "reattach" || line.startsWith("left:")), fault === "detach" ? ["reattach"] : []);
      if (s.log.some(line => line.startsWith("bindings.enter"))) {
        sharedGone(s.entered());
        assert.equal(s.log.filter(line => line !== "reattach").at(-1), "bindings.leave:true");
      }
      standaloneUsable();
      await roundTrip(s, "Again");
    } finally { s.stop(); }
  });
}

test("a standalone undo reset that clears the history and then throws rolls entry back, reattaches, and tracks the standalone copy again for the next edit", async () => {
  const s = start();
  try {
    assert.equal(runCommand(textCommand("abc")).kind, "applied");
    undoOwner().flush();
    s.arm("undo.reset");
    assert.deepEqual(await enterTestSession(s.ports), { ok: false, reason: SHARED_ENTER_FAILED });
    assert.deepEqual([state(), currentDocument()?.docId, s.reported[0], s.log.filter(line => line === "undo.reset" || line === "reattach")],
      [[false, false, false, "Pilot"], START_ID, "Error: fault at undo.reset", ["undo.reset", "reattach"]]);
    const before = undoOwner().sizes().undo;
    assert.equal(runCommand(textCommand("abcd")).kind, "applied");
    undoOwner().flush();
    assert.equal(undoOwner().sizes().undo, before + 1, "the next standalone edit is recorded");
    standaloneUsable();
    await roundTrip(s, "Again");
  } finally { s.stop(); }
});

const ROLLBACK_FAULTS_B: readonly Fault[] = ["bindings.leave", "replaced-while-standalone", "destroy", "report"];

for (const fault of ROLLBACK_FAULTS_B) {
  test(`class B, a failed hydration whose rollback also fails at ${fault}: the kept document is still the standalone document, the first error is reported, and entering works again`, async () => {
    const s = start();
    try {
      s.arm("hydration", fault);
      assert.deepEqual(await enterTestSession(s.ports), { ok: false, reason: SHARED_ENTER_FAILED });
      assert.deepEqual([sharedSession(), currentDocument()?.docId, currentDocument()?.title, s.reported[0], switchParts()],
        [false, START_ID, "Pilot", "Error: fault at hydration", null]);
      assert.equal(s.entered().closed(), true);
      standaloneUsable();
      await roundTrip(s, "Again");
    } finally { s.stop(); }
  });
}

test("class B, a listener error collected before hydration fails: the step failure is reported first, then the listener error", async () => {
  const s = start();
  try {
    s.arm("replaced-while-shared", "hydration");
    assert.deepEqual(await enterTestSession(s.ports), { ok: false, reason: SHARED_ENTER_FAILED });
    assert.deepEqual([s.reported.slice(0, 2), state()], [["Error: fault at hydration", "Error: fault at replaced-while-shared"], [false, false, false, "Pilot"]]);
    standaloneUsable();
    await roundTrip(s, "Again");
  } finally { s.stop(); }
});

const LEAVE_FAULTS_A_KEPT: readonly Fault[] = ["bindings.settle", "bindings.leave", "docId", "migrate", "bridge entry"];

for (const fault of LEAVE_FAULTS_A_KEPT) {
  test(`class A, leaving with one fault at ${fault}: the shared session stays the one session, whole and routed, its bindings back, and it can be left again`, async () => {
    const s = start();
    try {
      assert.deepEqual(await enterTestSession(s.ports), { ok: true });
      const parts = s.entered();
      s.log.length = 0;
      s.arm(fault);
      assert.deepEqual(leaveSharedSession(s.ports), { ok: false, reason: SHARED_LEAVE_FAILED });
      assert.deepEqual([state(), s.reported[0], parts.session.admit(), parts.closed()], [[true, true, true, "Pilot"], "Error: fault at " + fault, null, false]);
      assert.ok(parts.author.next());
      if (fault !== "bindings.settle") assert.equal(s.log.at(-1), "bindings.enter:false");
      assert.equal(runCommand(lengthCommand()).kind, "applied");
      assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
      assert.deepEqual([state(), length()], [[false, false, false, "Pilot"], 7]);
      sharedGone(parts);
      await roundTrip(s, "Pilot");
    } finally { s.stop(); }
  });
}

const LEAVE_FAULTS_A_LANDED: readonly Fault[] = ["replaced-while-standalone", "destroy", "report"];

for (const fault of LEAVE_FAULTS_A_LANDED) {
  test(`class ${fault === "report" ? "B" : "A"}, leaving with ${fault === "report" ? "a throwing destroy listener and a throwing report" : "one callback fault at " + fault} after the copy has landed: leaving completes, the shared parts are gone, and the error is reported`, async () => {
    const s = start();
    try {
      assert.deepEqual(await enterTestSession(s.ports), { ok: true });
      const parts = s.entered();
      assert.equal(runCommand(lengthCommand()).kind, "applied");
      s.arm(fault);
      if (fault === "report") s.arm("destroy");
      assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
      assert.deepEqual([state(), length(), s.reported[0]], [[false, false, false, "Pilot"], 7, "Error: fault at " + (fault === "report" ? "destroy" : fault)]);
      sharedGone(parts);
      standaloneUsable();
      await roundTrip(s, "Again");
    } finally { s.stop(); }
  });
}

test("class B, a failed leave whose restoring bindings also fail: the shared session still holds the document and can be left", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    s.arm("bindings.leave", "bindings.enter");
    assert.deepEqual(leaveSharedSession(s.ports), { ok: false, reason: SHARED_LEAVE_FAILED });
    assert.deepEqual([state(), s.reported[0]], [[true, true, true, "Pilot"], "Error: fault at bindings.leave"]);
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.deepEqual(state(), [false, false, false, "Pilot"]);
  } finally { s.stop(); }
});

for (const where of ["docId", "migrate"] as const) {
  test(`C: a command and an undo issued from inside leaving's ${where} are refused by name, and the landed copy is the captured projection`, async () => {
    const s = start();
    try {
      assert.deepEqual(await enterTestSession(s.ports), { ok: true });
      assert.equal(runCommand(lengthCommand()).kind, "applied");
      const outcomes: unknown[] = [];
      const inside = (): void => {
        outcomes.push(runCommand(lengthCommand(9)));
        const route = sharedUndoRoute();
        if (route) outcomes.push(stepSharedUndo(route, "undo", () => {}));
      };
      if (where === "docId") s.onDocId(inside); else s.onMigrate(inside);
      assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
      assert.deepEqual(outcomes, [{ kind: "rejected", reason: SHARED_SWITCHING }, { ok: false, reason: SHARED_SWITCHING }]);
      assert.deepEqual([state(), length()], [[false, false, false, "Pilot"], 7]);
    } finally { s.stop(); }
  });
}

test("leaving copies the projection after the bindings settle on restart: an edit and an undo accepted then both land", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    s.onLeave(() => { assert.equal(runCommand(lengthCommand()).kind, "applied"); });
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.equal(length(), 7);
    s.onLeave(() => {});
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    assert.equal(runCommand(lengthCommand(9)).kind, "applied");
    s.onLeave(() => { const route = sharedUndoRoute(); assert.ok(route); assert.equal(stepSharedUndo(route, "undo", () => {}).ok, true); });
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.equal(length(), 7);
  } finally { s.stop(); }
});

for (const where of ["docId", "migrate"] as const) {
  test(`C: a command issued from inside entering's ${where} is refused by name, and the shared copy is the kept document`, async () => {
    const s = start();
    try {
      const outcomes: unknown[] = [];
      const inside = (): void => { if (!sharedSession()) outcomes.push(runCommand(lengthCommand(9))); };
      if (where === "docId") s.onDocId(inside); else s.onMigrate(inside);
      assert.deepEqual(await enterTestSession(s.ports), { ok: true });
      assert.deepEqual([outcomes[0], length()], [{ kind: "rejected", reason: SHARED_SWITCHING }, 3]);
    } finally { s.stop(); }
  });
}

test("Ctrl+Z while shared reaches the shared undo owner: a shared command is recorded and undone, with no warning", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    assert.equal(runCommand(lengthCommand()).kind, "applied");
    assert.deepEqual([length(), s.entered().undo.sizes().undo], [7, 1]);
    const route = sharedUndoRoute();
    assert.ok(route);
    const warned: string[] = [];
    assert.equal(stepSharedUndo(route, "undo", message => { warned.push(message); }).ok, true);
    assert.deepEqual([length(), s.entered().undo.sizes(), warned], [3, { undo: 0, redo: 1, dropped: 0 }, []]);
  } finally { s.stop(); }
});

test("leaving restarts the bindings, clears the author's handle before the owner swap and the route after it, and lands a standalone copy under a new id", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    const parts = s.entered();
    s.hold("buffer-composition");
    assert.deepEqual(leaveSharedSession(s.ports), { ok: false, reason: "buffer-composition" });
    assert.equal(sharedSession(), true);
    s.hold(null);
    const seen: unknown[] = [];
    s.onReplaced(() => { seen.push([sharedSession(), parts.author.next(), sharedUndoRoute() !== null, s.log.at(-1)]); });
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.deepEqual(seen, [[false, null, true, "bindings.leave:true"]]);
    assert.deepEqual([state(), currentDocument()?.docId, currentCapabilities().comment()], [[false, false, false, "Pilot"], newId(2), { allowed: false, reason: "left" }]);
    assert.deepEqual(leaveSharedSession(s.ports), { ok: false, reason: SHARED_NOT_RUNNING });
  } finally { s.stop(); }
});

const WAYS_OUT = {
  "the explicit leave": (s: Switch) => leaveSharedSession(s.ports),
  "the no-argument leave of a leave-first entry": () => leaveRunningSharedSession(),
  "a forced leave with nothing pending": () => forceLeaveSharedSession(),
  "a forced leave over an open composition": (s: Switch) => { s.hold("buffer-composition"); return forceLeaveSharedSession(); }
} as const;

for (const [name, leave] of Object.entries(WAYS_OUT)) {
  test(`${name} lands the copy and then runs the boundary's left step once, with nothing shared left`, async () => {
    const s = start();
    try {
      assert.deepEqual(await enterTestSession(s.ports), { ok: true });
      const parts = s.entered();
      assert.equal(runCommand(lengthCommand()).kind, "applied");
      s.log.length = 0;
      let landedAtLeft: unknown = null;
      Object.assign(s.ports, { left: (landed: boolean) => { s.log.push("left:" + String(landed)); landedAtLeft = [sharedSession(), switchParts(), length()]; } });
      assert.deepEqual(leave(s), { ok: true });
      assert.deepEqual(s.log.filter(line => line.startsWith("left:")), ["left:true"]);
      assert.equal(s.log.at(-1), "left:true");
      assert.deepEqual(landedAtLeft, [false, null, 7]);
      assert.equal(s.log.includes("bindings.abandon"), name.includes("composition"));
      sharedGone(parts);
      await roundTrip(s, "Pilot");
    } finally { s.stop(); }
  });
}

test("a forced leave that still cannot land ends the session without a copy: no shared parts, no route, left(false) once, and the reason reported", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    const parts = s.entered();
    s.log.length = 0;
    s.hold("buffer-stuck");
    assert.deepEqual(forceLeaveSharedSession(), { ok: false, reason: "buffer-stuck" });
    assert.deepEqual([switchParts(), sharedUndoRoute(), s.log.filter(line => line.startsWith("left:") || line === "bindings.abandon")],
      [null, null, ["bindings.abandon", "left:false"]]);
    assert.ok(s.log.includes("bindings.leave:true"));
    assert.deepEqual(s.log.filter(line => /^(bindings\.(abandon|drop|leave)|left:)/.test(line)).map(line => line.replace(/^bindings\.leave:.*/, "bindings.leave")).slice(-3),
      ["bindings.drop", "bindings.leave", "left:false"]);
    assert.ok(s.reported.some(text => text.includes("ended without landing a standalone copy: buffer-stuck")));
    sharedGone(parts);
    assert.deepEqual([forceLeaveSharedSession(), leaveRunningSharedSession()], [{ ok: false, reason: SHARED_NOT_RUNNING }, { ok: false, reason: SHARED_NOT_RUNNING }]);
  } finally { s.stop(); }
});

test("entry runs the boundary's preparation after settling and a microtask, before the second refusal; its refusal or its failure changes nothing", async () => {
  for (const outcome of ["refused", "thrown", "passed"] as const) {
    const s = start(), order: string[] = [];
    try {
      let refusals = 0;
      const ports: SwitchPorts = { ...s.ports,
        refusal: () => { refusals++; order.push("refusal"); return null; },
        settle: () => { order.push("settle"); },
        prepare: async () => {
          order.push("prepare");
          if (outcome === "thrown") throw new Error("prepare failed");
          return outcome === "refused" ? "draft-not-kept" : null;
        } };
      const entering = enterTestSession(ports);
      assert.deepEqual(order, ["refusal", "settle"]);
      const result = await entering;
      assert.deepEqual(result, outcome === "passed" ? { ok: true } : { ok: false, reason: outcome === "refused" ? "draft-not-kept" : SHARED_ENTER_FAILED });
      assert.deepEqual(order, outcome === "passed" ? ["refusal", "settle", "prepare", "refusal"] : ["refusal", "settle", "prepare"]);
      assert.equal(refusals, outcome === "passed" ? 2 : 1);
      if (outcome !== "passed") {
        assert.deepEqual([state(), currentDocument()?.docId, s.log.filter(line => line !== "settle")], [[false, false, false, "Pilot"], START_ID, []]);
        if (outcome === "thrown") assert.ok(s.reported.includes("Error: prepare failed"));
      }
    } finally { s.stop(); }
  }
});

test("a failed detach whose reattachment also fails still rolls back, reports the detach first, and entry works again", async () => {
  const s = start();
  try {
    s.arm("detach", "reattach");
    assert.deepEqual(await enterTestSession(s.ports), { ok: false, reason: SHARED_ENTER_FAILED });
    assert.deepEqual([state(), currentDocument()?.docId, s.reported.slice(0, 2)], [[false, false, false, "Pilot"], START_ID, ["Error: fault at detach", "Error: fault at reattach"]]);
    await roundTrip(s, "Pilot");
  } finally { s.stop(); }
});

for (const where of ["docId", "migrate"] as const) {
  test(`C: a standalone undo issued from inside entering's ${where} is refused as session-switching, and the shared copy keeps what was captured`, async () => {
    const s = start();
    try {
      assert.equal(runCommand(titleCommand("Pilot 2")).kind, "applied");
      undoOwner().flush();
      const outcomes: unknown[] = [];
      const inside = (): void => { if (!sharedSession()) outcomes.push(undoOwner().undo()); };
      if (where === "docId") s.onDocId(inside); else s.onMigrate(inside);
      assert.deepEqual(await enterTestSession(s.ports), { ok: true });
      assert.equal(outcomes.length, 1);
      assert.equal((outcomes[0] as { ok?: boolean }).ok, false, JSON.stringify(outcomes[0]));
      assert.deepEqual([currentDocument()?.title, sharedSession()], ["Pilot 2", true]);
    } finally { s.stop(); }
  });
}

test("class A, leaving with a throwing timers.stop: no shared refresh reaches the listeners afterwards, though its timer could not be cancelled", async () => {
  const s = start();
  const heard: string[][] = [];
  const unhear = onRefresh(jobs => { heard.push([...jobs]); });
  try {
    assert.deepEqual(await enterTestSession(s.ports), { ok: true });
    liveSession().refresh("probe");
    s.arm("timers.stop");
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.equal(s.reported[0], "Error: fault at timers.stop");
    s.advance(5000);
    assert.deepEqual([heard, state()], [[], [false, false, false, "Pilot"]]);
    await roundTrip(s, "Pilot");
  } finally { unhear(); s.stop(); }
});
