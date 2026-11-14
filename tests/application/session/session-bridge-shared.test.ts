import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { startDocumentGuard } from "../../../src/application/identity/document-guard.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { ChangeSet, SessionChange } from "../../../src/application/session/change-set.ts";
import type { CommandOutcome, Replay, SessionCounters, Stamp } from "../../../src/application/session/document-session.ts";
import type { SessionReplayRunner } from "../../../src/bootstrap/wiring/session-owner.ts";
import { createSharedSession } from "../../../src/application/session/shared-session.ts";
import type { SharedDocumentSession } from "../../../src/application/session/shared-session.ts";
import type { CapabilityPort } from "../../../src/application/session/ports.ts";
import type { RecordsReconciler } from "../../../src/application/production/broll-records.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import {
  adoptReplacement, adoptShared, currentCapabilities, currentDocument, heldDocument, liveSession, onDocumentReplaced,
  onSessionChange, runCommand, sharedRecoverySession, sharedSession, standaloneSession, startSessionBridge
} from "../../../src/bootstrap/wiring/session-owner.ts";
import type { SharedOwnerPorts } from "../../../src/bootstrap/wiring/session-owner.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeClock } from "../session-fakes.ts";
import { fakeReplica, sharedCommand } from "./shared-session-support.ts";
import type { FakeReplica } from "./shared-session-support.ts";

const LENGTH = readOperation({ kind: "scalar", id: "o1", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });

const REFUSED = "standalone only while the session is shared: ";

function projection(title: string): Record<string, unknown> {
  return {
    schema: 2, title, docId: "d1", rev: 0,
    rows: [{ id: "R1", status: "todo", audioText: "ab" }],
    sections: [{ id: "H1", name: " One ", firstSceneId: "R1" }],
    comments: [], people: [], productionTags: [], brollShots: []
  };
}

function capabilities(mode: "standalone" | "shared", reason: string | null = null): CapabilityPort {
  const can = () => reason === null ? { allowed: true as const } : { allowed: false as const, reason };
  return createSessionCapabilities(mode, { edit: can, comment: can });
}

interface Bridge {
  readonly stop: () => void;
  readonly resynced: { doc: unknown; changes: ChangeSet | undefined }[];
  readonly heard: SessionChange["kind"][];
  readonly replaced: () => number;
  readonly route: () => { run: SessionReplayRunner; amend: SessionReplayRunner };
  readonly migration: ReturnType<typeof fakeMigration>;
}

function start(): Bridge {
  const migration = fakeMigration();
  const resynced: Bridge["resynced"] = [];
  const heard: Bridge["heard"] = [];
  let replaced = 0;
  let route: { run: SessionReplayRunner; amend: SessionReplayRunner } | null = null;
  const records: RecordsReconciler = Object.assign(() => null, { resync: (doc: ValidatedDocument | null, changes?: ChangeSet) => { resynced.push({ doc, changes }); } });
  const stopGuard = startDocumentGuard(false, () => {});
  const stopSession = startSessionBridge({
    entry: raw => migrateRows(raw, migration.ports),
    undo: {
      adapter: { adopt: () => {}, record: () => {}, absorbDisk: () => {}, absorbReload: () => {} },
      route: (run, _stamps, amend) => { route = { run, amend }; return () => { route = null; }; }
    },
    effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: () => {} },
    capability: capabilities("standalone"),
    editor: { name: () => "Ada" },
    records,
    attribution: { attribute: () => null },
    report: error => { throw error; },
    timers: fakeClock()
  });
  const stopHeard = onSessionChange(change => { heard.push(change.kind); });
  const stopReplaced = onDocumentReplaced(() => { replaced++; });
  standaloneSession().adopt(projection("Local"));
  const titled = runCommand({ name: "title", needs: "edit", plan: () => ({ changes: changeSet({ docFields: ["title"] }), apply: live => { live.title = "Local 2"; } }) });
  assert.equal(titled.kind, "applied");
  return {
    stop: () => { try { stopReplaced(); stopHeard(); stopSession(); } finally { stopGuard(); } },
    resynced, heard, migration,
    replaced: () => replaced,
    route: () => { if (!route) throw new Error("no route"); return route; }
  };
}

interface Entered {
  readonly replica: FakeReplica;
  readonly given: () => SharedOwnerPorts;
  readonly owner: () => SharedDocumentSession;
}

function enter(replica: FakeReplica = fakeReplica()): Entered {
  let given: SharedOwnerPorts | null = null;
  let owner: SharedDocumentSession | null = null;
  adoptShared(ports => {
    given = ports;
    owner = createSharedSession({
      replica: replica.port, entry: ports.entry, undo: { record: () => {} },
      effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: () => {} },
      capability: ports.capability, report: error => { throw error; }, timers: fakeClock(), after: ports.after
    });
    return owner;
  }, capabilities("shared"));
  return {
    replica,
    given: () => { if (!given) throw new Error("not built"); return given; },
    owner: () => { if (!owner) throw new Error("not built"); return owner; }
  };
}

function hydrated(made: Bridge): Entered {
  const entered = enter();
  entered.replica.write("hydration", projection("Shared"));
  assert.equal(made.heard.at(-1), "adopt");
  return entered;
}

const counters = (): SessionCounters => ({ epoch: liveSession().epoch(), generation: liveSession().generation() });

test("C9: the read-only recovery accessor is null before start, in standalone and after stop, and follows the shared owner", () => {
  assert.equal(sharedRecoverySession(), null);
  const made = start();
  try {
    assert.equal(sharedRecoverySession(), null);
    const entered = hydrated(made), reader = sharedRecoverySession();
    assert.equal(reader, entered.owner()); assert.deepEqual(reader?.recovery(), []);
    let heard = 0;
    const off = reader?.subscribe(() => { heard++; });
    entered.replica.write("remote", projection("Changed"));
    assert.equal(heard, 1); off?.();
    entered.replica.write("remote", projection("Changed again")); assert.equal(heard, 1);
    adoptReplacement(migrateRows(projection("Left"), made.migration.ports), capabilities("standalone"));
    assert.equal(sharedRecoverySession(), null);
    const next = hydrated(made); assert.equal(sharedRecoverySession(), next.owner()); assert.notEqual(sharedRecoverySession(), reader);
  } finally { made.stop(); }
  assert.equal(sharedRecoverySession(), null);
});

test("D3, D37: entering builds the shared owner with the old owner's counters and the captured shared capabilities, then hydration opens a new epoch the app hears", () => {
  const made = start();
  try {
    assert.deepEqual(counters(), { epoch: 1, generation: 1 });
    const entered = enter();
    assert.deepEqual(entered.given().after, { epoch: 1, generation: 1 });
    assert.equal(entered.given().capability, currentCapabilities());
    assert.deepEqual([sharedSession(), made.replaced(), currentDocument()], [true, 1, null]);
    entered.replica.write("hydration", projection("Shared"));
    assert.deepEqual(made.heard, ["adopt", "edit", "adopt"]);
    assert.deepEqual(counters(), { epoch: 2, generation: 1 });
    assert.equal(currentDocument()?.title, "Shared");
    assert.deepEqual(currentDocument()?.sections, [{ id: "H1", name: " One ", firstSceneId: "R1" }]);
  } finally { made.stop(); }
});

test("D3: the shared capabilities answer once entered, and an edit through the bridge goes to the replica", () => {
  const made = start();
  try {
    const entered = hydrated(made);
    assert.equal(currentCapabilities().edit().allowed, true);
    assert.ok(LENGTH);
    let executed = 0;
    entered.replica.script(() => { executed++; return { ok: true }; });
    const outcome = runCommand(sharedCommand("noop-edit", [LENGTH]));
    assert.deepEqual([executed, outcome.kind], [1, "noop"]);
  } finally { made.stop(); }
});

test("D3: an owner already holding a document is refused by name and the standalone owner stays", () => {
  const made = start();
  try {
    const replica = fakeReplica(projection("Early"));
    assert.throws(() => enter(replica), /^Error: A shared owner is adopted before it is hydrated, so the app hears its first document$/);
    assert.deepEqual([sharedSession(), replica.observers(), currentDocument()?.title, made.replaced()], [false, 0, "Local 2", 0]);
  } finally { made.stop(); }
});

test("D3: entering twice is refused by name", () => {
  const made = start();
  try {
    hydrated(made);
    assert.throws(() => enter(), /^Error: The document session is shared already$/);
    assert.equal(currentDocument()?.title, "Shared");
  } finally { made.stop(); }
});

const STANDALONE_MEMBERS: readonly [string, () => unknown][] = [
  ["held", () => standaloneSession().held()],
  ["adopt", () => standaloneSession().adopt(projection("Other"))],
  ["absorbDisk", () => standaloneSession().absorbDisk(projection("Other"))],
  ["absorbRecovery", () => standaloneSession().absorbRecovery(projection("Other"))],
  ["absorbMerged", () => standaloneSession().absorbMerged("disk", null)],
  ["absorbReload", () => standaloneSession().absorbReload({ title: "Other", rows: [] })],
  ["settle", () => standaloneSession().settle("disk")],
  ["noteEdit", () => standaloneSession().noteEdit()]
];

for (const [member, call] of STANDALONE_MEMBERS) {
  test(`D6: the bridge's ${member} refuses by name while the owner is shared and changes nothing`, () => {
    const made = start();
    try {
      hydrated(made);
      const before = counters();
      assert.throws(call, new RegExp("^Error: " + REFUSED + member + "$"));
      assert.deepEqual([counters(), currentDocument()?.title, made.heard.length], [before, "Shared", 3]);
    } finally { made.stop(); }
  });
}

test("D6: the bridge function heldDocument refuses by name while the owner is shared", () => {
  const made = start();
  try {
    hydrated(made);
    assert.throws(() => heldDocument(), /^Error: standalone only while the session is shared: held$/);
  } finally { made.stop(); }
});

function replayTask(planned: string[]): Replay & Stamp {
  return { name: "replay", plan: () => { planned.push("planned"); return null; } };
}

const OUTCOME_MEMBERS: readonly [string, (task: Replay & Stamp) => CommandOutcome][] = [
  ["replay", task => standaloneSession().replay(task)],
  ["amend", task => standaloneSession().amend(task)],
  ["stamp", task => standaloneSession().stamp(task)]
];

for (const [member, call] of OUTCOME_MEMBERS) {
  test(`D6: the bridge's ${member} refuses by name with a rejected outcome while the owner is shared, without planning`, () => {
    const made = start();
    try {
      hydrated(made);
      const planned: string[] = [];
      assert.deepEqual(call(replayTask(planned)), { kind: "rejected", reason: REFUSED + member });
      assert.deepEqual([planned, counters()], [[], { epoch: 2, generation: 1 }]);
    } finally { made.stop(); }
  });
}

for (const member of ["replay", "amend"] as const) {
  test(`D6: the undo route checks the owner's kind and refuses ${member} by name while shared, without planning`, () => {
    const made = start();
    try {
      hydrated(made);
      const planned: string[] = [];
      assert.deepEqual(made.route()[member === "replay" ? "run" : "amend"](replayTask(planned)), { kind: "rejected", reason: REFUSED + member });
      assert.deepEqual(planned, []);
    } finally { made.stop(); }
  });
}

test("D6: the undo route still replays on a standalone owner", () => {
  const made = start();
  try {
    const planned: string[] = [];
    assert.deepEqual(made.route().run(replayTask(planned)), { kind: "noop" });
    assert.deepEqual(planned, ["planned"]);
  } finally { made.stop(); }
});

test("D36: a shared owner's changes never resync the b-roll records, and leaving resyncs them with the whole standalone document", () => {
  const made = start();
  try {
    const entered = hydrated(made);
    const before = made.resynced.length;
    entered.replica.write("remote", { ...projection("Shared"), title: "Remote" });
    assert.equal(currentDocument()?.title, "Remote");
    assert.equal(made.resynced.length, before);
    adoptReplacement(migrateRows(projection("Left"), made.migration.ports), capabilities("standalone"));
    const last = made.resynced.at(-1);
    assert.equal(made.resynced.length, before + 1);
    assert.equal((last?.doc as { title?: string } | null)?.title, "Left");
    assert.equal(last?.changes?.whole, true);
  } finally { made.stop(); }
});

test("D3, D37: leaving without the standalone capabilities is refused by name; with them the standalone owner takes the shared owner's counters", () => {
  const made = start();
  try {
    const entered = hydrated(made);
    const left = migrateRows(projection("Left"), made.migration.ports);
    assert.throws(() => adoptReplacement(left), /^Error: Leaving a shared session takes the standalone capabilities$/);
    assert.deepEqual([sharedSession(), currentDocument()?.title], [true, "Shared"]);
    const standalone = capabilities("standalone", "read only");
    adoptReplacement(left, standalone);
    assert.deepEqual([sharedSession(), counters(), currentDocument()?.title, made.replaced()], [false, { epoch: 3, generation: 1 }, "Left", 2]);
    assert.deepEqual(currentCapabilities().edit(), { allowed: false, reason: "read only" });
    assert.equal(entered.replica.observers(), 0);
    assert.equal(standaloneSession().held()?.title, "Left");
  } finally { made.stop(); }
});

test("assumed rule 4: entering is refused by name once the session has ended, and nothing is built", () => {
  const made = start();
  try {
    liveSession().dispose();
    let built = 0;
    assert.throws(() => adoptShared(() => { built++; throw new Error("built"); }, capabilities("shared")), /^Error: The document session has ended$/);
    assert.deepEqual([built, sharedSession(), made.replaced()], [0, false, 0]);
  } finally { made.stop(); }
});

test("D36: enter, leave and enter again: each app listener hears every later change once, and no disposed owner still tells it anything", () => {
  const made = start();
  try {
    const first = hydrated(made);
    adoptReplacement(migrateRows(projection("Left"), made.migration.ports), capabilities("standalone"));
    const second = hydrated(made);
    second.replica.write("remote", { ...projection("Shared"), title: "Again" });
    assert.deepEqual(made.heard, ["adopt", "edit", "adopt", "adopt", "adopt", "remote"]);
    first.replica.write("remote", { ...projection("Shared"), title: "Stale" });
    assert.deepEqual([made.heard.length, first.replica.observers(), second.replica.observers(), currentDocument()?.title], [6, 0, 1, "Again"]);
  } finally { made.stop(); }
});
