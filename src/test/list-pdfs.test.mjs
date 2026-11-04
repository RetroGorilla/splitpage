import "./_dom.mjs";
import "./_export-services-started.mjs";
import { printData } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { mountProductionTagsFeature as initTags } from "../bootstrap/wiring/production-tags.ts";
import "./_broll-mounted.mjs";
import { mountBrollPanelStateFeature as initBrollPanel } from "../bootstrap/wiring/broll.ts";
import { LONG_DEMO } from "../starters/index.ts";
import { loadTestDocument } from "./_document.mjs";

initTags();
const copy = (o) => JSON.parse(JSON.stringify(o));
const demo = () => { loadTestDocument(migrateRows(copy(LONG_DEMO.state))); };

function groupBy(pageGroup, filter) {
  localStorage.setItem("splitpage-broll-view", JSON.stringify({ filter: filter || "all", group: "scene", pageGroup }));
  initBrollPanel();
}

test("the print data says what each group is and where each scene starts", () => {
  demo();
  groupBy("scene");
  const data = printData();
  const g = data.groups[0];
  assert.deepEqual([g.label, g.kind, g.start, g.none], ["Beat A.4", "scene", "01:03", false]);
  assert.equal(g.items[0].start, "01:03");
  groupBy("location");
  const byPlace = printData().groups;
  assert.deepEqual(byPlace.map((x) => [x.label, x.kind, x.none]),
    [["Camera shop", "location", false], ["Riverside park", "location", false], ["workbench", "location", false], ["No location", "location", true]]);
  assert.ok(byPlace.every((x) => x.start === ""), "only a beat group starts somewhere");
  assert.equal(byPlace[0].items[0].start, "05:11");
});
