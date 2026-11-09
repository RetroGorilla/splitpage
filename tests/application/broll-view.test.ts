import test from "node:test";
import assert from "node:assert/strict";
import { createBrollView } from "../../src/application/preferences/broll-view.ts";

function fixture(initial: string | null = null) {
  let saved = initial;
  const owner = createBrollView({ read: () => saved, write: (value) => { saved = value; } });
  return { owner, saved: () => saved };
}

test("B-roll export scope is available without a feature and follows the shared owner", () => {
  const h = fixture();
  assert.deepEqual(h.owner.printView(), { filter: "all", group: "location" });
  h.owner.setFilter("flagged");
  h.owner.setGroup("flat");
  h.owner.setPageGroup("person");
  assert.deepEqual(h.owner.printView(), { filter: "flagged", group: "person" });
  assert.deepEqual(h.owner.printView({ filter: "shot", group: "scene" }), { filter: "shot", group: "scene" });
  assert.deepEqual(h.owner.printView({ filter: "invalid", group: "invalid" }), { filter: "all", group: "scene" });
  assert.deepEqual(h.owner.printView({ filter: "", group: "" }), { filter: "flagged", group: "person" });
  assert.deepEqual(h.owner.printView(), { filter: "flagged", group: "person" });
  assert.deepEqual(JSON.parse(h.saved() || ""), { filter: "flagged", pageGroup: "person" });
  const restored = fixture(h.saved()).owner;
  restored.load();
  assert.deepEqual(restored.current(), { filter: "flagged", group: "scene", pageGroup: "person" });
  Object.assign(restored.current(), { filter: "shot" });
  assert.deepEqual(restored.printView(), { filter: "flagged", group: "person" });
});

test("B-roll view preserves stored choices and the existing invalid-value fallbacks", () => {
  for (const saved of [null, "invalid JSON", "null", "42", '{"filter":"bad","group":"bad","pageGroup":"bad"}']) {
    const h = fixture(saved);
    h.owner.load();
    assert.deepEqual(h.owner.current(), { filter: "all", group: "scene", pageGroup: "location" });
    h.owner.setFilter("bad");
    h.owner.setGroup("bad");
    h.owner.setPageGroup("bad");
    assert.deepEqual(h.owner.current(), { filter: "all", group: "scene", pageGroup: "location" });
  }
  const unavailable = createBrollView({ read: () => { throw new Error("blocked"); }, write: () => { throw new Error("blocked"); } });
  unavailable.load();
  unavailable.setFilter("shot");
  assert.deepEqual(unavailable.printView(), { filter: "shot", group: "location" });
});
