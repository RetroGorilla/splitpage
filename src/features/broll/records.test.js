import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrollRecords } from "./records.js";
import { brollAnchoringDeclined } from "../../application/broll-anchoring.ts";

test("records construction leaves ports idle and mounting resets declined anchoring", () => {
  const records = createBrollRecords(new Proxy({}, {
    get: () => () => { throw new Error("port called during construction"); }
  }));
  records.__init();
  records.declineBrollAnchoring([{ id: "r1" }]);
  assert.equal(brollAnchoringDeclined("r1"), true);
  records.__init();
  assert.equal(brollAnchoringDeclined("r1"), false);
  assert.deepEqual(records.brollStatus("shot"), { id: "shot", label: "Shot", color: "var(--ok)" });
  assert.equal(records.brollStatus("missing"), null);
});

test("seeds keep plain audio and the first location supplied by the document readers", () => {
  const records = createBrollRecords({
    htmlToPlainText: (html) => html.replace(/<[^>]*>/g, ""),
    productionReaders: {
      tagsInField: (html) => html === "visual" ? [
        { catId: "prop", name: "Mug" },
        { catId: "location", name: "Kitchen" }
      ] : [{ catId: "location", name: "Garden" }]
    }
  });
  assert.deepEqual(records.brollSeedOf({ visualText: "visual", audioText: " <b>Narration</b> " }), {
    audioRef: "Narration", location: "Kitchen"
  });
  assert.deepEqual(records.brollSeedOf(null), { audioRef: "", location: "" });
});

test("record edits and refreshes use the supplied session and production ports", () => {
  const commands = [];
  const jobs = [];
  const records = createBrollRecords({
    currentDocument: () => null,
    runDocumentEdit: (command) => { commands.push(command); return true; },
    scheduleIdleRefresh: (job) => { jobs.push(job); }
  });
  assert.equal(records.addBrollProp("bs1", "Mug"), true);
  assert.equal(commands[0]?.name, "add-broll-prop");
  records.scheduleBrollRefresh();
  assert.deepEqual(jobs, ["broll"]);
  assert.deepEqual(records.brollEntries(), []);
  assert.equal(records.derivedRecordsPlan(null, {}), null);
});
