import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";

const GRIN = String.fromCodePoint(0x1F600);
const NAME_33 = "Maria ".repeat(5) + "Lee";
const NAME_31 = "Maria ".repeat(5) + "L";
const NAME_30_EMOJI = "x".repeat(29) + GRIN;
const NAME_KEY = "splitpage-comment-author";
const OPENED = "Opened the latest version — last edited by ";

localStorage.setItem(NAME_KEY, NAME_33);
await bootApp(JSON.stringify({ schema: 2, title: "Mine", rows: [], rev: 5, lastEditedBy: NAME_33 }));

const { migrateRows } = await import("../js/02-state.js");
const { getEditorName, promptForName } = await import("../js/03-sync.js");
const { getSavedAuthorName, openCommentComposer, postComment, postReply, toggleReplyComposer } = await import("../js/10-comments.js");
const { maybeAskGuestName } = await import("../js/13b-collaborate.js");
const { openSettings } = await import("../features/settings/settings.js");
const { render } = await import("../js/05-render.js");
const { toastLastEditor } = await import("../js/03-sync.js");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

function openedToasts() {
  return Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)"))
    .map((el) => el.textContent)
    .filter((text) => text.startsWith(OPENED));
}

function reopen(saved, onDisk) {
  document.getElementById("toast-host").replaceChildren();
  localStorage.setItem(NAME_KEY, saved);
  toastLastEditor(migrateRows({ schema: 2, title: "T", rows: [], rev: 5, lastEditedBy: onDisk }));
}

function typeInto(input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  return input.value;
}

test("a name over 30 characters: booting on the user's own saved file shows no toast", () => {
  assert.equal(currentDocument().lastEditedBy, NAME_33.slice(0, 30).trimEnd());
  assert.deepEqual(openedToasts(), []);
});

for (const [label, name] of [["33", NAME_33], ["31", NAME_31]]) {
  test(`a ${label}-character name: reopening your own file shows no toast`, () => {
    reopen(name, name);
    assert.deepEqual(openedToasts(), []);
  });
}

test("a short name: reopening your own file shows no toast", () => {
  reopen("Sam", "Sam");
  assert.deepEqual(openedToasts(), []);
});

test("a 30-character name with an emoji at the end keeps the whole emoji and shows no toast", () => {
  reopen(NAME_30_EMOJI, NAME_30_EMOJI);
  assert.deepEqual(openedToasts(), []);
  assert.equal(getEditorName(), NAME_30_EMOJI);
  assert.equal(migrateRows({ schema: 2, title: "T", rows: [], lastEditedBy: NAME_30_EMOJI }).lastEditedBy, NAME_30_EMOJI);
});

test("getEditorName cuts a name saved before the cap to 30 characters", () => {
  localStorage.setItem(NAME_KEY, NAME_33);
  assert.equal(getEditorName(), NAME_33.slice(0, 30).trimEnd());
  assert.equal(getSavedAuthorName(), NAME_33.slice(0, 30).trimEnd());
  localStorage.setItem(NAME_KEY, "x".repeat(29) + GRIN + "tail");
  assert.equal(getEditorName(), NAME_30_EMOJI);
  localStorage.setItem(NAME_KEY, "Sam");
  assert.equal(getEditorName(), "Sam");
});

test("another person's file still shows the toast with their name", () => {
  reopen("Sam", "Zed");
  assert.deepEqual(openedToasts(), [OPENED + "Zed"]);
});

test("another person's very long name shows the toast with the cut name", () => {
  reopen(NAME_33, "Zed ".repeat(30));
  assert.deepEqual(openedToasts(), [OPENED + "Zed ".repeat(30).slice(0, 30).trim()]);
});

test("the comment name field takes 30 characters and never half an emoji", () => {
  const field = document.getElementById("comment-name");
  assert.equal(typeInto(field, NAME_33), NAME_33.slice(0, 30));
  assert.equal(typeInto(field, "x".repeat(29) + GRIN + "tail"), NAME_30_EMOJI);
  assert.equal(typeInto(field, "Sam"), "Sam");
});

test("the reply name field takes 30 characters and never half an emoji", () => {
  loadTestDocument(migrateRows({
    schema: 2, title: "T",
    rows: [{ id: "r1", status: "todo", audioText: "the mug", visualText: "" }],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "mug", author: "Ann", body: "x", createdAt: "2026-10-01T10:00:00Z", kind: "anchor", replies: [] }]
  }));
  render();
  toggleReplyComposer("c1");
  const field = document.querySelector(".reply-composer .reply-name-input");
  assert.ok(field, "the reply composer shows");
  assert.equal(typeInto(field, "x".repeat(29) + GRIN + "tail"), NAME_30_EMOJI);
  assert.equal(typeInto(field, NAME_33), NAME_33.slice(0, 30));
});

test("a reply posted with a longer name than the field allows is stored under 30 characters", () => {
  const field = document.querySelector(".reply-composer .reply-name-input");
  field.value = NAME_33;
  document.querySelector(".reply-composer .cell-editable").innerHTML = "hello";
  postReply("c1");
  assert.equal(currentDocument().comments[0].replies[0].author, NAME_33.slice(0, 30).trimEnd());
  assert.equal(localStorage.getItem(NAME_KEY), NAME_33.slice(0, 30).trimEnd());
});

test("a comment posted with a longer name than the field allows is stored under 30 characters", () => {
  openCommentComposer({ id: "c9", rowId: "r1", field: "audioText", quotedText: "mug" });
  document.getElementById("comment-name").value = NAME_33;
  document.getElementById("comment-body-editable").innerHTML = "hello";
  postComment();
  const posted = currentDocument().comments.find((c) => c.id === "c9");
  assert.equal(posted.author, NAME_33.slice(0, 30).trimEnd());
  assert.equal(localStorage.getItem(NAME_KEY), NAME_33.slice(0, 30).trimEnd());
});

test("the identity chip's name field takes 30 characters and saves them", () => {
  localStorage.setItem(NAME_KEY, "Sam");
  promptForName();
  const field = document.getElementById("identity-input");
  assert.equal(typeInto(field, "x".repeat(29) + GRIN + "tail"), NAME_30_EMOJI);
  field.value = NAME_33;
  document.getElementById("identity-save").click();
  assert.equal(localStorage.getItem(NAME_KEY), NAME_33.slice(0, 30).trimEnd());
});

test("the Settings name field takes 30 characters and saves them", () => {
  localStorage.setItem(NAME_KEY, "Sam");
  openSettings();
  const field = document.getElementById("settings-name");
  assert.equal(typeInto(field, "x".repeat(29) + GRIN + "tail"), NAME_30_EMOJI);
  field.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(localStorage.getItem(NAME_KEY), NAME_30_EMOJI);
  field.value = NAME_33;
  field.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(localStorage.getItem(NAME_KEY), NAME_33.slice(0, 30).trimEnd());
});

test("the guest name field takes 30 characters and saves them", () => {
  localStorage.removeItem(NAME_KEY);
  sessionStorage.clear();
  assert.ok(maybeAskGuestName());
  const field = document.getElementById("guest-name");
  assert.equal(typeInto(field, "x".repeat(29) + GRIN + "tail"), NAME_30_EMOJI);
  document.querySelector('#guest-modal [data-guest-action="save"]').click();
  assert.equal(localStorage.getItem(NAME_KEY), NAME_30_EMOJI);
});
