import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import { SCENE_STATUS_DERIVES, sceneStatus, sceneStatusCommand, shotGrace } from "../../src/application/commands/scene-status.ts";
import type { StampPorts } from "../../src/application/session/ports.ts";
import { harness, rawScript, runConfined } from "./session-fakes.ts";

const STAMP = "2026-10-07T12:00:00.000Z";

function stamps(name = "Adam"): StampPorts {
  return {
    clock: { nowIso: function () { return STAMP; } },
    editor: { name: function () { return name; } }
  };
}

function scripted(): Record<string, unknown> {
  const raw = rawScript("Harbour");
  const rows = raw.rows as Record<string, unknown>[];
  rows.forEach(function (row) { row.updatedAt = "2026-01-01T00:00:00.000Z"; row.updatedBy = "Sam"; });
  return raw;
}

function opened(): ReturnType<typeof harness> {
  const h = harness();
  h.session.adopt(scripted());
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function rowOf(h: ReturnType<typeof harness>, rowId: string): Record<string, unknown> | null {
  return h.session.read(function (doc) {
    const row = doc && doc.rows.find(function (r) { return r.id === rowId; });
    return row ? JSON.parse(JSON.stringify(row)) as Record<string, unknown> : null;
  });
}

function snapshot(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

const STATUS_CHANGES = function (rowId: string) {
  return changeSet({
    cells: [
      { rowId: rowId, field: "status" },
      { rowId: rowId, field: "updatedAt" },
      { rowId: rowId, field: "updatedBy" }
    ],
    derive: ["production"],
    saveNow: true
  });
};

test("E2: a status click is one generation, one undo record and one effect pass, stamped through the clock and editor ports", () => {
  const h = opened();
  const out = runConfined(h.session, sceneStatusCommand("r1", stamps()));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: STATUS_CHANGES("r1") });
  assert.equal(h.session.generation(), 1);
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  const row = rowOf(h, "r1");
  assert.equal(row?.status, "shot");
  assert.equal(row?.updatedAt, STAMP);
  assert.equal(row?.updatedBy, "Adam");
  assert.equal(rowOf(h, "r2")?.updatedAt, "2026-01-01T00:00:00.000Z", "no other scene is stamped");
  assert.equal(rowOf(h, "r2")?.status, "todo", "no other scene changes status");
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0]?.changes.saveNow, true, "the change asks for an immediate save, as the button always did");
  assert.deepEqual(SCENE_STATUS_DERIVES, ["production"], "the production refresh only, no b-roll");
  assert.deepEqual(h.refreshes, []);
  h.clock.advance(180);
  assert.deepEqual(h.refreshes, [["production"]], "production refreshes once, on the idle refresh");
});

test("E2: each click moves to the next status, todo to ready to shot and back to todo, one generation each", () => {
  const h = opened();
  const seen: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    assert.equal(runConfined(h.session, sceneStatusCommand("r2", stamps("Mara"))).kind, "applied");
    seen.push(rowOf(h, "r2")?.status);
  }
  assert.deepEqual(seen, ["ready", "shot", "todo"]);
  assert.equal(h.session.generation(), 3);
  assert.equal(h.log.filter(function (line) { return line === "undo.record"; }).length, 3);
  assert.equal(h.log.filter(function (line) { return line.startsWith("save:"); }).length, 3);
  assert.equal(rowOf(h, "r2")?.updatedBy, "Mara");
  assert.equal(rowOf(h, "r1")?.status, "ready");
});

test("E2: the same command run again plans against the document as it is then", () => {
  const h = opened();
  const command = sceneStatusCommand("r1", stamps());
  assert.equal(runConfined(h.session, command).kind, "applied");
  assert.equal(runConfined(h.session, command).kind, "applied");
  assert.equal(rowOf(h, "r1")?.status, "todo", "ready, then shot, then todo");
});

test("E3: a scene that is gone is a no-op with no effects and no write", () => {
  const h = opened();
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, sceneStatusCommand("gone", stamps())), { kind: "noop" });
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
  assert.equal(h.clock.armed(), 0, "no refresh was scheduled");
  assert.equal(snapshot(h), before, "nothing was written, not even a stamp");
});

test("E3: in review mode the command is refused before it plans, with no effects", () => {
  const h = opened();
  const before = snapshot(h);
  h.deny("review");
  let asked = 0;
  const counting: StampPorts = {
    clock: { nowIso: function () { asked++; return STAMP; } },
    editor: { name: function () { asked++; return "Adam"; } }
  };
  assert.deepEqual(runConfined(h.session, sceneStatusCommand("r1", counting)), { kind: "rejected", reason: "review" });
  assert.deepEqual(runConfined(h.session, sceneStatusCommand("gone", counting)), { kind: "rejected", reason: "review" });
  assert.equal(asked, 0, "the stamp ports are never asked");
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
  assert.equal(h.clock.armed(), 0);
  assert.equal(snapshot(h), before);
});

test("E3: with no document open the command is refused", () => {
  const h = harness();
  assert.deepEqual(runConfined(h.session, sceneStatusCommand("r1", stamps())), { kind: "rejected", reason: NO_DOCUMENT });
  assert.deepEqual(h.log, []);
});

test("E3: a stamp port that throws fails the command and rolls the status back, with no effects", () => {
  const h = opened();
  const before = snapshot(h);
  const broken: StampPorts = {
    clock: { nowIso: function () { return STAMP; } },
    editor: { name: function () { throw new Error("no editor"); } }
  };
  const out = runConfined(h.session, sceneStatusCommand("r1", broken));
  assert.equal(out.kind, "failed");
  assert.equal(out.kind === "failed" && out.error instanceof Error ? out.error.message : "", "no editor");
  const late: StampPorts = {
    clock: { nowIso: function () { throw new Error("no clock"); } },
    editor: { name: function () { return "Adam"; } }
  };
  assert.equal(runConfined(h.session, sceneStatusCommand("r2", late)).kind, "failed");
  assert.equal(snapshot(h), before, "the status and the stamp are as they were");
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
  assert.equal(h.clock.armed(), 0);
});

test("shotGrace arms on reaching shot, clears on leaving it, and does nothing otherwise", () => {
  assert.equal(shotGrace("ready", "shot"), "arm");
  assert.equal(shotGrace("todo", "shot"), "arm");
  assert.equal(shotGrace(undefined, "shot"), "arm");
  assert.equal(shotGrace("shot", "todo"), "clear");
  assert.equal(shotGrace("shot", "ready"), "clear");
  assert.equal(shotGrace("shot", undefined), "clear");
  assert.equal(shotGrace("todo", "ready"), null);
  assert.equal(shotGrace("bogus", "todo"), null);
  assert.equal(shotGrace("shot", "shot"), null);
  assert.equal(shotGrace(undefined, undefined), null);
});

test("sceneStatus reads a scene's status, and nothing for a scene that is gone or no document", () => {
  const h = opened();
  assert.equal(h.session.read(sceneStatus("r1")), "ready");
  assert.equal(h.session.read(sceneStatus("r2")), "todo");
  assert.equal(h.session.read(sceneStatus("gone")), undefined);
  assert.equal(harness().session.read(sceneStatus("r1")), undefined, "no document, no status");
});
