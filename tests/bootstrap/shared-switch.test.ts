import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { startDocumentGuard } from "../../src/application/identity/document-guard.ts";
import { createSessionCapabilities } from "../../src/application/session/capabilities.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import type { Command } from "../../src/application/session/document-session.ts";
import { readOperation } from "../../src/core/collab/read-operation.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { observeSharedTransactions } from "../../src/adapters/collab/document.ts";
import {
  currentCapabilities, currentDocument, holdMergeBase, mergeBase, onDocumentReplaced, runCommand, sharedSession, standaloneSession, startSessionBridge
} from "../../src/bootstrap/wiring/session-owner.ts";
import { routeUndoReplays, sharedUndoRoute, startUndo, stepSharedUndo, undoOwner, undoPorts, undoSessionPort } from "../../src/bootstrap/wiring/undo.ts";
import {
  enterSharedSession, leaveSharedSession, sharedSessionParts, SHARED_ALREADY, SHARED_ENTER_FAILED, SHARED_LEAVE_FAILED, SHARED_NOT_RUNNING, SHARED_SWITCHING
} from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedSessionParts, SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { createFlowLoadRuntime } from "../core/flow/load.ts";
import { fakeClock } from "../application/session-fakes.ts";

const CAN = { edit: () => ({ allowed: true as const }), comment: () => ({ allowed: true as const }) };
const START_ID = "d" + "1".repeat(32), newId = (n: number): string => "d" + String(n).padStart(32, "0");
const source = (): Record<string, unknown> => ({ docId: START_ID, title: "Pilot", rows: [{ id: "R1", audioText: "ab", lengthSeconds: 3 }] });

type Fault = "refusal" | "settle" | "docId" | "migrate" | "replaced-while-shared" | "replaced-while-standalone" | "bindings.enter" | "bindings.settle"
  | "bindings.leave" | "hydration" | "detach" | "destroy" | "report" | "bridge entry";

interface Switch {
  readonly ports: SharedSwitchPorts;
  readonly log: string[];
  readonly reported: string[];
  readonly entered: () => SharedSessionParts;
  readonly refuse: (reason: string | null) => void;
  readonly hold: (reason: string | null) => void;
  readonly arm: (...faults: Fault[]) => void;
  readonly onSettle: (run: () => void) => void;
  readonly onLeave: (run: () => void) => void;
  readonly onReplaced: (run: () => void) => void;
  readonly onDocId: (run: () => void) => void;
  readonly onMigrate: (run: () => void) => void;
  readonly stop: () => void;
}

function start(): Switch {
  const migration = fakeMigration();
  const log: string[] = [], reported: string[] = [], armed = new Set<Fault>();
  let refusal: string | null = null, held: string | null = null, ids = 0;
  let settleHook = (): void => {}, leaveHook = (): void => {}, replacedHook = (): void => {}, docIdHook = (): void => {}, migrateHook = (): void => {};
  let parts: SharedSessionParts | null = null;
  const trip = (at: Fault): void => { if (armed.delete(at)) throw new Error("fault at " + at); };
  const stops = [startDocumentGuard(false, error => { throw error; }), startUndo(undoPorts())];
  stops.push(startSessionBridge({
    entry: raw => { trip("bridge entry"); return migrateRows(raw, migration.ports); },
    undo: { adapter: undoSessionPort(), route: routeUndoReplays },
    effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: () => {} },
    capability: createSessionCapabilities("standalone", CAN), editor: { name: () => "Ada" }, records: () => null,
    attribution: { attribute: () => null }, report: error => { throw error; }, timers: fakeClock()
  }));
  const owner = undoOwner(), adopt = owner.adopt;
  Object.assign(owner, { adopt: (doc: Parameters<typeof adopt>[0]) => { if (doc === null) log.push("undo.reset"); adopt(doc); } });
  stops.push(onDocumentReplaced(() => {
    replacedHook();
    trip(sharedSession() ? "replaced-while-shared" : "replaced-while-standalone");
  }));
  standaloneSession().adopt(source());
  const ports: SharedSwitchPorts = {
    refusal: () => { trip("refusal"); return refusal; },
    settle: () => { log.push("settle"); settleHook(); trip("settle"); },
    detach: () => { log.push("detach"); trip("detach"); },
    bindings: {
      enter: given => {
        parts = given;
        log.push("bindings.enter:" + String(currentDocument() === null));
        observeSharedTransactions(given.handle, origin => { if (origin === "hydration") trip("hydration"); });
        collabState(given.handle).doc.on("destroy", () => { trip("destroy"); });
        trip("bindings.enter");
      },
      settle: () => { trip("bindings.settle"); return held; },
      leave: () => { log.push("bindings.leave:" + String(sharedSession())); leaveHook(); trip("bindings.leave"); }
    },
    common: CAN,
    standalone: createSessionCapabilities("standalone", { edit: CAN.edit, comment: () => ({ allowed: false, reason: "left" }) }),
    migrate: raw => { migrateHook(); trip("migrate"); return migrateRows(raw, migration.ports); },
    docId: () => { docIdHook(); trip("docId"); return newId(++ids); },
    editor: () => "Ada",
    structure: { cells: createFlowLoadRuntime().cells },
    report: error => { reported.push(String(error)); trip("report"); },
    timers: fakeClock(),
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
    stop: () => {
      armed.clear();
      try { if (sharedSessionParts()) leaveSharedSession(ports); } finally { while (stops.length) stops.pop()?.(); }
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
const length = (): unknown => currentDocument()?.rows[0]?.["lengthSeconds"];
const state = (): unknown[] => [sharedSession(), sharedUndoRoute() !== null, sharedSessionParts() !== null, currentDocument()?.title];

function standaloneUsable(title = "Again"): void {
  assert.equal(runCommand(titleCommand(title)).kind, "applied");
  assert.ok(undoOwner().last());
}

function sharedGone(parts: SharedSessionParts): void {
  const handle = collabState(parts.handle), observers = (handle.doc as unknown as { readonly _observers: Map<string, unknown> })._observers;
  assert.deepEqual([handle.destroyed, handle.ingress.declineListeners.size, observers.size, parts.author.next(), parts.session.run(lengthCommand()).kind],
    [true, 0, 0, null, "rejected"]);
}

async function roundTrip(s: Switch, title: string): Promise<void> {
  assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
  assert.deepEqual(state(), [true, true, true, title]);
  assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
  assert.deepEqual(state(), [false, false, false, title]);
  assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
  assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
}

test("entering settles, waits a microtask, routes undo before the owner is seen, resets the standalone undo before the bindings, hydrates, and detaches last", async () => {
  const s = start();
  try {
    holdMergeBase(currentDocument());
    assert.equal(runCommand(titleCommand("Pilot 2")).kind, "applied");
    assert.ok(undoOwner().last());
    const lifetime = undoOwner().lifetime();
    const seen: unknown[] = [];
    s.onReplaced(() => { seen.push([sharedSession(), sharedUndoRoute() !== null]); });
    const entering = enterSharedSession(s.ports);
    assert.deepEqual([s.log, sharedSession()], [["settle"], false]);
    assert.deepEqual(await entering, { ok: true });
    assert.deepEqual(s.log, ["settle", "undo.reset", "bindings.enter:true", "detach"]);
    assert.deepEqual(seen, [[true, true]]);
    assert.deepEqual([sharedSession(), currentDocument()?.docId, currentDocument()?.title, mergeBase(), currentCapabilities().edit()], [true, newId(1), "Pilot 2", null, { allowed: true }]);
    assert.equal(s.entered().author.next()?.id, "w" + String(collabState(s.entered().handle).doc.clientID) + "_1");
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.equal(undoOwner().lifetime() - lifetime, 2);
  } finally { s.stop(); }
});

test("each refusal of step 1 changes nothing and settles nothing, and so does entering twice", async () => {
  const s = start();
  try {
    for (const reason of ["startup-not-settled", "composition", "draft-restore-pending"]) {
      s.refuse(reason);
      assert.deepEqual(await enterSharedSession(s.ports), { ok: false, reason });
      assert.deepEqual([s.log, sharedSession(), currentDocument()?.docId], [[], false, START_ID]);
    }
    s.refuse(null);
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
    assert.deepEqual(await enterSharedSession(s.ports), { ok: false, reason: SHARED_ALREADY });
  } finally { s.stop(); }
});

test("a refusal that arises while entering waits for the microtask is honoured after it, with nothing replaced", async () => {
  const s = start();
  try {
    s.onSettle(() => { void Promise.resolve().then(() => { s.refuse("composition"); }); });
    assert.deepEqual(await enterSharedSession(s.ports), { ok: false, reason: "composition" });
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
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
    await new Promise(resolve => { setTimeout(resolve, 0); });
    assert.deepEqual(escaped, []);
  } finally { process.off("unhandledRejection", caught); s.stop(); }
});

test("class A, a replacement listener throwing while the shared owner is adopted is a callback, not a step: entering completes, and the error is reported", async () => {
  const s = start();
  try {
    s.arm("replaced-while-shared");
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
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
      s.arm(fault);
      assert.deepEqual(await enterSharedSession(s.ports), { ok: false, reason: SHARED_ENTER_FAILED });
      assert.deepEqual([state(), currentDocument()?.docId, mergeBase() === base, s.reported[0], currentCapabilities().comment()],
        [[false, false, false, "Pilot"], START_ID, true, "Error: fault at " + fault, { allowed: true }]);
      if (s.log.some(line => line.startsWith("bindings.enter"))) {
        sharedGone(s.entered());
        assert.equal(s.log.at(-1), "bindings.leave:true");
      }
      standaloneUsable();
      await roundTrip(s, "Again");
    } finally { s.stop(); }
  });
}

const ROLLBACK_FAULTS_B: readonly Fault[] = ["bindings.leave", "replaced-while-standalone", "destroy", "report"];

for (const fault of ROLLBACK_FAULTS_B) {
  test(`class B, a failed hydration whose rollback also fails at ${fault}: the kept document is still the standalone document, the first error is reported, and entering works again`, async () => {
    const s = start();
    try {
      s.arm("hydration", fault);
      assert.deepEqual(await enterSharedSession(s.ports), { ok: false, reason: SHARED_ENTER_FAILED });
      assert.deepEqual([sharedSession(), currentDocument()?.docId, currentDocument()?.title, s.reported[0], sharedSessionParts()],
        [false, START_ID, "Pilot", "Error: fault at hydration", null]);
      assert.equal(collabState(s.entered().handle).destroyed, true);
      standaloneUsable();
      await roundTrip(s, "Again");
    } finally { s.stop(); }
  });
}

test("class B, a listener error collected before hydration fails: the step failure is reported first, then the listener error", async () => {
  const s = start();
  try {
    s.arm("replaced-while-shared", "hydration");
    assert.deepEqual(await enterSharedSession(s.ports), { ok: false, reason: SHARED_ENTER_FAILED });
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
      assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
      const parts = s.entered();
      s.log.length = 0;
      s.arm(fault);
      assert.deepEqual(leaveSharedSession(s.ports), { ok: false, reason: SHARED_LEAVE_FAILED });
      assert.deepEqual([state(), s.reported[0], parts.session.admit(), collabState(parts.handle).destroyed], [[true, true, true, "Pilot"], "Error: fault at " + fault, null, false]);
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
  test(`class A, leaving with one callback fault at ${fault} after the copy has landed: leaving completes, the shared parts are gone, and the error is reported`, async () => {
    const s = start();
    try {
      assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
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
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
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
      assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
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
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
    s.onLeave(() => { assert.equal(runCommand(lengthCommand()).kind, "applied"); });
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.equal(length(), 7);
    s.onLeave(() => {});
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
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
      assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
      assert.deepEqual([outcomes[0], length()], [{ kind: "rejected", reason: SHARED_SWITCHING }, 3]);
    } finally { s.stop(); }
  });
}

test("Ctrl+Z while shared reaches the shared undo owner: a shared command is recorded and undone, with no warning", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
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
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
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
