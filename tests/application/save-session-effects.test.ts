import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionEffects } from "../../src/application/save/session-effects.ts";
import type { SessionEffectPorts } from "../../src/application/save/session-effects.ts";
import type { Home, HomeFields } from "../../src/application/location/document-location.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import type { SessionChange, TransactionKind } from "../../src/application/session/change-set.ts";
import type { DocumentView } from "../../src/application/session/document-session.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { rawScript } from "./session-fakes.ts";

interface Given {
  home?: Home;
  author?: string;
  color?: string;
}

function fakes(given: Given = {}) {
  const log: unknown[][] = [];
  const state = {
    home: given.home ?? ({ kind: "none" } as Home),
    author: given.author ?? "",
    color: given.color ?? ""
  };
  const ports: SessionEffectPorts = {
    saves: { dueNow: () => { log.push(["dueNow"]); } },
    changes: {
      noteChange: () => { log.push(["noteChange"]); },
      scheduleAutoSave: () => { log.push(["scheduleAutoSave"]); }
    },
    drafts: { noteChange: () => { log.push(["noteDraftChange"]); } },
    location: {
      home: () => { log.push(["home"]); return state.home; },
      amendHome: (record: Home, fields: HomeFields) => { log.push(["amendHome", record, fields]); return record; }
    },
    preferences: {
      commentAuthor: () => { log.push(["commentAuthor"]); return state.author; },
      myColor: () => { log.push(["myColor"]); return state.color; }
    }
  };
  return { log, state, effects: createSessionEffects(ports) };
}

function change(kind: TransactionKind, saveNow = false): SessionChange {
  return { kind, epoch: 1, generation: 2, changes: changeSet({ saveNow }) };
}

test("the effects are the five the session takes, in their old order", () => {
  assert.deepEqual(Object.keys(fakes().effects), ["dirty", "attribute", "draft", "save", "edit"]);
});

test("dirty notes one save change and reads nothing else", () => {
  const { log, effects } = fakes();
  effects.dirty(change("edit"));
  assert.deepEqual(log, [["noteChange"]]);
});

test("draft notes one draft change and reads nothing else", () => {
  const { log, effects } = fakes();
  effects.draft(change("recovery"));
  assert.deepEqual(log, [["noteDraftChange"]]);
});

test("save schedules the autosave, reads the home, and asks for nothing more on a plain edit", () => {
  const { log, effects } = fakes({ home: { kind: "file" } });
  effects.save(change("edit"));
  assert.deepEqual(log, [["scheduleAutoSave"], ["home"]]);
});

test("save does not schedule the autosave for a recovery", () => {
  const { log, effects } = fakes({ home: { kind: "file" } });
  effects.save(change("recovery"));
  assert.deepEqual(log, [["home"]]);
});

test("save marks an import home dirty with the home it read, then asks for an autosave now when the change says so", () => {
  const home: Home = { kind: "import", name: "notes.md" };
  const { log, effects } = fakes({ home });
  effects.save(change("disk", true));
  assert.deepEqual(log, [["scheduleAutoSave"], ["home"], ["home"], ["amendHome", home, { dirty: true }], ["dueNow"]]);
  assert.equal(log[3]?.[1], home);
});

test("save asks for an autosave now after a recovery that wants one, without scheduling", () => {
  const { log, effects } = fakes();
  effects.save(change("recovery", true));
  assert.deepEqual(log, [["home"], ["dueNow"]]);
});

test("edit is always allowed and reads nothing", () => {
  for (const home of [{ kind: "none" }, { kind: "file" }, { kind: "import", name: "notes.md" }] as Home[]) {
    const { log, effects } = fakes({ home });
    assert.deepEqual(effects.edit(), { allowed: true });
    assert.deepEqual(log, []);
  }
});

function view(personColors?: Record<string, string>): ValidatedDocument {
  return migrateRows({ ...rawScript("T"), personColors }, fakeMigration().ports);
}

test("attribute writes the editor's colour as a personColors plan", () => {
  const { log, effects } = fakes({ author: "  Ada  ", color: "#80BDFB" });
  const doc: DocumentView = view({ Grace: "#F9B64F" });
  const plan = effects.attribute(doc);
  assert.ok(plan);
  assert.deepEqual(plan.changes.docFields, ["personColors"]);
  assert.equal(plan.changes.whole, false);
  assert.deepEqual(log, [["commentAuthor"], ["myColor"]]);
  const live = view({ Grace: "#F9B64F" });
  plan.apply(live);
  assert.deepEqual(live.personColors, { Grace: "#F9B64F", Ada: "#80BDFB" });
});

test("attribute plans nothing without a document, without a name, or when the colour is already set", () => {
  const none = fakes({ author: "Ada", color: "#80BDFB" });
  assert.equal(Reflect.apply(none.effects.attribute, undefined, [null]), null);
  assert.deepEqual(none.log, []);
  const nameless = fakes({ author: "   ", color: "#80BDFB" });
  assert.equal(nameless.effects.attribute(view()), null);
  const same = fakes({ author: "Ada", color: "#80BDFB" });
  assert.equal(same.effects.attribute(view({ ada: "#80BDFB" })), null);
});
