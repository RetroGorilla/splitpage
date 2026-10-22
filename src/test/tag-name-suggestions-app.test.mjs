import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { openTagComposer, closeTagComposer } = await import("../js/07-production-tags.js");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "Kettle"];

function suggestions() {
  openTagComposer({ quotedText: "kettle", cat: "prop" });
  const names = Array.from(document.querySelectorAll("#tag-name-list option")).map((o) => o.getAttribute("value"));
  closeTagComposer();
  return names;
}

test("the tag name suggestions list every registered name, including those named after Object's own properties", () => {
  loadTestDocument(migrateRows({
    schema: 2, title: "Names", rows: [],
    productionTags: NAMES.map((name) => ({ id: "t_" + name.toLowerCase().replace(/_/g, ""), cat: "prop", name, owner: "", notes: "", status: "needed" }))
  }));
  assert.deepEqual(suggestions(), NAMES.slice().sort());
});

test("a name used in two categories is listed once", () => {
  loadTestDocument(migrateRows({
    schema: 2, title: "Names", rows: [],
    productionTags: [
      { id: "t_a", cat: "prop", name: "__proto__", owner: "", notes: "", status: "needed" },
      { id: "t_b", cat: "gear", name: "__proto__", owner: "", notes: "", status: "needed" }
    ]
  }));
  assert.deepEqual(suggestions(), ["__proto__"]);
});
