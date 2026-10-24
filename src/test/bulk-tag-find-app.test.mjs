import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { openBulkTag, closeBulkTag, runBulkTag } = await import("../features/find/find.js");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const emoji = String.fromCharCode(0xd83d, 0xde00);
const high = String.fromCharCode(0xd83d);
const low = String.fromCharCode(0xde00);
const BLANK = "Type the words to tag in the Find box first.";

function load(visual) {
  loadTestDocument(migrateRows({
    schema: 2, title: "Bulk", productionTags: [],
    rows: [{ id: "r1", status: "todo", visualText: visual, audioText: "" }]
  }));
}

function typeIntoFind(text) {
  document.getElementById("find-input").value = text;
}

function ask() {
  openBulkTag();
  const out = { text: document.getElementById("find-tag-ask").textContent, disabled: document.getElementById("find-tag-go").disabled };
  closeBulkTag();
  return out;
}

function toasts() {
  return Array.from(document.getElementById("toast-host").children).map((el) => el.textContent);
}

test("bulk tag: a needle that is only a lone half asks the same as an empty Find box", () => {
  load("a " + emoji + " b");
  typeIntoFind("");
  const empty = ask();
  assert.equal(empty.text, BLANK);
  assert.equal(empty.disabled, true);
  typeIntoFind(high);
  assert.deepEqual(ask(), empty);
  typeIntoFind(low);
  assert.deepEqual(ask(), empty);
  typeIntoFind(" " + high + " ");
  assert.deepEqual(ask(), empty);
});

test("bulk tag: Go with a lone half tags nothing and registers nothing, like an empty box", () => {
  load("a " + emoji + " b");
  const before = JSON.stringify(currentDocument());
  typeIntoFind("");
  const seenBefore = toasts().length;
  runBulkTag();
  const emptyToast = toasts().slice(seenBefore);
  assert.deepEqual(emptyToast, [BLANK]);
  typeIntoFind(high);
  const mark = toasts().length;
  runBulkTag();
  assert.deepEqual(toasts().slice(mark), emptyToast);
  assert.equal(JSON.stringify(currentDocument()), before);
  assert.deepEqual(currentDocument().productionTags, []);
});

test("bulk tag: a lone half beside real words is dropped, so the words are tagged under their own name", () => {
  load("see the drone now");
  typeIntoFind("drone" + high);
  openBulkTag();
  assert.match(document.getElementById("find-tag-ask").textContent, /^Tag 1 mention of drone as /);
  assert.equal(document.getElementById("find-tag-ask").querySelector("em").textContent, "drone");
  closeBulkTag();
  runBulkTag();
  assert.deepEqual(currentDocument().productionTags.map((t) => t.name), ["drone"]);
  assert.match(currentDocument().rows[0].visualText, /data-tag-name="drone"/);
  assert.doesNotMatch(currentDocument().rows[0].visualText, /[\ud800-\udfff]/);
});

test("bulk tag: a lone half before a word is dropped, and the word is tagged under its own name", () => {
  load("see the drone now");
  typeIntoFind(high + " drone");
  openBulkTag();
  assert.match(document.getElementById("find-tag-ask").textContent, /^Tag 1 mention of drone as /);
  closeBulkTag();
  runBulkTag();
  assert.deepEqual(currentDocument().productionTags.map((t) => t.name), ["drone"]);
  assert.match(currentDocument().rows[0].visualText, /data-tag-name="drone"/);
});

test("bulk tag: a trailing space in the Find box is trimmed, so the tag is registered as the word", () => {
  load("see the drone now");
  typeIntoFind("drone ");
  openBulkTag();
  assert.match(document.getElementById("find-tag-ask").textContent, /^Tag 1 mention of drone as /);
  closeBulkTag();
  runBulkTag();
  assert.deepEqual(currentDocument().productionTags.map((t) => t.name), ["drone"]);
  assert.match(currentDocument().rows[0].visualText, /data-tag-name="drone"/);
});

test("bulk tag: a whole emoji in the Find box is a needle, alone or after words", () => {
  load("a " + emoji + " b");
  typeIntoFind(emoji);
  openBulkTag();
  assert.ok(document.getElementById("find-tag-ask").textContent.startsWith("Tag 1 mention of " + emoji + " as "));
  assert.equal(document.getElementById("find-tag-go").disabled, false);
  closeBulkTag();
  runBulkTag();
  assert.deepEqual(currentDocument().productionTags.map((t) => t.name), [emoji]);
  load("see the drone" + emoji + " now");
  typeIntoFind("drone" + emoji);
  openBulkTag();
  assert.ok(document.getElementById("find-tag-ask").textContent.startsWith("Tag 1 mention of drone" + emoji + " as "));
  closeBulkTag();
  runBulkTag();
  assert.deepEqual(currentDocument().productionTags.map((t) => t.name), ["drone" + emoji]);
  assert.ok(currentDocument().rows[0].visualText.includes('data-tag-name="drone' + emoji + '"'));
});

test("bulk tag: the category picked for a name already registered ignores a lone half in the needle", () => {
  loadTestDocument(migrateRows({
    schema: 2, title: "Bulk", rows: [{ id: "r1", status: "todo", visualText: "see the drone now", audioText: "" }],
    productionTags: [{ id: "t_drone", cat: "gear", name: "drone", owner: "", notes: "", status: "needed" }]
  }));
  typeIntoFind("drone" + high);
  openBulkTag();
  assert.equal(document.querySelector("#find-tag-cats .tag-cat-btn.is-active").getAttribute("data-tag-cat"), "gear");
  closeBulkTag();
});
