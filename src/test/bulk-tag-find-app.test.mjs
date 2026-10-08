import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { openBulkTag, closeBulkTag, runBulkTag } = await import("../js/09-find-replace.js");

after(closeApp);

const emoji = String.fromCharCode(0xd83d, 0xde00);
const high = String.fromCharCode(0xd83d);
const low = String.fromCharCode(0xde00);
const BLANK = "Type the words to tag in the Find box first.";

function load(visual) {
  S.state = migrateRows({
    schema: 2, title: "Bulk", productionTags: [],
    rows: [{ id: "r1", status: "todo", visualText: visual, audioText: "" }]
  });
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
  const before = JSON.stringify(S.state);
  typeIntoFind("");
  const seenBefore = toasts().length;
  runBulkTag();
  const emptyToast = toasts().slice(seenBefore);
  assert.deepEqual(emptyToast, [BLANK]);
  typeIntoFind(high);
  const mark = toasts().length;
  runBulkTag();
  assert.deepEqual(toasts().slice(mark), emptyToast);
  assert.equal(JSON.stringify(S.state), before);
  assert.deepEqual(S.state.productionTags, []);
});

test("bulk tag: a lone half beside real words is dropped, so the words are tagged under their own name", () => {
  load("see the drone now");
  typeIntoFind("drone" + high);
  openBulkTag();
  assert.match(document.getElementById("find-tag-ask").textContent, /^Tag 1 mention of drone as /);
  assert.equal(document.getElementById("find-tag-ask").querySelector("em").textContent, "drone");
  closeBulkTag();
  runBulkTag();
  assert.deepEqual(S.state.productionTags.map((t) => t.name), ["drone"]);
  assert.match(S.state.rows[0].visualText, /data-tag-name="drone"/);
  assert.doesNotMatch(S.state.rows[0].visualText, /[\ud800-\udfff]/);
});

test("bulk tag: the category picked for a name already registered ignores a lone half in the needle", () => {
  S.state = migrateRows({
    schema: 2, title: "Bulk", rows: [{ id: "r1", status: "todo", visualText: "see the drone now", audioText: "" }],
    productionTags: [{ id: "t_drone", cat: "gear", name: "drone", owner: "", notes: "", status: "needed" }]
  });
  typeIntoFind("drone" + high);
  openBulkTag();
  assert.equal(document.querySelector("#find-tag-cats .tag-cat-btn.is-active").getAttribute("data-tag-cat"), "gear");
  closeBulkTag();
});
