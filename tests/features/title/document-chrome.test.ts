import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDocumentChrome } from "../../../src/features/title/document-chrome.js";
import type { DocumentChromeControl, DocumentChromePorts } from "../../../src/features/title/ports.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeEdits, fakeNotices, fakeReview } from "../fakes.ts";
import { PERSON_COLORS } from "../../../src/core/document/person-colors.ts";

function setup() {
  document.body.innerHTML = '<button id="identity-chip"><span class="identity-dot"></span><span id="identity-name"></span></button><button id="runtime-chip"></button><button id="length-status"></button>';
  let name = "";
  let colour = "";
  const edits = fakeEdits();
  const review = fakeReview();
  const doc = migrateRows({ title: "Test", wordsPerMinute: 120, targetSeconds: 60, rows: [] }, fakeMigration().ports);
  const ports: DocumentChromePorts = {
    document: fakeDocument(doc).document,
    preferences: {
      commentAuthor: () => name, myColor: () => colour,
      setCommentAuthor: (value) => { name = value; }, setMyColor: (value) => { colour = value || ""; },
      nameOf: () => "commentAuthor"
    },
    presence: { personColor: () => PERSON_COLORS[0] ?? "" },
    review: review.review, edits: edits.edits, notices: fakeNotices().notices
  };
  const owner: DocumentChromeControl = startDocumentChrome(ports);
  return { owner, review, edits, name: () => name, colour: () => colour };
}

test("the identity chip, name and colour controls read and change their named ports", () => {
  const f = setup();
  f.owner.updateIdentityChip();
  assert.equal(document.getElementById("identity-name")?.textContent, "Set your name");
  assert.ok(document.getElementById("identity-chip")?.classList.contains("unnamed"));
  f.owner.promptForName();
  const input = document.getElementById("identity-input") as HTMLInputElement;
  input.value = "  Ann  ";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(f.name(), "Ann");
  assert.equal(document.getElementById("identity-editor"), null);
  f.owner.identityChipListeners().colours();
  assert.equal(document.getElementById("identity-name")?.textContent, "Ann");
  f.owner.promptForName();
  const swatch = document.querySelector('input[name="person-color"]') as HTMLInputElement;
  swatch.checked = true;
  swatch.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(f.colour(), swatch.value);
  f.owner.dispose();
  assert.equal(document.getElementById("identity-editor"), null);
  assert.equal(document.getElementById("identity-chip")?.getAttribute("aria-expanded"), "false");
  assert.throws(() => f.owner.promptForName(), /not started/);
});

test("WPM and target popovers dispatch the existing commands and review keeps both disabled", () => {
  const f = setup();
  f.owner.promptForWpm();
  const input = document.getElementById("wpm-input") as HTMLInputElement;
  assert.equal(input.value, "120");
  input.value = "180";
  (document.getElementById("wpm-save") as HTMLButtonElement).click();
  assert.deepEqual(f.edits.ran.map((command) => command.name), ["set-words-per-minute"]);
  f.owner.promptForTarget();
  assert.equal(document.activeElement?.id, "target-input");
  (document.querySelector('[data-target-seconds="120"]') as HTMLButtonElement).click();
  assert.deepEqual(f.edits.ran.map((command) => command.name), ["set-words-per-minute", "set-target-length"]);
  f.review.setReviewing(true);
  f.owner.promptForWpm();
  assert.ok((document.getElementById("wpm-input") as HTMLInputElement).disabled);
  assert.ok((document.getElementById("target-input") as HTMLInputElement).disabled);
  assert.equal(document.activeElement?.id, "wpm-editor");
  f.owner.dispose();
  assert.equal(document.getElementById("wpm-editor"), null);
  const remounted = setup();
  remounted.owner.promptForName();
  assert.equal(document.querySelectorAll("#identity-editor").length, 1);
  remounted.owner.dispose();
});
