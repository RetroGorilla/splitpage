import test from "node:test";
import assert from "node:assert/strict";
import { createTypedDrafts, typedOrphansHtml } from "./typed-drafts.ts";

test("draft presentation never writes, hidden editors retain text, and dismissal ends the draft", () => {
  let writes = 0;
  const drafts = createTypedDrafts(["notes"], () => {});
  drafts.submit("notes", "T1", "Wide", () => { writes++; return "kept"; });
  assert.deepEqual(drafts.hidden(() => false, () => true), [{ box: "notes", record: "T1", text: "Wide" }]);
  assert.equal(writes, 1);
  assert.deepEqual(drafts.hidden(() => true, () => true), []);
  assert.equal(drafts.draft("notes", "T1"), "Wide");
  drafts.dismiss("notes", "T1");
  assert.deepEqual(drafts.held(), []);
});

test("typing back to the drawn value drops the draft before any redraw", () => {
  const drafts = createTypedDrafts(["notes"], () => {});
  drafts.submit("notes", "T1", "Wide", () => "kept");
  drafts.revise("notes", "T1", "Wide shot", "");
  assert.equal(drafts.draft("notes", "T1"), "Wide shot");
  drafts.revise("notes", "T1", "", "");
  assert.deepEqual(drafts.held(), []);
});

test("a removed draft announces once, escapes strip text, and clears with its lifetime", () => {
  const notices: string[] = [];
  const drafts = createTypedDrafts(["notes"], draft => { notices.push(draft.record); });
  drafts.submit("notes", "T1", "</textarea><script>bad</script>", () => "kept");
  const hidden = drafts.hidden(() => false, () => false);
  assert.deepEqual(drafts.hidden(() => false, () => false), hidden);
  assert.deepEqual(notices, ["T1"]);
  assert.match(typedOrphansHtml(hidden, () => "<Mug> notes"), /&lt;Mug&gt; notes/);
  assert.doesNotMatch(typedOrphansHtml(hidden, () => "notes"), /<script>/);
  drafts.clear();
  assert.deepEqual([drafts.held(), drafts.orphans()], [[], []]);
});
