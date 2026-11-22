import assert from "node:assert/strict";
import { test, mock } from "node:test";
import * as Y from "yjs";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { operation } from "./executor-support.ts";
import { createRecord, recordReplicas } from "./record-support.ts";

test("has distinguishes absent and stored undefined and follows planned create/delete/recreate effects", () => {
  const run = recordReplicas();
  try {
    transactSharedDocument(run.a, "remote", () => {
      collabState(run.a).roots.people.set("undefined", undefined);
      collabState(run.a).roots.people.set("existing", new Y.Map<unknown>([["id", "existing"], ["name", "old"]]));
    });
    const preparation = createSharedPreparation(run.a), view = preparation.view;
    assert.equal(view.has([]), false); assert.equal(view.has(["people"]), true); assert.equal(view.has(["unknown"]), false);
    assert.equal(view.kind(["people", "undefined"]), "missing"); assert.equal(view.has(["people", "undefined"]), true);
    assert.equal(view.has(["people", "absent"]), false);
    assert.equal(view.has(["people", "existing", "name"]), true);
    preparation.include([{ path: ["people", "existing"], kind: "delete" }]);
    assert.equal(view.has(["people", "existing"]), false); assert.equal(view.has(["people", "existing", "name"]), false);
    preparation.include([{ path: ["people", "existing"], kind: "map" }]);
    assert.equal(view.has(["people", "existing"]), true); assert.equal(view.has(["people", "existing", "name"]), false);
    const path = ["people", "planned"];
    preparation.include([{ path, kind: "map" }, { path: [...path, "name"], kind: "set", value: "first" }]);
    assert.equal(view.has(path), true); assert.equal(view.has([...path, "name"]), true); assert.equal(view.has([...path, "absent"]), false);
    preparation.include([{ path, kind: "delete" }]);
    assert.equal(view.has(path), false); assert.equal(view.has([...path, "name"]), false);
    preparation.include([{ path, kind: "map" }]);
    assert.equal(view.has(path), true); assert.equal(view.has([...path, "name"]), false);
    preparation.include([{ path: [...path, "name"], kind: "set", value: "second" }]);
    assert.equal(view.has([...path, "name"]), true);
    preparation.include([{ path: ["people", "undefined"], kind: "delete" }]);
    assert.equal(view.has(["people", "undefined"]), false);
    preparation.close(); assert.throws(() => view.has(path), /Preparation has ended/);
  } finally { run.close(); }
});

test("record creation enumerates zero root keys with zero or one thousand unrelated records", () => {
  const enumerated: number[] = [];
  for (const size of [0, 1000]) {
    const run = recordReplicas();
    try {
      const root = collabState(run.a).roots.people;
      transactSharedDocument(run.a, "remote", () => { for (let index = 0; index < size; index++) root.set(`P${index}`, new Y.Map<unknown>([["id", `P${index}`], ["name", "unrelated"]])); });
      const originalKeys = root.keys.bind(root); let visited = 0;
      const keys = mock.method(root, "keys", function* () { for (const key of originalKeys()) { visited++; yield key; } });
      try {
        assert.deepEqual(executeSharedOperations(run.a, [operation(createRecord("people", "new", { name: "new" }))]), { ok: true });
        enumerated.push(visited);
        assert.equal(keys.mock.callCount(), 0);
      } finally { keys.mock.restore(); }
    } finally { run.close(); }
  }
  assert.deepEqual(enumerated, [0, 0]);
});

test("stored undefined refuses record creation", () => {
  const run = recordReplicas();
  try {
    transactSharedDocument(run.a, "remote", () => collabState(run.a).roots.people.set("undefined", undefined));
    const command = operation(createRecord("people", "undefined", { name: "replacement" }));
    assert.deepEqual(executeSharedOperations(run.a, [command]), { ok: false, index: 0, operation: command, reason: "duplicate-record" });
  } finally { run.close(); }
});
