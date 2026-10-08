import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

const NAME_83 = "Ann ".repeat(20) + "Lee";
const NAME_81 = "Ann ".repeat(20) + "L";
const NAME_KEY = "splitpage-comment-author";
const OPENED = "Opened the latest version — last edited by ";

localStorage.setItem(NAME_KEY, NAME_83);
await bootApp(JSON.stringify({ schema: 2, title: "Mine", rows: [], rev: 5, lastEditedBy: NAME_83 }));

const { migrateRows } = await import("../js/02-state.js");
const { toastLastEditor } = await import("../js/21-events.js");

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

test("a name over 80 characters: booting on the user's own saved file shows no toast", () => {
  assert.equal(S.state.lastEditedBy, NAME_83.slice(0, 80).trimEnd());
  assert.deepEqual(openedToasts(), []);
});

test("an 83-character name: reopening your own file shows no toast", () => {
  reopen(NAME_83, NAME_83);
  assert.deepEqual(openedToasts(), []);
});

test("an 81-character name: reopening your own file shows no toast", () => {
  reopen(NAME_81, NAME_81);
  assert.deepEqual(openedToasts(), []);
});

test("a short name: reopening your own file shows no toast", () => {
  reopen("Sam", "Sam");
  assert.deepEqual(openedToasts(), []);
});

test("another person's file still shows the toast with their name", () => {
  reopen("Sam", "Zed");
  assert.deepEqual(openedToasts(), [OPENED + "Zed"]);
});

test("another person's very long name shows the toast with the cut name", () => {
  reopen(NAME_83, "Zed ".repeat(30));
  assert.deepEqual(openedToasts(), [OPENED + "Zed ".repeat(30).slice(0, 80).trim()]);
});
