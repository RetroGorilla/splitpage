import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import type { DocumentEdits } from "../../../src/application/session/document-edits.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { ChangeSet } from "../../../src/application/session/change-set.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import { sharedPorts } from "../../../src/bootstrap/wiring/shared-ports.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import {
  REVIEW_ONLY, editAllowed, liveSession, onSessionChange, readSession, runCommand, runDocumentEdit,
  sessionStamps, sessionTextPorts, startSessionBridge
} from "../../../src/legacy/session-bridge.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeClock } from "../session-fakes.ts";

function start(editor: string, record: () => void = () => {}) {
  const migration = fakeMigration();
  const log: string[] = [];
  const recorded: ChangeSet[] = [];
  const reported: unknown[] = [];
  let reason: string | null = null;
  const stop = startSessionBridge({
    entry: (raw) => migrateRows(raw, migration.ports),
    undo: {
      adapter: {
        adopt: () => {},
        record: (changes) => { log.push("undo"); recorded.push(changes); record(); },
        absorbServer: () => {},
        absorbReload: () => {}
      },
      route: () => () => {}
    },
    effects: {
      dirty: () => { log.push("dirty"); },
      draft: () => { log.push("draft"); },
      save: () => { log.push("save"); },
      refresh: () => { log.push("refresh"); }
    },
    capability: { edit: () => reason === null ? { allowed: true } : { allowed: false, reason } },
    editor: { name: () => editor },
    records: () => null,
    attribution: { attribute: () => null },
    report: (error) => { reported.push(error); },
    timers: fakeClock()
  });
  return { stop, log, recorded, reported, deny: (value: string | null): void => { reason = value; } };
}

const titleChanges = changeSet({ docFields: ["title"], saveNow: true });

function titleCommand(title: string, needs: Command["needs"] = "edit"): Command {
  return {
    name: "set-title",
    needs,
    plan: (doc) => doc.title === title ? null : {
      changes: titleChanges,
      apply: (live) => { live.title = title; }
    }
  };
}

test("document edits expose exactly the session bridge functions and stamp and text objects", () => {
  const edits: DocumentEdits = sharedPorts().edits;
  assert.equal(sharedPorts().edits, edits);
  assert.deepEqual(Object.keys(edits), ["run", "edit", "allowed", "stamps", "text"]);
  assert.equal(edits.run, runCommand);
  assert.equal(edits.edit, runDocumentEdit);
  assert.equal(edits.allowed, editAllowed);
  assert.equal(edits.stamps, sessionStamps);
  assert.equal(edits.text, sessionTextPorts);
  assert.equal(edits.text.clock, edits.stamps.clock);
  assert.equal(edits.text.editor, edits.stamps.editor);
});

test("document edits preserve outcomes, one undo record per edit and listener order", () => {
  const edits: DocumentEdits = sharedPorts().edits;
  const h = start("First");
  const offFirst = onSessionChange(() => { h.log.push("first"); });
  const offSecond = onSessionChange(() => { h.log.push("second"); });
  try {
    const command = titleCommand("Changed");
    assert.deepEqual(edits.run(command), { kind: "rejected", reason: "no document" });
    assert.equal(edits.edit(command), false);
    assert.deepEqual(h.recorded, []);
    liveSession().adopt({ title: "Initial", rows: [] });
    h.log.length = 0;
    assert.equal(edits.allowed(), true);
    assert.deepEqual(edits.run(command), { kind: "applied", generation: 1, changes: titleChanges });
    assert.equal(readSession((doc) => doc?.title), "Changed");
    assert.deepEqual(h.recorded, [titleChanges]);
    assert.deepEqual(h.log, ["undo", "dirty", "draft", "save", "first", "second"]);
    h.log.length = 0;
    assert.deepEqual(edits.run(command), { kind: "noop" });
    assert.equal(edits.edit(command), false);
    assert.deepEqual(h.log, []);
    assert.equal(edits.edit(titleCommand("Edited")), true);
    assert.equal(readSession((doc) => doc?.title), "Edited");
    assert.equal(liveSession().generation(), 2);
    assert.deepEqual(h.recorded, [titleChanges, titleChanges]);
    assert.deepEqual(h.log, ["undo", "dirty", "draft", "save", "first", "second"]);
    assert.deepEqual(h.reported, []);
  } finally {
    offSecond();
    offFirst();
    h.stop();
  }
});

test("document edits preserve the exact review refusal and commands needing no edit permission", () => {
  const edits: DocumentEdits = sharedPorts().edits;
  const h = start("Reviewer");
  try {
    liveSession().adopt({ title: "Initial", rows: [] });
    h.deny(REVIEW_ONLY);
    assert.equal(REVIEW_ONLY, "review");
    assert.equal(edits.allowed(), false);
    const refused: Command = { name: "refused", needs: "edit", plan: () => assert.fail("review must refuse before planning") };
    assert.deepEqual(edits.run(refused), { kind: "rejected", reason: REVIEW_ONLY });
    assert.equal(edits.edit(refused), false);
    assert.equal(readSession((doc) => doc?.title), "Initial");
    assert.deepEqual(h.recorded, []);
    assert.deepEqual(h.log, []);
    assert.deepEqual(edits.run(titleCommand("Allowed", "nothing")), { kind: "applied", generation: 1, changes: titleChanges });
    assert.equal(edits.edit(titleCommand("Also allowed", "nothing")), true);
    assert.equal(readSession((doc) => doc?.title), "Also allowed");
    assert.deepEqual(h.recorded, [titleChanges, titleChanges]);
    h.deny(null);
    assert.equal(edits.allowed(), true);
  } finally {
    h.stop();
  }
});

test("run returns failures while edit throws the same error and rolls back failed writes", () => {
  const edits: DocumentEdits = sharedPorts().edits;
  const h = start("First");
  const failure = new Error("edit failed");
  const planning: Command = { name: "broken-plan", needs: "edit", plan: () => { throw failure; } };
  const writing: Command = {
    name: "broken-write",
    needs: "edit",
    plan: () => ({ changes: titleChanges, apply: (doc) => { doc.title = "Broken"; throw failure; } })
  };
  try {
    liveSession().adopt({ title: "Initial", rows: [] });
    for (const command of [planning, writing]) {
      const outcome = edits.run(command);
      assert.deepEqual(outcome, { kind: "failed", error: failure });
      if (outcome.kind !== "failed") assert.fail("expected a failed outcome");
      assert.equal(outcome.error, failure);
      assert.throws(() => edits.edit(command), (error: unknown) => error === failure);
      assert.equal(readSession((doc) => doc?.title), "Initial");
      assert.equal(liveSession().generation(), 0);
    }
    assert.deepEqual(h.recorded, []);
    assert.deepEqual(h.log, []);
    assert.deepEqual(h.reported, []);
  } finally {
    h.stop();
  }
});

test("document edits preserve committed outcomes and edit succeeds after an undo reporting error", () => {
  const edits: DocumentEdits = sharedPorts().edits;
  const failure = new Error("undo failed");
  const h = start("First", () => { throw failure; });
  try {
    liveSession().adopt({ title: "Initial", rows: [] });
    assert.deepEqual(edits.run(titleCommand("Committed")), {
      kind: "committed", generation: 1, changes: titleChanges, errors: [failure]
    });
    assert.equal(edits.edit(titleCommand("Committed again")), true);
    assert.equal(readSession((doc) => doc?.title), "Committed again");
    assert.equal(liveSession().generation(), 2);
    assert.deepEqual(h.recorded, [titleChanges, titleChanges]);
    assert.deepEqual(h.reported, [failure, failure]);
    assert.deepEqual(h.log, ["undo", "dirty", "draft", "save", "undo", "dirty", "draft", "save"]);
  } finally {
    h.stop();
  }
});

test("the same document edits port follows restarted sessions and their editor and permission ports", () => {
  const edits: DocumentEdits = sharedPorts().edits;
  const first = start("First");
  try {
    liveSession().adopt({ title: "First document", rows: [] });
    assert.equal(edits.stamps.editor.name(), "First");
    assert.equal(edits.text.editor.name(), "First");
    assert.equal(edits.edit(titleCommand("First edit")), true);
  } finally {
    first.stop();
  }
  const second = start("Second");
  try {
    liveSession().adopt({ title: "Second document", rows: [] });
    second.deny(REVIEW_ONLY);
    assert.equal(sharedPorts().edits, edits);
    assert.equal(edits.stamps.editor.name(), "Second");
    assert.equal(edits.text.editor.name(), "Second");
    assert.equal(edits.allowed(), false);
    const command = titleCommand("Second edit");
    assert.deepEqual(edits.run(command), { kind: "rejected", reason: REVIEW_ONLY });
    second.deny(null);
    assert.equal(edits.allowed(), true);
    assert.equal(edits.edit(command), true);
    assert.equal(readSession((doc) => doc?.title), "Second edit");
    assert.deepEqual(first.recorded, [titleChanges]);
    assert.deepEqual(second.recorded, [titleChanges]);
  } finally {
    second.stop();
  }
});
