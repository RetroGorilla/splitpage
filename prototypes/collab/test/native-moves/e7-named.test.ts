import assert from "node:assert/strict";
import test from "node:test";
import { DELIVERIES } from "../native/e5-histories.ts";
import { required, spot } from "../native/e5-model.ts";
import { recordHistory } from "./e7-histories.ts";
import type { E7History } from "./e7-histories.ts";
import type { E7Command, E7Model, E7Move, E7Step } from "./e7-model.ts";
import { runHistory } from "./e7-run.ts";
import type { E7Run } from "./e7-run.ts";

type Planned = E7Step | ((models: E7Model[]) => E7Step);

const a = (command: E7Command): E7Step => ({ by: 0, command });
const b = (command: E7Command): E7Step => ({ by: 1, command });
const take: E7Step = { from: 0, to: 1 };
const give: E7Step = { from: 1, to: 0 };
const move = (unit: E7Move["unit"], first: string, last: string, after: string | null): E7Move => ({ op: "move", unit, first, last, after });
const row = (id: string, after: string | null): E7Move => move("row", `b:${id}`, `b:${id}`, after);
const unjoinAt = (by: number, id: string) => (models: E7Model[]): E7Step => {
  const view = required(models[by], "writer").project(), entry = view.outline.find(item => item.kind === "row" && item.id === id);
  if (entry?.kind !== "row") throw new Error(`No row ${id}`);
  const at = Array.from({ length: entry.audio.length + 1 }, (_, index) => index).find(index => spot(entry, "audio", index).seam);
  return { by, command: { op: "unjoin", row: id, at: required(at, "seam") } };
};

function history(plan: readonly Planned[]): E7History {
  return recordHistory(2, (models, index) => {
    const step = plan[index];
    return typeof step === "function" ? step(models) : step;
  });
}

function summary(run: E7Run): string[] {
  if (!run.final) return [];
  const { outline, removedBeats, removedHeadings } = run.final.view;
  return [...outline.map(entry => entry.kind === "row" ? `${entry.members.join("+")}: ${entry.audio} / ${entry.visual}` : `#${entry.id}: ${entry.name}`),
    ...removedBeats.map(entry => `recovery ${entry.members.join("+")}: ${entry.audio}`), ...removedHeadings.map(entry => `recovery #${entry.id}: ${entry.name}`)];
}

const H0 = "#H0: A", B0 = "B0: O / P", B1 = "B1: bc / K", H1 = "#H1: D", B2 = "B2: ef / L", B3 = "B3: gh / M", B4 = "B4: ij / N";
const B1_AFTER_B3 = a(row("B1", "b:B3")), MOVED = [H0, B0, H1, B2, B3, B1, B4];

const NAMED: Readonly<Record<string, { plan: Planned[]; expected: string[] }>> = {
  "1: typing in the moved beat's narration goes with it": {
    plan: [B1_AFTER_B3, b({ op: "typeBeat", row: "B1", field: "audio", at: 1, value: "X" })],
    expected: [H0, B0, H1, B2, B3, "B1: bXc / K", B4]
  },
  "1: typing in the moved beat's visual cell goes with it": {
    plan: [B1_AFTER_B3, b({ op: "typeBeat", row: "B1", field: "visual", at: 0, value: "X" })],
    expected: [H0, B0, H1, B2, B3, "B1: bc / XK", B4]
  },
  "1: typing in a beat that shares its segment with the moved beat stays put": {
    plan: [B1_AFTER_B3, b({ op: "typeBeat", row: "B0", field: "audio", at: 1, value: "X" })],
    expected: [H0, "B0: OX / P", H1, B2, B3, B1, B4]
  },
  "1: splitting the moved beat keeps both halves at the destination": {
    plan: [B1_AFTER_B3, b({ op: "split", row: "B1", at: 1, id: "S9" })],
    expected: [H0, B0, H1, B2, B3, "B1: b / K", "S9: c / ", B4]
  },
  "1: joining the moved beat up at the source joins it to the beat above its new place": {
    plan: [B1_AFTER_B3, b({ op: "join", row: "B1" })],
    expected: [H0, B0, H1, B2, "B3+B1: gh bc / M\nK", B4]
  },
  "1: joining the next row into the moved beat at the source leaves that row where it was": {
    plan: [a(row("B2", "b:B4")), b({ op: "join", row: "B3" })],
    expected: [H0, B0, B1, H1, B3, B4, B2]
  },
  "1: joining inside a moved run keeps the joined row together": {
    plan: [a(move("rows", "b:B2", "b:B3", "b:B4")), b({ op: "join", row: "B3" })],
    expected: [H0, B0, B1, H1, B4, "B2+B3: ef gh / L\nM"]
  },
  "2: the same beat moved to two places ends in one": {
    plan: [B1_AFTER_B3, b(row("B1", "b:B4"))],
    expected: [H0, B0, H1, B2, B3, B4, B1]
  },
  "2: the same beat moved to the same place": {
    plan: [B1_AFTER_B3, b(row("B1", "b:B3"))],
    expected: MOVED
  },
  "2: the same scene moved to two places ends in one": {
    plan: [a(move("scene", "h:H1", "b:B4", null)), b(move("scene", "h:H1", "b:B4", "h:H0"))],
    expected: [H0, H1, B2, B3, B4, B0, B1]
  },
  "2: two scenes swapped from both ends": {
    plan: [a(move("scene", "h:H1", "b:B4", null)), b(move("scene", "h:H0", "b:B1", "b:B4"))],
    expected: [H1, B2, B3, B4, H0, B0, B1]
  },
  "2: overlapping runs leave every beat once": {
    plan: [a(move("rows", "b:B0", "b:B1", "b:B3")), b(move("rows", "b:B1", "b:B2", "b:B4"))],
    expected: [H0, B3, B0, B4, B1, H1, B2]
  },
  "2: two moves that would put each beat after the other": {
    plan: [B1_AFTER_B3, b(row("B3", "b:B1"))],
    expected: MOVED
  },
  "3: splitting the beat the moved beat lands after puts it between the halves": {
    plan: [B1_AFTER_B3, b({ op: "split", row: "B3", at: 1, id: "S9" })],
    expected: [H0, B0, H1, B2, "B3: g / M", B1, "S9: h / ", B4]
  },
  "3: splitting the beat above the source": {
    plan: [a(row("B2", "b:B4")), b({ op: "split", row: "B1", at: 1, id: "S9" })],
    expected: [H0, B0, "B1: b / K", "S9: c / ", H1, B3, B4, B2]
  },
  "3: joining the row below the destination joins it to the moved beat": {
    plan: [B1_AFTER_B3, b({ op: "join", row: "B4" })],
    expected: [H0, B0, H1, B2, B3, "B1+B4: bc ij / K\nN"]
  },
  "3: unjoining the moved row moves both parts": {
    plan: [a({ op: "join", row: "B1" }), take, a(move("row", "b:B0", "b:B1", "b:B3")), unjoinAt(1, "B0")],
    expected: [H0, H1, B2, B3, B0, B1, B4]
  },
  "3: removing the moved beat": {
    plan: [B1_AFTER_B3, b({ op: "removeBeat", row: "B1" })],
    expected: [H0, B0, H1, B2, B3, B4, "recovery B1: bc"]
  },
  "3: restoring the moved beat brings it back at its new place": {
    plan: [B1_AFTER_B3, b({ op: "removeBeat", row: "B1" }), take, give, b({ op: "restoreBeat", id: "B1" })],
    expected: MOVED
  },
  "3: removing the beat the moved beat lands after": {
    plan: [B1_AFTER_B3, b({ op: "removeBeat", row: "B3" })],
    expected: [H0, B0, H1, B2, B1, B4, "recovery B3: gh"]
  },
  "3: a heading created above the moved beat stays at the source": {
    plan: [B1_AFTER_B3, b({ op: "create", beat: "B1", id: "New", name: "N" })],
    expected: [H0, B0, "#New: N", H1, B2, B3, B1, B4]
  },
  "3: a heading created above the beat the moved beat lands before": {
    plan: [B1_AFTER_B3, b({ op: "create", beat: "B4", id: "New", name: "N" })],
    expected: [H0, B0, H1, B2, B3, B1, "#New: N", B4]
  },
  "3: renaming the heading of a moved scene": {
    plan: [a(move("scene", "h:H1", "b:B4", null)), b({ op: "renameType", id: "H1", at: 1, value: "X" })],
    expected: ["#H1: DX", B2, B3, B4, H0, B0, B1]
  },
  "3: removing the heading of a moved scene": {
    plan: [a(move("scene", "h:H1", "b:B4", null)), b({ op: "removeHeading", id: "H1" })],
    expected: [B2, B3, B4, H0, B0, B1, "recovery #H1: D"]
  },
  "3: removing the heading a beat was moved under": {
    plan: [a(move("into", "b:B0", "b:B0", "h:H1")), b({ op: "removeHeading", id: "H1" })],
    expected: [H0, B1, B0, B2, B3, B4, "recovery #H1: D"]
  }
};

for (const [name, { plan, expected }] of Object.entries(NAMED)) {
  test(`E7 named: ${name}`, () => {
    const recorded = history(plan);
    for (const delivery of DELIVERIES) {
      const run = runHistory(recorded, delivery, 1);
      assert.equal(run.mismatch, undefined, JSON.stringify({ delivery, mismatch: run.mismatch }));
      assert.equal(run.lost + run.duplicated + run.uneditable + run.disagreeing + run.notOnce + run.unmovedOutOfOrder + run.crashes, 0);
      assert.deepEqual(summary(run), expected, delivery);
    }
  });
}
