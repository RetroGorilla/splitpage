import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildExportDocument } from "../../../src/core/document/export-document.ts";
import { FILTERS, PAGE_GROUPS } from "../../../src/core/production/broll-view.ts";
import { TAG_STATUSES } from "../../../src/core/production/looks.ts";
import { breakdownGroups, exportDateText, exportDay } from "../../../src/adapters/formats/export-kit.ts";
import { brollShotListForPrint } from "../../../src/adapters/formats/export-projections.ts";
import { buildPackingListPrintPage, buildShotListPrintPage, buildScriptWithListsPrintPage, listPrintSections } from "../../../src/adapters/formats/list-print.ts";
import { listFixture } from "./fixtures/list-print-fixture.mjs";

function page(html) { return new JSDOM(html).window.document; }
function texts(dom, selector) { return [...dom.querySelectorAll(selector)].map((el) => el.textContent); }

test("gear and prop packing lists preserve alphabetic rows, captured facts, status progress, boxes and signatures", () => {
  const { input } = listFixture();
  for (const catId of ["gear", "prop"]) {
    const dom = page(buildPackingListPrintPage(input, catId));
    const group = breakdownGroups(input.doc).find((entry) => entry.catId === catId);
    const items = group.items.slice().sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(dom.title, input.doc.title + " — " + group.label + " packing list");
    assert.equal(dom.querySelector("h1").textContent, group.label);
    assert.ok(dom.body.textContent.includes(input.doc.title));
    assert.ok(dom.body.textContent.includes(exportDateText(exportDay(input.doc))));
    assert.deepEqual(texts(dom, "thead th"), ["Out", "Back", "Item", "Status", "Owner", "Scenes"]);
    const rows = [...dom.querySelectorAll("tbody tr")];
    assert.equal(rows.length, items.length);
    items.forEach((item, i) => {
      const cells = rows[i].querySelectorAll("td");
      assert.equal(cells[2].querySelector("strong").textContent, item.name);
      assert.equal(cells[3].querySelector(".scene-meta").textContent, item.statusLabel);
      assert.equal(cells[3].querySelectorAll(".filled").length, TAG_STATUSES.findIndex((s) => s.id === item.status) + 1);
      assert.equal(cells[4].textContent, item.owner);
      assert.equal(cells[5].textContent, item.inScript === "no" ? "Not in script" : item.scenes.join(", "));
      if (item.notes) assert.ok(cells[2].textContent.includes(item.notes));
      for (const shot of item.broll) assert.ok(cells[2].textContent.includes(shot));
    });
    assert.equal(dom.querySelectorAll(".list-checkbox").length, items.length * 2);
    assert.equal(dom.querySelectorAll(".list-checkbox.checked").length, 0);
    assert.deepEqual(texts(dom, ".packing-key > span"), ["Status", ...TAG_STATUSES.map((s) => s.label)]);
    assert.equal(dom.querySelectorAll(".signature-line").length, 4);
    assert.match(dom.querySelector(".packing-signatures").textContent, /Packed byDateReturned byDate/);
  }
  assert.match(page(buildPackingListPrintPage(input, "prop")).body.textContent, /2 items · 1 have it · 1 sourcing/);
  assert.match(page(buildPackingListPrintPage(input, "gear")).body.textContent, /2 items · 1 needed · 1 returned/);
});

test("shot lists use every existing filter and grouping with projected counts and full row content", () => {
  const { input } = listFixture();
  for (const filter of FILTERS) for (const group of PAGE_GROUPS) {
    const options = { filter: filter.id, group: group.id };
    const data = brollShotListForPrint(input.doc, options, input.services);
    const dom = page(buildShotListPrintPage(input, options));
    assert.ok(dom.body.textContent.includes(data.summary + " · " + data.scope));
    assert.ok(dom.body.textContent.includes(exportDateText(exportDay(input.doc))));
    assert.deepEqual(texts(dom, "thead th"), ["Done", "Scene", "B-roll shot", "Location", "Props", "Assigned", "Flagged", "Notes"]);
    assert.deepEqual(texts(dom, ".list-group th"), data.groups.map((g) => g.label + " " + g.done + "/" + g.total + " shot"));
    const items = data.groups.flatMap((g) => g.items.map((item) => ({ item, kind: g.kind })));
    const rows = [...dom.querySelectorAll("tbody tr:not(.list-group)")];
    assert.equal(rows.length, items.length);
    rows.forEach((row, i) => {
      const { item, kind } = items[i];
      const cells = row.querySelectorAll("td");
      assert.equal(!!cells[0].querySelector(".checked"), item.shot);
      assert.equal(cells[0].querySelector("span").getAttribute("aria-label"), item.status);
      assert.equal(cells[1].textContent, item.scene + item.start);
      assert.equal(cells[2].querySelector("strong").textContent, item.name);
      for (const detail of [item.desc, item.cuts]) if (detail) assert.ok(cells[2].textContent.includes(detail));
      assert.equal(cells[3].textContent, kind === "location" ? "" : item.location);
      assert.deepEqual([...cells[4].children].map((el) => el.textContent), item.propsWithStatus);
      assert.equal(cells[5].textContent, kind === "person" ? "" : item.owner);
      assert.equal(cells[6].textContent, item.flagged ? "Flagged" + item.note : "");
      assert.equal(cells[7].textContent, item.flagged ? "" : item.note);
      assert.ok(cells[7].querySelector(".writing-lines"));
    });
  }
  assert.equal(buildShotListPrintPage(input, { filter: "bad", group: "bad" }), buildShotListPrintPage(input));
});

test("script composition keeps every breakdown category, all scene-grouped shots, then comments", () => {
  const { input } = listFixture();
  const dom = page(buildScriptWithListsPrintPage(input));
  assert.equal(dom.querySelectorAll("section").length, 4);
  assert.deepEqual([...dom.querySelectorAll("section")].map((el) => el.id), ["script", "production-breakdown", "broll-shot-list", "comments"]);
  assert.deepEqual(texts(dom, ".breakdown-table thead th"), ["Item", "Status", "Scenes", "Assigned to"]);
  assert.deepEqual(texts(dom, ".breakdown-table .list-group th"), breakdownGroups(input.doc).map((g) => g.label + " " + g.items.length));
  for (const group of breakdownGroups(input.doc)) for (const item of group.items) {
    const row = [...dom.querySelectorAll(".breakdown-table td:first-child")].find((cell) => cell.textContent.startsWith(item.name)).parentElement;
    for (const fact of [item.statusLabel, item.scenes.join(", "), item.owner || "—", item.notes, ...item.broll]) assert.ok(row.textContent.includes(fact));
  }
  assert.match(dom.querySelector("#broll-shot-list").textContent, /by scene/);
  assert.equal(dom.querySelectorAll(".shot-table .list-checkbox").length, input.doc.broll.length);
  assert.match(dom.querySelector("#comments").textContent, /End reply/);
});

test("empty standalone lists keep their explicit messages while script appendices are omitted", () => {
  const { input } = listFixture("empty");
  for (const cat of ["gear", "prop"]) {
    const dom = page(buildPackingListPrintPage(input, cat));
    assert.match(dom.body.textContent, /Nothing tagged .+ yet\./);
    assert.equal(dom.querySelectorAll("table,.packing-signatures,.packing-key").length, 0);
  }
  assert.match(page(buildShotListPrintPage(input)).body.textContent, /No shots to list\./);
  assert.deepEqual(listPrintSections(input), []);
  assert.equal(page(buildScriptWithListsPrintPage(input)).querySelectorAll("section").length, 1);
  const rich = listFixture().input;
  const flagged = { ...rich, doc: buildExportDocument(rich.doc.document, rich.doc.capturedAt, { production: [], broll: rich.doc.broll.map((s) => ({ ...s, reshoot: false })), commentNumbers: {} }) };
  assert.match(page(buildShotListPrintPage(flagged, { filter: "flagged" })).body.textContent, /No shots to list\./);
});

test("list HTML escapes all captured content and accepts no active markup or external resources", () => {
  const { source, models, input } = listFixture();
  const hostile = '</td><script>alert(1)</script><img src=x onerror="bad">&"';
  source.title = hostile;
  source.people.forEach((person) => { person.name = hostile; });
  models.production.forEach((item) => { item.name = hostile; item.notes = hostile; });
  models.broll.forEach((shot) => { shot.name = hostile; shot.desc = hostile; shot.location = hostile; shot.audioRef = hostile; shot.notes = hostile; shot.props.forEach((p) => { p.name = hostile; }); });
  const doc = buildExportDocument(source, input.doc.capturedAt, models);
  for (const html of [buildPackingListPrintPage({ ...input, doc }, "prop"), buildPackingListPrintPage({ ...input, doc }, hostile), buildShotListPrintPage({ ...input, doc }, { group: "location" }), buildScriptWithListsPrintPage({ ...input, doc })]) {
    const dom = page(html);
    assert.equal(dom.querySelectorAll("script,iframe,object,embed,link,base,[onerror],[onload]").length, 0);
    assert.ok(dom.body.textContent.includes(hostile));
    assert.match(dom.querySelector('meta[http-equiv="Content-Security-Policy"]').content, /default-src 'none'/);
    for (const image of dom.images) assert.ok(image.src.startsWith("data:image/"));
  }
});

test("held captures survive later source, production, shot and person edits; the captured day is deterministic", () => {
  const { source, models, input } = listFixture();
  const render = (value) => [buildPackingListPrintPage(value, "gear"), buildPackingListPrintPage(value, "prop"), buildShotListPrintPage(value), buildScriptWithListsPrintPage(value)];
  const before = render(input);
  source.title = "Changed title";
  source.rows[0].audioText = "Changed audio";
  source.people[0].name = "Changed owner";
  models.production[0].notes = "Changed packing note";
  models.production[0].status = "returned";
  models.broll[0].name = "Changed shot";
  models.broll[0].reshoot = false;
  assert.deepEqual(render(input), before);
  assert.notDeepEqual(render({ ...input, doc: buildExportDocument(source, input.doc.capturedAt, models) }), before);
  const morning = new Date(2026, 9, 30, 1).toISOString(), evening = new Date(2026, 9, 30, 23).toISOString();
  assert.deepEqual(render({ ...input, doc: buildExportDocument(source, morning, models) }), render({ ...input, doc: buildExportDocument(source, evening, models) }));
});

test("long labels, oversized rows and non-Latin text remain complete in standalone and composed output", () => {
  const { input } = listFixture("long");
  const packing = page(buildPackingListPrintPage(input, "prop"));
  assert.match(packing.body.textContent, /Packing note line 99/);
  assert.match(packing.body.textContent, /Spare 088/);
  const shots = page(buildShotListPrintPage(input));
  assert.match(shots.body.textContent, /Shot description line 109/);
  assert.match(shots.body.textContent, /Final notes 64/);
  assert.match(shots.body.textContent, /中文/);
  assert.match(shots.body.textContent, /日本語/);
  assert.match(shots.body.textContent, /العربية/);
  assert.match(buildScriptWithListsPrintPage(input), /Battery हिन्दी/);
  assert.equal(shots.querySelectorAll(".writing-lines").length, input.doc.broll.length);
});
