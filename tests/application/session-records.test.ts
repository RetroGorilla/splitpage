import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command, Replay } from "../../src/application/session/document-session.ts";
import { cellEdit, changeSet } from "../../src/application/session/change-set.ts";
import type { ChangeSet } from "../../src/application/session/change-set.ts";
import type { RecordsPlan } from "../../src/application/session/ports.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { harness, rawScript, runConfined } from "./session-fakes.ts";
import type { HarnessHooks } from "./session-fakes.ts";

function setAudio(rowId: string, text: string, changes: ChangeSet = cellEdit(rowId, "audioText", ["production"])): Command {
  return {
    name: "set-audio",
    needs: "edit",
    plan: function (doc) {
      if (!doc.rows.some(function (r) { return r.id === rowId; })) return { refused: "no such scene" };
      return {
        changes: changes,
        apply: function (live) {
          const row = live.rows.find(function (r) { return r.id === rowId; });
          if (row) row.audioText = text;
        }
      };
    }
  };
}

function setAudioReplay(rowId: string, text: string, failSettle = false): Replay {
  return {
    name: "undo",
    plan: function () {
      return {
        changes: cellEdit(rowId, "audioText", ["production"]),
        apply: function (live) {
          const row = live.rows.find(function (r) { return r.id === rowId; });
          if (row) row.audioText = text;
        },
        settle: function () { if (failSettle) throw new Error("history broke while moving"); }
      };
    }
  };
}

function shotsFor(seen: ChangeSet[], fail: "plan" | "apply" | null = null): (doc: ValidatedDocument, changes: ChangeSet) => RecordsPlan | null {
  return function (doc, changes) {
    seen.push(changes);
    if (fail === "plan") throw new Error("records broke while planning");
    const had = Array.isArray(doc.brollShots) ? doc.brollShots : [];
    const wanted = doc.rows.map(function (r) { return { id: "bs_" + r.id, name: String(r.audioText || "") }; });
    if (JSON.stringify(had) === JSON.stringify(wanted)) return null;
    return {
      fields: ["brollShots"],
      apply: function (into) {
        into.brollShots = [];
        if (fail === "apply") throw new Error("records broke while writing");
        into.brollShots = wanted as unknown as ValidatedDocument["brollShots"];
      }
    };
  };
}

function opened(hooks: HarnessHooks = {}): ReturnType<typeof harness> {
  const h = harness(undefined, hooks);
  h.session.adopt(rawScript("Harbour"));
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function textOf(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function shotNames(h: ReturnType<typeof harness>): string[] {
  return h.session.read(function (doc) {
    return doc && Array.isArray(doc.brollShots) ? doc.brollShots.map(function (s) { return String((s as { name?: unknown }).name); }) : [];
  });
}

test("6.5: an edit's dependent records are written in the same transaction, declared in its change set, and seen by the one undo record", () => {
  const seen: ChangeSet[] = [];
  const h = opened({ records: shotsFor(seen) });
  const rows = h.session.read(function (doc) { return doc ? doc.rows.length : 0; });
  const out = runConfined(h.session, setAudio("r1", "Steam rises."));
  assert.equal(out.kind, "applied");
  if (out.kind !== "applied") return;
  assert.equal(out.generation, 1);
  assert.deepEqual(out.changes.docFields, ["brollShots"]);
  assert.deepEqual(seen, [cellEdit("r1", "audioText", ["production"])], "planned once, with the edit's own changes");
  assert.equal(shotNames(h).length, rows);
  assert.equal(shotNames(h)[0], "Steam rises.");
  assert.deepEqual(h.log.filter(function (l) { return l === "records" || l === "undo.record" || l.startsWith("publish"); }),
    ["records", "undo.record", "publish:edit"]);
  assert.deepEqual(h.published.map(function (c) { return c.changes.docFields; }), [["brollShots"]]);
});

test("6.5: an edit whose records are already right declares nothing more", () => {
  const seen: ChangeSet[] = [];
  const h = opened({ records: shotsFor(seen) });
  runConfined(h.session, setAudio("r1", "Steam rises."));
  const out = runConfined(h.session, setAudio("r2", "Steam rises."));
  assert.equal(out.kind, "applied");
  if (out.kind !== "applied") return;
  assert.equal(out.generation, 2);
  assert.deepEqual(out.changes.docFields, ["brollShots"]);
  const again = runConfined(h.session, setAudio("r2", "Steam rises."));
  assert.equal(again.kind, "applied");
  if (again.kind !== "applied") return;
  assert.deepEqual(again.changes, cellEdit("r2", "audioText", ["production"]));
});

for (const fail of ["plan", "apply"] as const) {
  test("6.5: records that throw while they " + (fail === "plan" ? "plan" : "write") + " fail the edit and roll back the edit and the records before anything commits", () => {
    const h = opened({ records: shotsFor([], fail) });
    const before = textOf(h);
    const out = h.session.run(setAudio("r1", "Steam rises."));
    assert.equal(out.kind, "failed");
    assert.equal(textOf(h), before);
    assert.equal(h.session.generation(), 0);
    assert.deepEqual(h.published, []);
    assert.equal(h.log.indexOf("undo.record"), -1);
  });
}

test("6.5: a throw after the records are written (the anchor reconcile) rolls the records back too", () => {
  const h = opened({ records: shotsFor([]), reconcile: function () { throw new Error("anchors broke"); } });
  const before = textOf(h);
  const out = h.session.run(setAudio("r1", "Steam rises.", changeSet({ cells: [{ rowId: "r1", field: "audioText" }], runsMoved: true })));
  assert.equal(out.kind, "failed");
  assert.equal(textOf(h), before);
  assert.equal(h.session.generation(), 0);
});

test("6.5: a replay and an amend never run the records: they restore what the history recorded", () => {
  const seen: ChangeSet[] = [];
  const h = opened({ records: shotsFor(seen) });
  const replayed = h.session.replay(setAudioReplay("r1", "Steam rises."));
  assert.equal(replayed.kind, "applied");
  const amended = h.session.amend(setAudioReplay("r1", "Steam falls."));
  assert.equal(amended.kind, "applied");
  assert.deepEqual(seen, []);
  assert.deepEqual(shotNames(h), []);
  assert.equal(h.log.indexOf("records"), -1);
});

test("6.5: noteEdit runs the records on what it notes and declares them; a throw is reported and the edit still commits", () => {
  const seen: ChangeSet[] = [];
  const h = opened({ records: shotsFor(seen) });
  h.session.noteEdit(changeSet({ cells: [{ rowId: "r1", field: "audioText" }] }));
  assert.equal(h.session.generation(), 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(h.published.map(function (c) { return c.changes.docFields; }), [["brollShots"]]);
  assert.ok(shotNames(h).length > 0);

  const broken = opened({ records: shotsFor([], "plan") });
  broken.session.noteEdit();
  assert.equal(broken.session.generation(), 1);
  assert.equal(broken.reported.length, 1);
  assert.deepEqual(broken.published.map(function (c) { return c.kind; }), ["edit"]);
});
