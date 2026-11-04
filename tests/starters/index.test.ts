import assert from "node:assert/strict";
import { test } from "node:test";
import { LONG_DEMO, STARTERS, starterById } from "../../src/starters/index.ts";

test("starterById finds each starter in catalogue order", () => {
  assert.deepEqual(STARTERS.map(({ id, name, desc }) => ({ id, name, desc })), [
    { id: "to-camera", name: "To-camera video", desc: "Hook, intro, scenes, call to action." },
    { id: "interview", name: "Interview", desc: "Questions on the right, cutaways on the left." },
    { id: "spot-30", name: "30-second spot", desc: "Six timed beats with a packshot." }
  ]);
  for (const starter of STARTERS) assert.equal(starterById(starter.id), starter);
});

test("starterById also finds the long demo outside STARTERS", () => {
  assert.equal(STARTERS.includes(LONG_DEMO), false);
  assert.equal(LONG_DEMO.id, "long-demo");
  assert.equal(LONG_DEMO.name, "Long demo");
  assert.equal(LONG_DEMO.desc, "Thirty beats, every feature in use.");
  assert.equal(starterById("long-demo"), LONG_DEMO);
});

test("starterById returns null for an unknown id", () => {
  assert.equal(starterById("unknown"), null);
});
