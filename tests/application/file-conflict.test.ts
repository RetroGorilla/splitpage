import { test } from "node:test";
import assert from "node:assert/strict";
import { createFileConflicts } from "../../src/application/save/file-conflict.ts";

test("a shown conflict is the current one until it is closed, and each change is announced", () => {
  const conflicts = createFileConflicts();
  const heard: (string | null)[] = [];
  conflicts.onChange(() => { heard.push(conflicts.current()?.fileName ?? null); });
  assert.equal(conflicts.current(), null);
  conflicts.show({ fileName: "a.md", current: { lastModified: 5 }, kind: "import" });
  assert.deepEqual(conflicts.current(), { fileName: "a.md", current: { lastModified: 5 }, kind: "import" });
  assert.ok(Object.isFrozen(conflicts.current()));
  conflicts.show({ fileName: "b.splitpage", current: null, kind: "project" });
  conflicts.close();
  conflicts.close();
  assert.deepEqual(heard, ["a.md", "b.splitpage", null, null], "closing announces even when nothing is open, so the view always hides");
});

test("a removed listener hears nothing, and stop clears the conflict and every listener", () => {
  const conflicts = createFileConflicts();
  let heard = 0;
  const stop = conflicts.onChange(() => { heard++; });
  conflicts.show({ fileName: "a.md", current: null, kind: "import" });
  stop();
  conflicts.close();
  assert.equal(heard, 1);
  conflicts.onChange(() => { heard++; });
  conflicts.show({ fileName: "a.md", current: null, kind: "import" });
  conflicts.stop();
  assert.equal(conflicts.current(), null);
  conflicts.show({ fileName: "a.md", current: null, kind: "import" });
  assert.equal(heard, 2, "after stop no listener hears the next change");
});
