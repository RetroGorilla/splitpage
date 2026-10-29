import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { unsavedTitles, unsavedDialogFor, decisionFor } = require(path.join(here, "..", "unsaved-dialog.js"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("a tab's own title is used, and the drafts list is read only when one is missing", () => {
  let reads = 0;
  const draftsList = () => { reads++; return [{ tabId: "b", title: "From draft" }]; };
  assert.deepEqual(unsavedTitles([{ id: "a", title: "One" }], draftsList), ["One"]);
  assert.equal(reads, 0);
  assert.deepEqual(unsavedTitles([{ id: "b", title: "" }, { id: "c" }, { id: "a", title: "One" }], draftsList), ["From draft", "Untitled", "One"]);
  assert.equal(reads, 1);
});

test("one unsaved tab gets leave or stay, with the closing verb in the detail", () => {
  const spec = unsavedDialogFor(1, "Close tab", []);
  assert.deepEqual(spec.options, {
    type: "warning",
    buttons: ["Leave without saving", "Stay"],
    defaultId: 1,
    cancelId: 1,
    title: "Splitpage",
    message: "You have unsaved changes",
    detail: "If you close this tab now, your changes will be lost."
  });
  assert.equal(unsavedDialogFor(1, "Quit", []).options.detail, "If you leave now, your changes will be lost.");
  assert.equal(unsavedDialogFor(1, "Close window", []).options.detail, "If you leave now, your changes will be lost.");
});

test("several unsaved tabs get review, leave or cancel, listing their titles", () => {
  const spec = unsavedDialogFor(2, "Quit", ["One", "Two"]);
  assert.deepEqual(spec.options, {
    type: "warning",
    buttons: ["Review", "Quit without saving", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    title: "Splitpage",
    message: "You have unsaved changes in 2 documents",
    detail: "• One\n• Two\n\nIf you continue, these changes will be lost."
  });
  assert.equal(unsavedDialogFor(3, "Close window", ["a", "b", "c"]).options.buttons[1], "Close without saving");
});

test("the button chosen maps to discard, review or cancel, and anything else is cancel", () => {
  const one = unsavedDialogFor(1, "Close tab", []);
  assert.equal(decisionFor(one, 0), "discard");
  assert.equal(decisionFor(one, 1), "cancel");
  assert.equal(decisionFor(one, 7), "cancel");
  const many = unsavedDialogFor(2, "Quit", ["a", "b"]);
  assert.equal(decisionFor(many, 0), "review");
  assert.equal(decisionFor(many, 1), "discard");
  assert.equal(decisionFor(many, 2), "cancel");
  assert.equal(decisionFor(many, -1), "cancel");
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
