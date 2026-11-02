import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createUndoHistory, diffStates } from "../application/editing/undo/history.ts";
import { cellRuns } from "./_cell-runs.mjs";

for (const key of ["productionTags", "brollShots"]) {
  for (const dir of ["undo", "redo"]) {
    test(`${dir} counts newly unassigned ${key} but not owners already missing (#502)`, () => {
      const history = createUndoHistory(cellRuns);
      const empty = { rows: [], people: [], productionTags: [], brollShots: [] };
      const crew = { ...empty, people: [{ id: "cy", name: "Cy" }] };
      const live = structuredClone(crew);
      history.record(diffStates(dir === "undo" ? empty : crew, dir === "undo" ? crew : empty), 0);
      if (dir === "redo") {
        live.people = [];
        assert.equal(history.undo(live).ok, true);
      }
      live[key] = [
        { id: "valid", name: "Valid", owner: "cy" },
        { id: "dangling", name: "Dangling", owner: "gone" },
        { id: "empty", name: "Empty", owner: "" }
      ];
      assert.equal(history[dir](live).cleared, 1);
      assert.deepEqual(live[key].map((e) => e.owner), ["", "", ""]);
      assert.equal(history[dir === "undo" ? "redo" : "undo"](live).ok, true);
      assert.deepEqual(live[key].map((e) => e.owner), ["cy", "", ""]);
      assert.equal(history[dir](live).cleared, 1);
      assert.deepEqual(live[key].map((e) => e.owner), ["", "", ""]);
    });
  }
}
