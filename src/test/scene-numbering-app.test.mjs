import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();
after(closeApp);

const { currentDocument, liveSession } = await import("../bootstrap/wiring/session-owner.ts");
const { documentReader } = await import("../bootstrap/wiring/ports/document.ts");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { buildSplitpageFile, buildMarkdownProject, parseMarkdownProject } = await import("../adapters/formats/project-file.ts");
const { beatFacts, breakdownRows, brollTable } = await import("../adapters/formats/export-projections.ts");
const { moveBeatCommand } = await import("../application/commands/rows.ts");
const { moveSceneCommand } = await import("../application/commands/scenes.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { renderRundown } = await import("../features/rundown/rundown.ts");
const { openBrollPanel } = await import("../features/broll/panel.ts");
const { openProductionPanel } = await import("../features/tags/panels.ts");
const writer = await import("../features/writer/writer.ts");
const present = await import("../features/prompter/prompter.ts");

async function open(text, name) {
  await openDocument({ kind: "file", file: new File([text], name), handle: null, options: { skipSnapshot: true } });
  undoOwner().flush();
}

test("#1186: an old document reorders, saves and reopens with identity, statuses, anchors and surface numbers intact", async () => {
  const tag = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug">Mug</span>';
  const broll = id => '<span class="broll-key" data-broll-id="' + id + '" contenteditable="false">B-roll:</span>';
  const old = { schema: 2, title: "Numbering acceptance", rows: [
    { id: "r1", audioText: "Prefix.", visualText: "", status: "ready" },
    { id: "r2", audioText: "Opening.", visualText: "", status: "todo" },
    { id: "r3", audioText: '<span class="cmt-anchor" data-cmt="c1">Keep this.</span>',
      visualText: broll("bs_one") + " One " + tag + "<br>" + broll("bs_two") + " Two", status: "shot" },
    { id: "r4", audioText: "Ending.", visualText: "", status: "todo" }
  ], sections: [{ id: "s1", name: "Opening", firstSceneId: "r2" }, { id: "s2", name: "Ending", firstSceneId: "r4" }],
  productionTags: [{ id: "t_mug", cat: "prop", name: "Mug", status: "have", notes: "Keep", owner: "" }],
  brollShots: [{ id: "bs_one", name: "One Mug", status: "shot", notes: "Keep footage", origin: "script" },
    { id: "bs_two", name: "Two", status: "unshot", origin: "script" }, { id: "bs_added", name: "Added", status: "shot", origin: "manual" }],
  comments: [{ id: "c1", anchorId: "c1", rowId: "r3", field: "audioText", kind: "anchor", body: "Plain B.8 stays.",
    quotedText: "Keep this.", author: "Adam", replies: [] }] };
  await open(JSON.stringify(old), "old.splitpage");
  const content = new Map(currentDocument().rows.map(row => [row.id, [row.visualText, row.audioText, row.status]]));
  assert.equal(liveSession().run(moveBeatCommand("r2", "r4", true)).kind, "applied");
  assert.equal(currentDocument().sections[0].firstSceneId, "r3");
  assert.equal(liveSession().run(moveSceneCommand("s2", "s1", false)).kind, "applied");
  const moved = currentDocument();
  const ids = moved.rows.map(row => row.id);
  assert.deepEqual(ids, ["r1", "r4", "r2", "r3"]);
  const retained = JSON.parse(JSON.stringify({ comments: moved.comments, tags: moved.productionTags, shots: moved.brollShots, sections: moved.sections }));
  const capture = exportDocumentOf(moved);
  const saved = buildSplitpageFile(capture);
  assert.equal(saved.includes('"numbering"'), false);
  assert.equal(saved.includes('"shotNumber"'), false);
  const markdown = buildMarkdownProject(capture);
  assert.deepEqual(parseMarkdownProject(markdown).state.rows.map(row => row.id), ids);
  await open(saved, "reopened.splitpage");
  const reopened = currentDocument();
  assert.deepEqual(reopened.rows.map(row => [row.id, [row.visualText, row.audioText, row.status]]), ids.map(id => [id, content.get(id)]));
  assert.deepEqual({ comments: reopened.comments, tags: reopened.productionTags, shots: reopened.brollShots, sections: reopened.sections }, retained);
  assert.equal(reopened.comments[0].rowId, "r3");
  assert.equal(reopened.comments[0].body, "Plain B.8 stays.");
  const expected = ["A.1", "B.1", "B.2", "C.1"];
  assert.deepEqual(ids.map(id => documentReader.numbering().beats[id].full), expected);
  assert.deepEqual(Array.from(document.querySelectorAll("#rows .row-num"), el => el.textContent), expected);
  const track = document.querySelector(".rundown-track");
  Object.defineProperty(track, "clientWidth", { configurable: true, value: 1200 });
  renderRundown();
  assert.deepEqual(Array.from(document.querySelectorAll(".rd-num"), el => el.textContent), ["1", "1", "2", "1"]);
  assert.deepEqual(Array.from(document.querySelectorAll(".rd-block"), el => el.title.split(" · ")[0]), expected.map(n => "Beat " + n));
  openBrollPanel();
  assert.match(document.querySelector('#broll-list [data-id="bs_one"] .broll-row-name').textContent, /^C\.1\.1 /);
  assert.match(document.querySelector('#broll-list [data-id="bs_two"] .broll-row-name').textContent, /^C\.1\.2 /);
  assert.equal(document.querySelector('#broll-list [data-id="bs_added"] .broll-row-name').textContent, "Added");
  openProductionPanel();
  assert.equal(document.querySelector('.tag-scene[data-row="r3"]').textContent, "1");
  writer.openWriter();
  assert.deepEqual(Array.from(document.querySelectorAll("#writer-doc .wr-num"), el => el.textContent), expected);
  writer.closeWriter();
  present.openPrompter();
  present.setPrompterBeatMode(true);
  assert.equal(document.getElementById("pp-scene-readout").textContent, "Beat C.1 of 4");
  for (let i = 0; i < 3; i++) present.stepBeat(-1);
  assert.equal(document.getElementById("pp-scene-readout").textContent, "Beat A.1 of 4");
  for (let i = 0; i < 3; i++) present.stepBeat(1);
  assert.equal(document.getElementById("pp-scene-readout").textContent, "Beat C.1 of 4");
  present.closePrompter();
  const exported = exportDocumentOf(reopened);
  assert.deepEqual(beatFacts(exported).map(row => row.number), expected);
  assert.deepEqual(breakdownRows(exported)[0].beats, ["C.1"]);
  assert.deepEqual(brollTable(exported).rows.map(row => row.cells.slice(0, 2)),
    [["C.1", "C.1.1 One Mug"], ["C.1", "C.1.2 Two"], ["", "Added"]]);
});

test("Remove scene header acts immediately, retains beats, and undoes the first header in one step", async () => {
  await open(JSON.stringify({ title: "Remove first", rows: [{ id: "r1", audioText: "First." }, { id: "r2", audioText: "Second." }],
    sections: [{ id: "first", name: "Named A", firstSceneId: "r1" }] }), "remove.splitpage");
  const before = JSON.parse(JSON.stringify(currentDocument()));
  const rows = JSON.stringify(currentDocument().rows);
  const count = undoOwner().sizes().undo;
  const button = document.querySelector('#rows [data-section-id="first"] [data-section-action="remove"]');
  assert.equal(button.textContent, "Remove scene header");
  button.click();
  assert.equal(currentDocument().sections, undefined);
  assert.equal(JSON.stringify(currentDocument().rows), rows);
  assert.equal(documentReader.numbering().scenes[0].id, null);
  assert.deepEqual(Array.from(document.querySelectorAll("#rows .row-num"), el => el.textContent), ["A.1", "A.2"]);
  undoOwner().flush();
  assert.equal(undoOwner().sizes().undo, count + 1);
  undoOwner().undo();
  assert.deepEqual(currentDocument(), before);
  assert.equal(document.querySelector('#rows [data-section-id="first"] .section-letter').textContent, "A");
});

test("grouped production beats keep full accessible numbers and filmed links", async () => {
  const tag = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug">Mug</span>';
  await open(JSON.stringify({ schema: 2, title: "Grouped beats", productionTags: [{ id: "mug", cat: "prop", name: "Mug", status: "have" }], rows: Array.from({ length: 94 }, (_, i) => ({
    id: "g" + i, audioText: tag, status: i === 13 ? "shot" : "todo"
  })), sections: [{ id: "second", name: "Second", firstSceneId: "g60" }] }), "grouped.splitpage");
  openProductionPanel();
  document.querySelector('#production-modes [data-group="cat"]').click();
  const groups = () => Array.from(document.querySelectorAll('#production-list .tag-beat-group'));
  assert.deepEqual(groups().map(g => g.querySelector('.tag-beat-letter').textContent), ["A", "B"]);
  assert.deepEqual(groups().map(g => g.querySelectorAll('button').length), [60, 34]);
  assert.equal(groups()[0].querySelectorAll('button')[13].textContent, "14");
  assert.match(groups()[0].querySelectorAll('button')[13].getAttribute('aria-label'), /^Beat A\.14 /);
  document.querySelector('#production-modes [data-group="shoot"]').click();
  assert.deepEqual(groups().map(g => g.querySelectorAll('button').length), [60, 34]);
  const filmed = document.querySelector('#production-list .tag-scene[data-row="g13"]');
  assert.equal(filmed.textContent, "14");
  assert.ok(filmed.querySelector('.tag-scene-tick'));
  assert.equal(filmed.title, filmed.getAttribute('aria-label'));
  assert.match(filmed.title, /^Beat A\.14 /);
  assert.equal(filmed.dataset.action, "jump-row");
});
