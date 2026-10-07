import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import type { Command } from "../../src/application/session/document-session.ts";
import { NO_CHANGES, cellEdit, changeSet } from "../../src/application/session/change-set.ts";
import { harness, rawScript } from "./session-fakes.ts";

function setAudio(rowId: string, text: string): Command {
  return {
    name: "set-audio",
    needs: "edit",
    plan: function (doc) {
      const row = doc.rows.find(function (r) { return r.id === rowId; });
      if (!row) return { refused: "no such scene" };
      if (row.audioText === text) return null;
      return {
        changes: cellEdit(rowId, "audioText", ["production"]),
        apply: function (live) {
          const target = live.rows.find(function (r) { return r.id === rowId; });
          if (target) target.audioText = text;
        }
      };
    }
  };
}

function insertRow(id: string): Command {
  return {
    name: "insert-row",
    needs: "edit",
    plan: function () {
      return {
        changes: changeSet({ rowsInserted: [id] }),
        apply: function (live) { live.rows.push({ id: id, visualText: "", audioText: "" }); }
      };
    }
  };
}

function opened(): ReturnType<typeof harness> {
  const h = harness();
  h.session.adopt(rawScript("Harbour"));
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function audioOf(h: ReturnType<typeof harness>, rowId: string): unknown {
  return h.session.read(function (doc) {
    const row = doc && doc.rows.find(function (r) { return r.id === rowId; });
    return row ? row.audioText : undefined;
  });
}

test("E2: an accepted command makes one generation transition, records undo once and runs one effect pass, in that order", () => {
  const h = opened();
  const out = h.session.run(setAudio("r1", "Every evening."));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: cellEdit("r1", "audioText", ["production"]) });
  assert.equal(h.session.generation(), 1);
  assert.equal(audioOf(h, "r1"), "Every evening.");
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  assert.equal(h.published.length, 1);
  assert.deepEqual([h.published[0]?.kind, h.published[0]?.generation, h.published[0]?.epoch], ["edit", 1, 1]);
  h.session.run(setAudio("r2", "Nets."));
  assert.equal(h.session.generation(), 2, "the next accepted command makes the next transition");
});

test("E2: a one-cell edit does not reconcile anchors; a change that inserts a row reconciles inside the transaction, before undo records it", () => {
  const h = opened();
  h.session.run(setAudio("r1", "Every evening."));
  assert.equal(h.log.includes("reconcile"), false);
  h.log.length = 0;
  h.session.run(insertRow("r3"));
  assert.deepEqual(h.log, ["reconcile", "undo.record", "dirty:2", "draft:2", "save:2", "publish:edit"]);
});

test("E3: a no-op, an empty change set, a refusal, a rejected capability, a failure and a missing document have no effects", () => {
  const h = opened();
  const before = h.session.read(function (doc) { return JSON.stringify(doc); });
  const empty: Command = { name: "empty", needs: "edit", plan: function () { return { changes: NO_CHANGES, apply: function () { throw new Error("never applied"); } }; } };
  const failing: Command = { name: "failing", needs: "edit", plan: function () { throw new Error("broken plan"); } };
  assert.deepEqual(h.session.run(setAudio("r1", "Every morning.")), { kind: "noop" });
  assert.deepEqual(h.session.run(empty), { kind: "noop" });
  assert.deepEqual(h.session.run(setAudio("zz", "x")), { kind: "rejected", reason: "no such scene" });
  const failed = h.session.run(failing);
  assert.equal(failed.kind, "failed");
  h.deny("review");
  assert.deepEqual(h.session.run(setAudio("r1", "Changed.")), { kind: "rejected", reason: "review" });
  h.deny(null);
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
  assert.equal(h.session.read(function (doc) { return JSON.stringify(doc); }), before, "the document is unchanged");
  assert.equal(h.clock.armed(), 0, "no refresh was scheduled");

  const closed = harness();
  assert.deepEqual(closed.session.run(setAudio("r1", "x")), { kind: "rejected", reason: NO_DOCUMENT });
  assert.deepEqual(closed.log, []);
});

test("E3: a command that only reads skips the capability check", () => {
  const h = opened();
  h.deny("review");
  const reading: Command = { name: "reading", needs: "nothing", plan: function () { return null; } };
  assert.deepEqual(h.session.run(reading), { kind: "noop" });
  assert.deepEqual(h.session.run(setAudio("r1", "x")), { kind: "rejected", reason: "review" });
});

test("E4: adoption migrates the raw input, opens a new epoch and records nothing, even for the same document id", () => {
  const h = harness();
  const doc = h.session.adopt(rawScript("Harbour"));
  assert.ok(doc);
  assert.equal(doc.rows[1]?.status, "todo", "the session holds the migrated document");
  assert.equal(h.session.epoch(), 1);
  assert.deepEqual(h.log, ["entry", "undo.adopt:Harbour", "publish:adopt"]);
  h.session.run(setAudio("r1", "Every evening."));
  h.log.length = 0;
  const again = h.session.adopt(rawScript("Harbour"));
  assert.equal(again?.docId, doc.docId, "the same document id");
  assert.equal(h.session.epoch(), 2, "a new epoch all the same");
  assert.equal(h.session.generation(), 1, "adoption is not an edit");
  assert.deepEqual(h.log, ["entry", "undo.adopt:Harbour", "publish:adopt"]);
  h.log.length = 0;
  assert.equal(h.session.adopt(null), null);
  assert.equal(h.session.epoch(), 3);
  assert.deepEqual(h.log, ["undo.adopt:none", "publish:adopt"], "closing the document migrates nothing");
});

test("E4: a server update and a reload keep the epoch, add no generation, record no undo and run no effects", () => {
  const h = opened();
  h.session.run(setAudio("r1", "Mine."));
  h.clock.advance(1000);
  h.log.length = 0;
  h.published.length = 0;
  const merged = h.session.absorbServer(rawScript("Merged"));
  assert.equal(merged?.title, "Merged");
  assert.equal(h.session.read(function (doc) { return doc && doc.title; }), "Merged");
  h.session.absorbReload();
  assert.equal(h.session.epoch(), 1);
  assert.equal(h.session.generation(), 1);
  assert.deepEqual(h.log, ["entry", "undo.server:Merged", "publish:server", "undo.reload", "publish:reload"]);
  assert.deepEqual(h.published.map(function (c) { return c.kind; }), ["server", "reload"]);
  assert.equal(h.clock.armed(), 0);
});

test("E4: user edits, server updates, reloads and adoptions are published as distinct kinds", () => {
  const h = harness();
  h.session.adopt(rawScript("A"));
  h.session.run(setAudio("r1", "x"));
  h.session.noteEdit();
  h.session.absorbServer(rawScript("B"));
  h.session.absorbReload();
  assert.deepEqual(h.published.map(function (c) { return c.kind + ":" + c.epoch + ":" + c.generation; }),
    ["adopt:1:0", "edit:1:1", "edit:1:2", "server:1:2", "reload:1:2"]);
});

test("a legacy edit of unknown extent is one generation transition, one undo record and one effect pass, and reconciles nothing", () => {
  const h = opened();
  h.session.noteEdit();
  assert.equal(h.session.generation(), 1);
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  assert.equal(h.clock.armed(), 0, "a legacy edit schedules its own refreshes");
  assert.equal(h.published[0]?.changes.whole, true);
});

test("an unsubscribed listener hears nothing more", () => {
  const h = opened();
  const heard: string[] = [];
  const stop = h.session.subscribe(function (c) { heard.push(c.kind); });
  h.session.noteEdit();
  stop();
  stop();
  h.session.noteEdit();
  assert.deepEqual(heard, ["edit"]);
  assert.equal(h.published.length, 2, "other listeners still hear");
});
