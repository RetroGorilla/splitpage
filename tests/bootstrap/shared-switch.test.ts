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
import {
  currentCapabilities, currentDocument, holdMergeBase, mergeBase, onDocumentReplaced, runCommand, sharedSession, standaloneSession, startSessionBridge
} from "../../src/bootstrap/wiring/session-owner.ts";
import { routeUndoReplays, sharedUndoRoute, startUndo, stepSharedUndo, undoOwner, undoPorts, undoSessionPort } from "../../src/bootstrap/wiring/undo.ts";
import {
  enterSharedSession, leaveSharedSession, sharedSessionParts, SHARED_ALREADY, SHARED_ENTER_FAILED, SHARED_LEAVE_FAILED, SHARED_NOT_RUNNING
} from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedSessionParts, SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { createFlowLoadRuntime } from "../core/flow/load.ts";
import { fakeClock } from "../application/session-fakes.ts";

const CAN = { edit: () => ({ allowed: true as const }), comment: () => ({ allowed: true as const }) };
const START_ID = "d" + "1".repeat(32), newId = (n: number): string => "d" + String(n).padStart(32, "0");
const source = (): Record<string, unknown> => ({ docId: START_ID, title: "Pilot", rows: [{ id: "R1", audioText: "ab", lengthSeconds: 3 }] });

type Fault = "replaced-while-shared" | "replaced-while-standalone" | "bindings.enter" | "bindings.leave" | "hydration copy" | "leaving copy" | "detach";

interface Switch {
  readonly ports: SharedSwitchPorts;
  readonly log: string[];
  readonly reported: string[];
  readonly entered: () => SharedSessionParts;
  readonly refuse: (reason: string | null) => void;
  readonly hold: (reason: string | null) => void;
  readonly fault: (fault: Fault | null) => void;
  readonly onSettle: (run: () => void) => void;
  readonly onLeave: (run: () => void) => void;
  readonly onReplaced: (run: () => void) => void;
  readonly stop: () => void;
}

function start(): Switch {
  const migration = fakeMigration();
  const log: string[] = [], reported: string[] = [];
  let refusal: string | null = null, held: string | null = null, fault: Fault | null = null, ids = 0, bound = false;
  let settleHook: () => void = () => {}, leaveHook: () => void = () => {}, replacedHook: () => void = () => {};
  let parts: SharedSessionParts | null = null;
  const trip = (at: Fault): void => { if (fault === at) throw new Error("fault at " + at); };
  const stops = [startDocumentGuard(false, error => { throw error; }), startUndo(undoPorts())];
  stops.push(startSessionBridge({
    entry: raw => migrateRows(raw, migration.ports),
    undo: { adapter: undoSessionPort(), route: routeUndoReplays },
    effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: () => {} },
    capability: createSessionCapabilities("standalone", CAN), editor: { name: () => "Ada" }, records: () => null,
    attribution: { attribute: () => null }, report: error => { throw error; }, timers: fakeClock()
  }));
  const owner = undoOwner(), adopt = owner.adopt;
  Object.assign(owner, { adopt: (doc: Parameters<typeof adopt>[0]) => { if (doc === null) log.push("undo.reset"); adopt(doc); } });
  stops.push(onDocumentReplaced(() => {
    replacedHook();
    if (sharedSession()) trip("replaced-while-shared"); else trip("replaced-while-standalone");
  }));
  standaloneSession().adopt(source());
  const ports: SharedSwitchPorts = {
    refusal: () => refusal,
    settle: () => { log.push("settle"); settleHook(); },
    detach: () => { log.push("detach"); trip("detach"); },
    bindings: {
      enter: given => { parts = given; bound = true; log.push("bindings.enter:" + String(currentDocument() === null)); trip("bindings.enter"); },
      settle: () => held,
      leave: () => { bound = false; log.push("bindings.leave:" + String(sharedSession())); leaveHook(); trip("bindings.leave"); }
    },
    common: CAN,
    standalone: createSessionCapabilities("standalone", { edit: CAN.edit, comment: () => ({ allowed: false, reason: "left" }) }),
    migrate: raw => {
      const id = String((raw as Record<string, unknown>)["docId"]);
      if (id.startsWith("d000")) trip(bound ? "hydration copy" : "leaving copy");
      return migrateRows(raw, migration.ports);
    },
    docId: () => newId(++ids),
    editor: () => "Ada",
    structure: { cells: createFlowLoadRuntime().cells },
    report: error => { reported.push(String(error)); },
    timers: fakeClock(),
    now: () => 0
  };
  return {
    ports, log, reported,
    entered: () => { assert.ok(parts); return parts; },
    refuse: reason => { refusal = reason; },
    hold: reason => { held = reason; },
    fault: value => { fault = value; },
    onSettle: run => { settleHook = run; },
    onLeave: run => { leaveHook = run; },
    onReplaced: run => { replacedHook = run; },
    stop: () => {
      fault = null;
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

const length = (): unknown => currentDocument()?.rows[0]?.["lengthSeconds"];
const state = (): unknown[] => [sharedSession(), sharedUndoRoute() !== null, sharedSessionParts() !== null, currentDocument()?.title];

function standaloneUsable(): void {
  assert.equal(runCommand({ name: "title", needs: "edit", plan: () => ({ changes: changeSet({ docFields: ["title"] }), apply: live => { live.title = "Again"; } }) }).kind, "applied");
  assert.ok(undoOwner().last());
}

test("entering settles, waits a microtask, routes undo before the owner is seen, resets the standalone undo before the bindings, hydrates, and detaches last", async () => {
  const s = start();
  try {
    holdMergeBase(currentDocument());
    const seen: unknown[] = [];
    s.onReplaced(() => { seen.push([sharedSession(), sharedUndoRoute() !== null]); });
    const entering = enterSharedSession(s.ports);
    assert.deepEqual([s.log, sharedSession()], [["settle"], false]);
    assert.deepEqual(await entering, { ok: true });
    assert.deepEqual(s.log, ["settle", "undo.reset", "bindings.enter:true", "detach"]);
    assert.deepEqual(seen, [[true, true]]);
    assert.deepEqual([sharedSession(), currentDocument()?.docId, currentDocument()?.title, mergeBase(), currentCapabilities().edit()], [true, newId(1), "Pilot", null, { allowed: true }]);
    assert.equal(s.entered().author.next()?.id, "w" + String(collabState(s.entered().handle).doc.clientID) + "_1");
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

const ENTER_FAULTS: readonly [Fault, readonly string[]][] = [
  ["replaced-while-shared", ["settle"]],
  ["bindings.enter", ["settle", "undo.reset", "bindings.enter:true", "bindings.leave:true"]],
  ["hydration copy", ["settle", "undo.reset", "bindings.enter:true", "bindings.leave:true"]],
  ["detach", ["settle", "undo.reset", "bindings.enter:true", "detach", "bindings.leave:true"]]
];

for (const [fault, steps] of ENTER_FAULTS) {
  test(`entering with a failure at ${fault} unwinds to the kept copy as standalone, reports it, and entering and leaving work again`, async () => {
    const s = start();
    try {
      const base = currentDocument();
      holdMergeBase(base);
      s.fault(fault);
      assert.deepEqual(await enterSharedSession(s.ports), { ok: false, reason: SHARED_ENTER_FAILED });
      s.fault(null);
      assert.deepEqual([s.log.slice(0, steps.length), state(), currentDocument()?.docId, mergeBase() === base, s.reported],
        [steps, [false, false, false, "Pilot"], START_ID, true, ["Error: fault at " + fault]]);
      if (fault !== "replaced-while-shared") assert.equal(s.entered().author.next(), null);
      standaloneUsable();
      assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
      assert.deepEqual(state(), [true, true, true, "Again"]);
      assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
      assert.deepEqual(state(), [false, false, false, "Again"]);
    } finally { s.stop(); }
  });
}

const LEAVE_FAULTS: readonly Fault[] = ["bindings.leave", "leaving copy"];

for (const fault of LEAVE_FAULTS) {
  test(`leaving with a failure at ${fault} keeps a working shared session with its bindings back, which can be left again`, async () => {
    const s = start();
    try {
      assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
      const parts = s.entered();
      s.log.length = 0;
      s.fault(fault);
      assert.deepEqual(leaveSharedSession(s.ports), { ok: false, reason: SHARED_LEAVE_FAILED });
      s.fault(null);
      assert.deepEqual([s.log, state(), s.reported], [["bindings.leave:true", "bindings.enter:false"], [true, true, true, "Pilot"], ["Error: fault at " + fault]]);
      assert.ok(parts.author.next());
      assert.equal(runCommand(lengthCommand()).kind, "applied");
      assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
      assert.deepEqual([state(), length()], [[false, false, false, "Pilot"], 7]);
      assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
    } finally { s.stop(); }
  });
}

test("a replacement listener failing once the standalone copy has landed still completes leaving and reports the failure", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
    s.fault("replaced-while-standalone");
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    s.fault(null);
    assert.deepEqual([state(), s.reported], [[false, false, false, "Pilot"], ["Error: fault at replaced-while-standalone"]]);
    standaloneUsable();
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
  } finally { s.stop(); }
});

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

test("Ctrl+Z while shared reaches the shared undo owner: a shared command is recorded and undone", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
    assert.equal(runCommand(lengthCommand()).kind, "applied");
    assert.deepEqual([length(), s.entered().undo.sizes().undo], [7, 1]);
    const route = sharedUndoRoute();
    assert.ok(route);
    assert.equal(stepSharedUndo(route, "undo", () => {}).ok, true);
    assert.deepEqual([length(), s.entered().undo.sizes()], [3, { undo: 0, redo: 1, dropped: 0 }]);
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
