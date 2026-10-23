import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { ChangeSet } from "../../../src/application/session/change-set.ts";
import type { CommandOutcome } from "../../../src/application/session/document-session.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { createSceneStatus } from "../../../src/features/rows/scene-status.ts";
import { productionReaders } from "../../../src/legacy/document-ports.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeEdits, fakeNotices } from "../fakes.ts";

const REFUSAL = "review only";
const TEN = "one two three four five six seven eight nine ten";

function setup(opts: { targetSeconds?: number; hideShot?: boolean; status?: string; applies?: boolean } = {}) {
  document.body.innerHTML = '<button id="runtime-chip"><span class="rd-length-total"></span><span class="rd-length-slot"></span></button>' +
    '<span id="progress-chip" hidden><span id="progress-text"></span></span>';
  const doc = migrateRows({
    title: "Status",
    targetSeconds: opts.targetSeconds,
    rows: [
      { id: "r1", visualText: "", audioText: TEN, status: opts.status || "todo" },
      { id: "r2", visualText: "", audioText: TEN, status: "todo" }
    ]
  }, fakeMigration().ports);
  const held = fakeDocument(doc);
  const edits = fakeEdits();
  const notices = fakeNotices();
  const grace: string[] = [];
  const owner = createSceneStatus({
    document: held.document,
    edits: opts.applies ? {
      run: (command) => {
        edits.edits.run(command);
        const plan = command.plan(doc, { edit: () => ({ allowed: true }) });
        if (plan && "apply" in plan) plan.apply(doc);
        const outcome: CommandOutcome = { kind: "applied", generation: 1, changes: changeSet({}) };
        return outcome;
      },
      stamps: edits.edits.stamps
    } : edits.edits,
    reviewRefusal: REFUSAL,
    text: { productionReaders },
    notices: notices.notices,
    hideShot: () => !!opts.hideShot,
    shots: { armGrace: (id) => { grace.push("arm:" + id); }, clearGrace: (id) => { grace.push("clear:" + id); } },
    element: (id) => document.getElementById(id)
  });
  return { doc, held, edits, notices, grace, owner };
}

function change(changes: ChangeSet) {
  return { kind: "edit" as const, epoch: 1, generation: 1, changes };
}


test("scene status: the stats paint the read time against the target and tell listeners the target", () => {
  const { owner } = setup({ targetSeconds: 60 });
  const heard: number[] = [];
  const stop = owner.onScriptStats((target) => { heard.push(target); });
  owner.updateScriptStats();
  const chip = document.getElementById("runtime-chip");
  assert.ok(chip);
  assert.equal(chip.querySelector(".rd-length-total")?.innerHTML, "0:08");
  assert.match(chip.querySelector(".rd-length-slot")?.innerHTML || "", /\/ 1:00.*0:52 left/);
  assert.deepEqual(heard, [60]);
  stop();
  owner.updateScriptStats();
  assert.deepEqual(heard, [60]);
});

test("scene status: the progress chip shows only once a scene is shot", () => {
  const first = setup();
  first.owner.updateScriptStats();
  assert.equal(document.getElementById("progress-chip")?.hidden, true);
  const second = setup({ status: "shot" });
  second.owner.updateScriptStats();
  assert.equal(document.getElementById("progress-chip")?.hidden, false);
  assert.equal(document.getElementById("progress-text")?.textContent, "1/2 shot");
});

test("scene status: the stats follow status, length and target changes only", () => {
  const { owner } = setup();
  const heard: number[] = [];
  owner.onScriptStats((target) => { heard.push(target); });
  owner.statsFollowChange(change(changeSet({ cells: [{ rowId: "r1", field: "audioText" }] })));
  assert.equal(heard.length, 0);
  owner.statsFollowChange(change(changeSet({ cells: [{ rowId: "r1", field: "status" }] })));
  owner.statsFollowChange(change(changeSet({ cells: [{ rowId: "r1", field: "lengthSeconds" }] })));
  owner.statsFollowChange(change(changeSet({ docFields: ["targetSeconds"] })));
  assert.equal(heard.length, 3);
});

test("scene status: a status click runs the status command; a review refusal warns", () => {
  const { edits, notices, owner } = setup();
  owner.cycleRowStatus("r1");
  assert.deepEqual(edits.ran.map((c) => c.name), ["cycle-scene-status"]);
  assert.equal(notices.shown.length, 0);
  edits.answer({ kind: "rejected", reason: REFUSAL });
  owner.cycleRowStatus("r1");
  assert.deepEqual(notices.shown.map((n) => [n.message, n.kind]), [["This is a review copy — comment on a scene instead of changing its status.", "warn"]]);
});

test("scene status: with shot scenes hidden, a scene that becomes shot arms its grace and one that stops being shot clears it", () => {
  const arming = setup({ hideShot: true, status: "ready", applies: true });
  arming.owner.cycleRowStatus("r1");
  assert.deepEqual(arming.grace, ["arm:r1"]);
  const clearing = setup({ hideShot: true, status: "shot", applies: true });
  clearing.owner.cycleRowStatus("r1");
  assert.deepEqual(clearing.grace, ["clear:r1"]);
});

test("scene status: a failed status command throws to the caller and arms nothing", () => {
  const { edits, grace, owner } = setup({ hideShot: true });
  edits.answer({ kind: "failed", error: new Error("boom") });
  assert.throws(() => { owner.cycleRowStatus("r1"); }, /boom/);
  assert.deepEqual(grace, []);
});
