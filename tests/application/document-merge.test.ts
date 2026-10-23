import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocumentMerge } from "../../src/application/session/document-merge.ts";
import type { DocumentMergePorts } from "../../src/application/session/document-merge.ts";
import type { MergeKind } from "../../src/application/session/apply-merge.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import type { MergedStates } from "../../src/core/merge-states.ts";
import { migrateRows } from "../../src/js/02-state.js";

interface World {
  readonly ports: DocumentMergePorts<number>;
  readonly seen: string[];
  held: ValidatedDocument;
}

function doc(title: string): ValidatedDocument {
  return migrateRows({ title: title, rows: [{ id: "r1", audioText: title }] });
}

function world(): World {
  const seen: string[] = [];
  const w: World = {
    seen: seen,
    held: doc("held"),
    ports: {
      states: (base, mine, theirs): MergedStates => {
        seen.push("states " + (base ? base.title : "-") + " " + mine.title + " " + theirs.title);
        return { merged: doc("merged"), conflicts: [], stats: { rowsFromThem: 1, rowsFromMe: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 } };
      },
      entry: (raw) => migrateRows(raw),
      isDocument: (raw) => !!raw && typeof raw === "object",
      snapshot: () => null,
      current: () => w.held,
      adopt: (kind: MergeKind, next) => {
        seen.push("adopt " + kind);
        return next;
      },
      documentId: () => "d1",
      noteHistoryFrom: () => {},
      armUndo: () => {},
      setBase: () => {},
      capture: () => 1,
      stillOwns: () => true,
      view: {
        banner: (result, undo) => { seen.push("banner " + result.merged.title + " " + String(undo)); },
        absorbed: (kind) => { seen.push("absorbed " + kind); },
        autoSave: (paused) => { seen.push("autosave " + (paused ? "paused" : "due")); },
        toast: (text, tone) => { seen.push("toast " + text + " " + tone); }
      }
    }
  };
  return w;
}

test("document merge: states goes through the states port as given", () => {
  const w = world();
  const merge = createDocumentMerge(w.ports);
  assert.equal(merge.states(null, doc("mine"), doc("theirs")).merged.title, "merged");
  assert.deepEqual(w.seen, ["states - mine theirs"]);
});

test("document merge: apply merges through entry and states, adopts, and reports the outcome through the view", () => {
  const w = world();
  const merge = createDocumentMerge(w.ports);
  const out = merge.apply({ base: doc("base"), mine: doc("mine"), theirs: doc("theirs"), toast: { text: "done", tone: "warn" } });
  assert.ok(!(out instanceof Promise));
  assert.equal((out.state as { readonly title: string }).title, "merged");
  assert.deepEqual(w.seen, ["states base mine theirs", "adopt server", "banner merged undefined", "absorbed server", "autosave due", "toast done warn"]);
});

test("document merge: apply with nothing to merge leaves the document alone, and an unchanged apply only absorbs", () => {
  const w = world();
  const merge = createDocumentMerge(w.ports);
  const nothing = merge.apply();
  const none = merge.apply(null);
  assert.ok(!(nothing instanceof Promise) && !(none instanceof Promise));
  assert.equal(nothing.state, w.held);
  assert.equal(none.state, w.held);
  assert.deepEqual(w.seen, []);
  merge.apply({ theirs: doc("theirs"), unchanged: true, recovery: true });
  assert.deepEqual(w.seen, ["adopt recovery", "absorbed recovery"]);
});

test("document merge: report shows the banner, and only an unsaved merge marks the document and asks autosave", () => {
  const w = world();
  const merge = createDocumentMerge(w.ports);
  const result = merge.states(null, doc("a"), doc("b"));
  w.seen.length = 0;
  merge.report(result, { alreadySaved: true, undo: "saved" });
  assert.deepEqual(w.seen, ["banner merged saved"]);
  w.seen.length = 0;
  merge.report(result, { kind: "recovery", noAutoSave: true });
  assert.deepEqual(w.seen, ["banner merged undefined", "absorbed recovery", "autosave paused"]);
  w.seen.length = 0;
  merge.report(result);
  assert.deepEqual(w.seen, ["banner merged undefined", "absorbed server", "autosave due"]);
});
