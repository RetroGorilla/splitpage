import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import { SCENE_LENGTH_DERIVES, sceneAt, sceneLengthCommand } from "../../src/application/commands/scene-length.ts";
import type { StampPorts } from "../../src/application/commands/scene-length.ts";
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
  const second = rows[1];
  if (second) second.lengthSeconds = 45;
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

const LENGTH_CHANGES = function (rowId: string) {
  return changeSet({
    cells: [
      { rowId: rowId, field: "lengthSeconds" },
      { rowId: rowId, field: "updatedAt" },
      { rowId: rowId, field: "updatedBy" }
    ],
    derive: ["production", "broll"],
    saveNow: true
  });
};

test("E2: setting a scene's length is one generation, one undo record and one effect pass, stamped through the clock and editor ports", () => {
  const h = opened();
  const out = runConfined(h.session, sceneLengthCommand("r1", 90, stamps()));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: LENGTH_CHANGES("r1") });
  assert.equal(h.session.generation(), 1);
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  const row = rowOf(h, "r1");
  assert.equal(row?.lengthSeconds, 90);
  assert.equal(row?.updatedAt, STAMP);
  assert.equal(row?.updatedBy, "Adam");
  assert.equal(rowOf(h, "r2")?.updatedAt, "2026-01-01T00:00:00.000Z", "no other scene is stamped");
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0]?.changes.saveNow, true, "the change asks for an immediate save, as the button always did");
  assert.deepEqual(SCENE_LENGTH_DERIVES, ["production", "broll"]);
  assert.deepEqual(h.refreshes, []);
  h.clock.advance(180);
  assert.deepEqual(h.refreshes, [["broll", "production"]], "production and b-roll refresh once, on the idle refresh");
});

test("E2: clearing a set length deletes the key and is one more generation", () => {
  const h = opened();
  const out = runConfined(h.session, sceneLengthCommand("r2", null, stamps("Mara")));
  assert.equal(out.kind, "applied");
  const row = rowOf(h, "r2");
  assert.ok(row && !("lengthSeconds" in row), "the key is gone, not set to null");
  assert.equal(row?.updatedBy, "Mara");
  assert.equal(h.session.generation(), 1);
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
});

test("E3: the same length again, clearing a length that was never set and a scene that is gone are no-ops with no effects", () => {
  const h = opened();
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, sceneLengthCommand("r2", 45, stamps())), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, sceneLengthCommand("r1", null, stamps())), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, sceneLengthCommand("r1", undefined, stamps())), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, sceneLengthCommand("gone", 30, stamps())), { kind: "noop" });
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
  assert.deepEqual(runConfined(h.session, sceneLengthCommand("r1", 30, counting)), { kind: "rejected", reason: "review" });
  assert.equal(asked, 0, "the stamp ports are never asked");
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.equal(snapshot(h), before);
});

test("E3: with no document open the command is refused", () => {
  const h = harness();
  assert.deepEqual(h.session.run(sceneLengthCommand("r1", 30, stamps())), { kind: "rejected", reason: NO_DOCUMENT });
  assert.deepEqual(h.log, []);
});

test("E3: a stamp port that throws fails the command and rolls the length back, with no effects", () => {
  const h = opened();
  const before = snapshot(h);
  const broken: StampPorts = {
    clock: { nowIso: function () { return STAMP; } },
    editor: { name: function () { throw new Error("no editor"); } }
  };
  const out = runConfined(h.session, sceneLengthCommand("r1", 90, broken));
  assert.equal(out.kind, "failed");
  assert.equal(out.kind === "failed" && out.error instanceof Error ? out.error.message : "", "no editor");
  const cleared = runConfined(h.session, sceneLengthCommand("r2", null, broken));
  assert.equal(cleared.kind, "failed");
  assert.equal(snapshot(h), before, "the length and the stamp are as they were");
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
});

test("the same command run twice applies once: each run plans against the document as it is then", () => {
  const h = opened();
  const command = sceneLengthCommand("r2", 60, stamps());
  assert.equal(runConfined(h.session, command).kind, "applied");
  assert.equal(rowOf(h, "r2")?.lengthSeconds, 60);
  assert.deepEqual(runConfined(h.session, command), { kind: "noop" }, "the same command again changes nothing");
});

test("sceneAt reads a scene's place and a copy of its fields; writing the copy changes nothing", () => {
  const h = opened();
  const at = h.session.read(sceneAt("r2"));
  assert.ok(at);
  assert.equal(at.index, 1);
  assert.equal(at.row.id, "r2");
  assert.equal(at.row.lengthSeconds, 45);
  const before = snapshot(h);
  Reflect.set(at.row, "lengthSeconds", 1);
  Reflect.set(at.row, "audioText", "Changed");
  assert.equal(snapshot(h), before);
  assert.equal(h.session.read(sceneAt("gone")), null);
  assert.equal(harness().session.read(sceneAt("r1")), null, "no document, no scene");
});
