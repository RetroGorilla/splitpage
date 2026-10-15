import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import { titleCommand } from "../../src/application/commands/title.ts";
import { harness, runConfined } from "./session-fakes.ts";
import type { HarnessHooks } from "./session-fakes.ts";

const OLD = "2026-01-01T00:00:00.000Z";

function script(): Record<string, unknown> {
  return {
    title: "Draft",
    docId: "d" + "3".repeat(32),
    rows: [{ id: "r1", visualText: "V1", audioText: "A1", status: "todo", updatedAt: OLD, updatedBy: "Sam" }]
  };
}

function opened(hooks?: HarnessHooks): ReturnType<typeof harness> {
  const h = harness(undefined, hooks);
  h.session.adopt(script());
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function snapshot(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function title(h: ReturnType<typeof harness>): unknown {
  return h.session.read(function (doc) { return doc ? doc.title : null; });
}

test("title: a new title is one generation, one undo record, one publication naming only the title", () => {
  const h = opened();
  const out = runConfined(h.session, titleCommand("Final cut"));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: changeSet({ docFields: ["title"] }) });
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  assert.equal(title(h), "Final cut");
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0]?.changes.whole, false);
  assert.equal(h.published[0]?.changes.saveNow, false, "a title waits for the ordinary autosave, as before");
  const row = h.session.read(function (doc) { return doc ? doc.rows[0] : null; });
  assert.equal(row?.updatedAt, OLD, "a title stamps no scene");
});

test("title: the same title makes no edit", () => {
  const h = opened();
  assert.deepEqual(runConfined(h.session, titleCommand("Draft")), { kind: "noop" });
  assert.deepEqual(h.log, []);
  assert.equal(h.session.generation(), 0);
});

test("title: an empty title is a title like any other", () => {
  const h = opened();
  assert.equal(runConfined(h.session, titleCommand("")).kind, "applied");
  assert.equal(title(h), "");
});

test("title: a review copy refuses the title before it plans, with nothing written", () => {
  const h = opened();
  const before = snapshot(h);
  h.deny("review");
  assert.deepEqual(runConfined(h.session, titleCommand("Mine now")), { kind: "rejected", reason: "review" });
  assert.deepEqual(h.log, []);
  assert.equal(snapshot(h), before);
});

test("title: with no document open the title is refused", () => {
  const h = harness();
  assert.deepEqual(runConfined(h.session, titleCommand("Nothing")), { kind: "rejected", reason: NO_DOCUMENT });
});

test("title: a throw later in the same transaction rolls the title back before anything commits", () => {
  const h = opened({
    attribute: function () {
      return { changes: changeSet({ docFields: ["personColors"] }), apply: function () { throw new Error("no colour"); } };
    }
  });
  const before = snapshot(h);
  const out = runConfined(h.session, titleCommand("Final cut"));
  assert.equal(out.kind, "failed");
  assert.equal(snapshot(h), before);
  assert.equal(title(h), "Draft");
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.published, []);
});
