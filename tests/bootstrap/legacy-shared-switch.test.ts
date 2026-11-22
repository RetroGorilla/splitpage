import type { SharedSessionParts } from "./legacy-shared-switch-support.ts";
import { legacySessionParts } from "./legacy-shared-switch-support.ts";
import type { LegacySharedSwitchPorts } from "./legacy-shared-switch-support.ts";
import { enterLegacySharedSession } from "./legacy-shared-switch-support.ts";
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
  currentDocument, onDocumentReplaced, runCommand, sharedSession, standaloneSession, startSessionBridge
} from "../../src/bootstrap/wiring/session-owner.ts";
import { routeUndoReplays, sharedUndoRoute, startUndo, undoOwner, undoPorts, undoSessionPort } from "../../src/bootstrap/wiring/undo.ts";
import {
  leaveSharedSession, SHARED_ENTER_FAILED,
} from "../../src/bootstrap/wiring/shared-session.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { createFlowLoadRuntime } from "../core/flow/load.ts";
import { fakeClock } from "../application/session-fakes.ts";

const CAN = { edit: () => ({ allowed: true as const }), comment: () => ({ allowed: true as const }) };
const START_ID = "d" + "1".repeat(32), newId = (n: number): string => "d" + String(n).padStart(32, "0");
const source = (): Record<string, unknown> => ({ docId: START_ID, title: "Pilot", rows: [{ id: "R1", audioText: "ab", lengthSeconds: 3 }] });

type Fault = "refusal" | "settle" | "docId" | "migrate" | "replaced-while-shared" | "replaced-while-standalone" | "bindings.enter" | "bindings.settle"
  | "bindings.leave" | "hydration" | "detach" | "destroy" | "report" | "bridge entry" | "timers.stop" | "reattach" | "left" | "undo.reset";

interface Switch {
  readonly ports: LegacySharedSwitchPorts;
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
  readonly advance: (ms: number) => void;
  readonly stop: () => void;
}

function start(): Switch {
  const migration = fakeMigration();
  const log: string[] = [], reported: string[] = [], armed = new Set<Fault>();
  let refusal: string | null = null, held: string | null = null, ids = 0;
  let settleHook = (): void => {}, leaveHook = (): void => {}, replacedHook = (): void => {}, docIdHook = (): void => {}, migrateHook = (): void => {};
  let parts: SharedSessionParts | null = null;
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
  const ports: LegacySharedSwitchPorts = {
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
        observeSharedTransactions(given.handle, origin => { if (origin === "hydration") trip("hydration"); });
        collabState(given.handle).doc.on("destroy", () => { trip("destroy"); });
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
    structure: { cells: createFlowLoadRuntime().cells },
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
      try { if (legacySessionParts()) leaveSharedSession(ports); } finally { while (stops.length) stops.pop()?.(); }
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

const state =(): unknown[] => [sharedSession(), sharedUndoRoute() !== null, legacySessionParts() !== null, currentDocument()?.title];

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
  assert.deepEqual(await enterLegacySharedSession(s.ports), { ok: true });
  assert.deepEqual(state(), [true, true, true, title]);
  assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
  assert.deepEqual(state(), [false, false, false, title]);
  assert.deepEqual(await enterLegacySharedSession(s.ports), { ok: true });
  assert.deepEqual(leaveSharedSession(s.ports), { ok: true });
}

const LEAVE_FAULTS_A_LANDED: readonly Fault[] = ["destroy", "report"];

for (const fault of LEAVE_FAULTS_A_LANDED) {
  test(`class ${fault === "report" ? "B" : "A"}, leaving with ${fault === "report" ? "a throwing destroy listener and a throwing report" : "one callback fault at " + fault} after the copy has landed: leaving completes, the shared parts are gone, and the error is reported`, async () => {
    const s = start();
    try {
      assert.deepEqual(await enterLegacySharedSession(s.ports), { ok: true });
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
