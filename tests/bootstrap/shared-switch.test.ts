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
  currentCapabilities, currentDocument, holdMergeBase, mergeBase, runCommand, sharedSession, standaloneSession, startSessionBridge
} from "../../src/bootstrap/wiring/session-owner.ts";
import { routeUndoReplays, sharedUndoRoute, startUndo, stepSharedUndo, undoOwner, undoPorts, undoSessionPort } from "../../src/bootstrap/wiring/undo.ts";
import {
  enterSharedSession, leaveSharedSession, sharedSessionParts, SHARED_ALREADY, SHARED_HYDRATION_FAILED, SHARED_NOT_RUNNING
} from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedSessionParts, SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { createFlowLoadRuntime } from "../core/flow/load.ts";
import { fakeClock } from "../application/session-fakes.ts";

const CAN = { edit: () => ({ allowed: true as const }), comment: () => ({ allowed: true as const }) };
const START_ID = "d" + "1".repeat(32), newId = (n: number): string => "d" + String(n).padStart(32, "0");
const source = (): Record<string, unknown> => ({ docId: START_ID, title: "Pilot", rows: [{ id: "R1", audioText: "ab", lengthSeconds: 3 }] });

interface Switch {
  readonly ports: SharedSwitchPorts;
  readonly log: string[];
  readonly reported: unknown[];
  readonly entered: () => SharedSessionParts;
  readonly refuse: (reason: string | null) => void;
  readonly hold: (reason: string | null) => void;
  readonly failHydration: () => void;
  readonly onSettle: (run: () => void) => void;
  readonly onMigrate: (run: (raw: Record<string, unknown>) => void) => void;
  readonly stop: () => void;
}

function start(): Switch {
  const migration = fakeMigration();
  const log: string[] = [], reported: unknown[] = [];
  let refusal: string | null = null, held: string | null = null, failing = false, ids = 0;
  let settleHook: () => void = () => {}, migrateHook: (raw: Record<string, unknown>) => void = () => {};
  let parts: SharedSessionParts | null = null;
  const stops = [startDocumentGuard(false, error => { throw error; }), startUndo(undoPorts())];
  stops.push(startSessionBridge({
    entry: raw => migrateRows(raw, migration.ports),
    undo: { adapter: undoSessionPort(), route: routeUndoReplays },
    effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: () => {} },
    capability: createSessionCapabilities("standalone", CAN), editor: { name: () => "Ada" }, records: () => null,
    attribution: { attribute: () => null }, report: error => { throw error; }, timers: fakeClock()
  }));
  standaloneSession().adopt(source());
  const ports: SharedSwitchPorts = {
    refusal: () => refusal,
    settle: () => { log.push("settle"); settleHook(); },
    detach: () => { log.push("detach"); },
    bindings: {
      enter: given => { parts = given; log.push("bindings.enter:" + String(currentDocument() === null)); },
      settle: () => held,
      leave: () => { log.push("bindings.leave:" + String(sharedSession())); }
    },
    common: CAN,
    standalone: createSessionCapabilities("standalone", { edit: () => ({ allowed: false, reason: "left" }), comment: CAN.comment }),
    migrate: raw => {
      const fields = raw as Record<string, unknown>;
      migrateHook(fields);
      if (failing && String(fields["docId"]).startsWith("d000")) throw new Error("hydration copy refused");
      return migrateRows(raw, migration.ports);
    },
    docId: () => newId(++ids),
    editor: () => "Ada",
    structure: { cells: createFlowLoadRuntime().cells },
    report: error => { reported.push(error); },
    timers: fakeClock(),
    now: () => 0
  };
  return {
    ports, log, reported,
    entered: () => { assert.ok(parts); return parts; },
    refuse: reason => { refusal = reason; },
    hold: reason => { held = reason; },
    failHydration: () => { failing = true; },
    onSettle: run => { settleHook = run; },
    onMigrate: run => { migrateHook = run; },
    stop: () => {
      try { if (sharedSessionParts()) leaveSharedSession(ports); } finally { while (stops.length) stops.pop()?.(); }
    }
  };
}

function lengthCommand(): Command {
  const operation = readOperation({ kind: "scalar", id: "len1", by: "Ada", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });
  assert.ok(operation);
  return { name: "length", needs: "edit", plan: () => ({ changes: changeSet({ cells: [{ rowId: "R1", field: "lengthSeconds" }] }),
    apply: () => { throw new Error("standalone"); }, shared: { operations: [operation] } }) };
}

test("entering settles, waits a microtask, swaps the owner before hydrating, then detaches, clears the standalone undo and the merge base, and hydrates under a new id", async () => {
  const s = start();
  try {
    holdMergeBase(currentDocument());
    assert.equal(runCommand({ name: "title", needs: "edit", plan: () => ({ changes: changeSet({ docFields: ["title"] }), apply: live => { live.title = "Pilot 2"; } }) }).kind, "applied");
    assert.ok(undoOwner().last());
    const lifetime = undoOwner().lifetime();
    const entering = enterSharedSession(s.ports);
    assert.deepEqual([s.log, sharedSession()], [["settle"], false]);
    assert.deepEqual(await entering, { ok: true });
    assert.deepEqual(s.log, ["settle", "detach", "bindings.enter:true"]);
    assert.deepEqual([sharedSession(), currentDocument()?.docId, currentDocument()?.title, currentDocument()?.rows.map(row => row.id)], [true, newId(1), "Pilot 2", ["R1"]]);
    assert.deepEqual([mergeBase(), currentCapabilities().edit()], [null, { allowed: true }]);
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
    assert.deepEqual(s.log, ["settle", "detach", "bindings.enter:true"]);
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

test("a failed hydration leaves back to the copy kept before entering, reports the error and routes nothing to the shared owner", async () => {
  const s = start();
  try {
    s.failHydration();
    assert.deepEqual(await enterSharedSession(s.ports), { ok: false, reason: SHARED_HYDRATION_FAILED });
    assert.deepEqual([s.log, sharedSession(), currentDocument()?.docId, currentDocument()?.title, sharedUndoRoute(), sharedSessionParts()],
      [["settle", "detach", "bindings.enter:true", "bindings.leave:true"], false, START_ID, "Pilot", null, null]);
    assert.deepEqual(s.reported.map(error => String(error)), ["Error: hydration copy refused"]);
    assert.equal(s.entered().author.next(), null);
  } finally { s.stop(); }
});

test("Ctrl+Z while shared reaches the shared undo owner: a shared command is recorded and undone", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
    assert.equal(runCommand(lengthCommand()).kind, "applied");
    assert.deepEqual([currentDocument()?.rows[0]?.lengthSeconds, s.entered().undo.sizes().undo], [7, 1]);
    const route = sharedUndoRoute();
    assert.ok(route);
    const warned: string[] = [];
    assert.equal(stepSharedUndo(route, "undo", message => { warned.push(message); }).ok, true);
    assert.deepEqual([currentDocument()?.rows[0]?.lengthSeconds, s.entered().undo.sizes(), warned], [3, { undo: 0, redo: 1, dropped: 0 }, []]);
  } finally { s.stop(); }
});

test("leaving restarts the bindings and clears the author's handle before the owner swap, then lands a standalone copy under a new id", async () => {
  const s = start();
  try {
    assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
    const parts = s.entered();
    s.hold("buffer-composition");
    assert.deepEqual(leaveSharedSession(s.ports), { ok: false, reason: "buffer-composition" });
    assert.equal(sharedSession(), true);
    s.hold(null);
    const seen: unknown[] = [];
    s.onMigrate(() => { seen.push([sharedSession(), parts.author.next(), s.log.at(-1)]); });
    assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
    assert.deepEqual(seen, [[true, null, "bindings.leave:true"]]);
    assert.deepEqual([sharedSession(), currentDocument()?.docId, currentDocument()?.title, sharedUndoRoute(), sharedSessionParts(), currentCapabilities().edit()],
      [false, newId(2), "Pilot", null, null, { allowed: false, reason: "left" }]);
    assert.deepEqual(leaveSharedSession(s.ports), { ok: false, reason: SHARED_NOT_RUNNING });
  } finally { s.stop(); }
});
