import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { createHeldFileHandle, mockClock } from "./_m4-matrix.mjs";
import { parseSplitpageFile } from "../adapters/formats/splitpage-file.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { render } = await import("../js/05-render.js");
const { productionEntries, updateTagBadges } = await import("../js/07-production-tags.js");
const { openProductionPanel, closeProductionPanel, renderProduction, setTagNotes, setTagStatus } = await import("../js/08-production-panels.js");
const { anchorBrollInLeftCell, brollEntries, runBrollRefresh, updateBrollBadge } = await import("../js/08c-broll.js");
const { openBrollPanel, closeBrollPanel, renderBroll } = await import("../js/08d-broll-panel.js");
const { clearDirty, markDirty } = await import("../js/12-dirty-toast.js");
const { flushEdits, undo } = await import("../js/12a-undo.js");
const { saveDoc, setAutoSaveEnabled } = await import("../js/14-export.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const homeModule = await import("../js/_home.js");
const { cellRuns, cellTextCommand } = await import("../application/commands/cell-text.ts");
const { changeSet } = await import("../application/session/change-set.ts");
const { scriptCellOf } = await import("../legacy/richtext.ts");
const { liveSession, runCommand, sessionTextPorts } = await import("../legacy/session-bridge.ts");

after(closeApp);

const tag = (cat, name) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;
const key = (id, text) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">${text}</span>`;

function fixture() {
  return migrateRows({
    schema: 5, title: "Repair on read", docId: "d" + "9".repeat(32),
    rows: [
      { id: "r1", visualText: key("bs_steam", "B-roll:") + " Steam", audioText: "Put the " + tag("prop", "kettle") + " on.", status: "todo" },
      { id: "r2", visualText: "Wide", audioText: "Pour.", status: "todo" }
    ],
    brollShots: [{ id: "bs_steam", name: "Steam" }]
  });
}

let opened = 0;
async function open(doc = fixture()) {
  const handle = createHeldFileHandle({ name: "repair-" + (++opened) + ".splitpage", text: buildSplitpageFile(exportDocumentOf(doc)), lastModified: 1000 });
  await openProjectFile(await handle.handle.getFile(), handle.handle, { skipSnapshot: true, silent: true });
  flushEdits();
  clearDirty();
  return handle;
}

const cellEl = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');
const tagKeys = () => S.state.productionTags.map((t) => t.cat + " " + t.name);
const shotNames = () => S.state.brollShots.map((s) => s.id + " " + s.name);

function lagging() {
  S.state.rows[1].visualText = "B-roll: Hands";
  S.state.rows[1].audioText = "Pour into the " + tag("prop", "mug") + ".";
  S.state.brollShots = S.state.brollShots.map((s) => Object.assign({}, s, { name: "steam" }));
}

function snapshot() {
  return { doc: JSON.stringify(S.state), generation: liveSession().generation(), seq: S.editSeq, dirty: S.dirty };
}

function assertUntouched(before, seen, where) {
  assert.equal(JSON.stringify(S.state), before.doc, where + ": the document, its tag registry and its b-roll list are as they were");
  assert.equal(liveSession().generation(), before.generation, where + ": generation");
  assert.equal(S.editSeq, before.seq, where + ": edit sequence");
  assert.equal(S.dirty, before.dirty, where + ": unsaved state");
  assert.deepEqual(seen, [], where + ": published");
}

function setCell(rowId, field, html) {
  return runCommand(cellTextCommand(rowId, field, cellRuns(scriptCellOf(html)), sessionTextPorts));
}

test("6.5: render, the idle refreshes, the panels, the badges and the export kit read a document whose records lag its script and write nothing", async () => {
  await open();
  lagging();
  const before = snapshot();
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c.kind));
  try {
    const reads = {
      render: () => render(),
      "tag badges": () => updateTagBadges(),
      "production panel": () => { openProductionPanel(); renderProduction(); closeProductionPanel(); },
      "b-roll refresh": () => runBrollRefresh(),
      "b-roll badge": () => updateBrollBadge(),
      "b-roll panel": () => { openBrollPanel(); renderBroll(); closeBrollPanel(); },
      "b-roll entries": () => brollEntries(),
      "production entries": () => productionEntries(),
      "export kit": () => buildSplitpageFile(exportDocumentOf(S.state))
    };
    for (const [where, read] of Object.entries(reads)) {
      read();
      assertUntouched(before, seen, where);
    }
    assert.deepEqual(brollEntries().map((e) => e.name), ["Steam", "Hands"]);
    assert.ok(productionEntries().some((e) => e.key === "prop mug" && e.id === null), "the read shows the unregistered tag as it is");
  } finally {
    stop();
  }
});

test("6.5: a save changes nothing in the held document; the file carries the entry form of what is held", async (t) => {
  mockClock(t);
  setAutoSaveEnabled(false);
  try {
    const target = await open();
    markDirty();
    lagging();
    const held = JSON.stringify(S.state.rows) + JSON.stringify(S.state.productionTags) + JSON.stringify(S.state.brollShots);
    const entry = migrateRows(JSON.parse(JSON.stringify(S.state)));
    const gen = liveSession().generation();
    const seen = [];
    const stop = liveSession().subscribe((c) => seen.push(c.kind));
    try {
      await saveDoc();
    } finally {
      stop();
    }
    assert.deepEqual(seen, []);
    assert.equal(liveSession().generation(), gen);
    assert.equal(JSON.stringify(S.state.rows) + JSON.stringify(S.state.productionTags) + JSON.stringify(S.state.brollShots), held);
    assert.equal(S.dirty, false);
    const saved = parseSplitpageFile(await (await target.handle.getFile()).text());
    assert.deepEqual(saved.productionTags.map((x) => x.cat + " " + x.name), entry.productionTags.map((x) => x.cat + " " + x.name));
    assert.deepEqual(saved.brollShots.map((x) => x.name), entry.brollShots.map((x) => x.name));
  } finally {
    homeModule.setHome("none");
    clearDirty();
  }
});

test("6.5: typing a tag registers it in the same transaction, and one undo takes both back", async () => {
  await open();
  const gen = liveSession().generation();
  const out = setCell("r2", "audioText", "Pour into the " + tag("prop", "mug") + ".");
  assert.equal(out.kind, "applied");
  assert.ok(out.changes.docFields.includes("productionTags"), JSON.stringify(out.changes));
  assert.equal(liveSession().generation(), gen + 1);
  assert.ok(tagKeys().includes("prop mug"));
  flushEdits();
  undo();
  assert.equal(S.state.rows[1].audioText, "Pour.");
  assert.ok(!tagKeys().includes("prop mug"));
});

test("6.5: editing a keyed b-roll line's name renames its record in the same transaction", async () => {
  await open();
  const gen = liveSession().generation();
  const out = setCell("r1", "visualText", key("bs_steam", "B-roll:") + " Steam rising");
  assert.equal(out.kind, "applied");
  assert.ok(out.changes.docFields.includes("brollShots"), JSON.stringify(out.changes));
  assert.equal(liveSession().generation(), gen + 1);
  assert.deepEqual(shotNames(), ["bs_steam Steam rising"]);
});

test("6.5: a typed b-roll line in a scene that was already there is keyed when the cell is left, in one command that creates its record", async () => {
  await open();
  const out = setCell("r2", "visualText", "Wide<br>B-roll: Hands");
  assert.equal(out.kind, "applied");
  assert.deepEqual(shotNames(), ["bs_steam Steam"], "an unkeyed line in an edited scene gets no record per keystroke");
  const gen = liveSession().generation();
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c.kind));
  try {
    assert.equal(anchorBrollInLeftCell(cellEl("r2", "visualText")), 1);
  } finally {
    stop();
  }
  assert.deepEqual(seen, ["edit"]);
  assert.equal(liveSession().generation(), gen + 1);
  const made = S.state.brollShots.find((s) => s.name === "Hands");
  assert.ok(made, shotNames().join(", "));
  assert.equal(S.state.rows[1].visualText, "Wide<br>" + key(made.id, "B-roll:") + " Hands");
  assert.equal(anchorBrollInLeftCell(cellEl("r2", "visualText")), 0, "leaving the cell again changes nothing");
});

test("6.5: a document the current code wrote round-trips through entry with no repair", async () => {
  await open();
  setCell("r2", "audioText", "Pour into the " + tag("prop", "mug") + ".");
  setCell("r2", "visualText", "Wide<br>B-roll: Hands");
  anchorBrollInLeftCell(cellEl("r2", "visualText"));
  setCell("r1", "visualText", key("bs_steam", "B-roll:") + " Steam rising");
  const held = JSON.parse(JSON.stringify(S.state));
  assert.deepEqual(tagKeys(), ["prop kettle", "prop mug"]);
  assert.equal(S.state.brollShots.length, 2);
  const entered = migrateRows(parseSplitpageFile(buildSplitpageFile(exportDocumentOf(S.state))));
  assert.deepEqual(entered.productionTags, held.productionTags);
  assert.deepEqual(entered.brollShots, held.brollShots);
  assert.deepEqual(entered.rows.map((r) => [r.visualText, r.audioText]), held.rows.map((r) => [r.visualText, r.audioText]));
  assert.deepEqual(migrateRows(JSON.parse(JSON.stringify(entered))), entered, "entering it again changes nothing");
});

test("6.5: a panel action on a tag the registry lacks registers it inside the action's own edit, even when the action changes nothing else", async () => {
  await open();
  lagging();
  const gen = liveSession().generation();
  setTagNotes("prop mug", "");
  assert.ok(tagKeys().includes("prop mug"));
  assert.equal(liveSession().generation(), gen + 1, "the registration was noted as an edit");
  setTagNotes("prop mug", "");
  assert.equal(liveSession().generation(), gen + 1, "nothing new to note");
  S.state.productionTags = S.state.productionTags.filter((x) => x.name !== "mug");
  setTagStatus("prop mug", "have");
  assert.equal(S.state.productionTags.find((x) => x.name === "mug").status, "have");
  assert.equal(liveSession().generation(), gen + 2, "one edit for the registration and the status");
});

test("6.5 follow-up: a cue rename seen by an edit that rolls back is seen again when the edit is made again", async () => {
  const cue = (inner) => `<span class="audio-cue">${inner}</span>`;
  await open(migrateRows({
    schema: 5, title: "Cue retry", docId: "d" + "8".repeat(32),
    rows: [{ id: "r1", visualText: "Kitchen", audioText: cue("SFX: door slam"), status: "todo" }]
  }));
  const sounds = () => S.state.productionTags.filter((t) => t.cat === "sound").map((t) => t.id + " " + t.name);
  const kept = S.state.productionTags.find((t) => t.cat === "sound" && t.name === "door slam");
  assert.ok(kept, sounds().join(", "));
  assert.equal(setCell("r1", "visualText", "Kitchen, morning").kind, "applied");

  const comments = S.state.comments;
  S.state.comments = { slice() { throw new Error("anchors broke"); } };
  let failed;
  try {
    failed = runCommand({
      name: "rename-cue",
      needs: "edit",
      plan: () => ({
        changes: changeSet({ cells: [{ rowId: "r1", field: "audioText" }], runsMoved: true }),
        apply: (live) => { live.rows[0].audioText = cue("SFX: door slams"); }
      })
    });
  } finally {
    S.state.comments = comments;
  }
  assert.equal(failed.kind, "failed");
  assert.equal(S.state.rows[0].audioText, cue("SFX: door slam"), "the edit rolled back");
  assert.deepEqual(sounds(), [kept.id + " door slam"], "the retitle rolled back with it");

  assert.equal(setCell("r1", "audioText", cue("SFX: door slams")).kind, "applied");
  assert.deepEqual(sounds(), [kept.id + " door slams"], "the same entry is renamed, not a second one registered");
});
