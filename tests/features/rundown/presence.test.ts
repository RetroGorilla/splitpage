import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PresencePerson } from "../../../src/application/collaboration/presence.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { RundownPresencePorts } from "../../../src/features/rundown/ports.ts";
import { __init as mountPresence, paintRundownPresence } from "../../../src/features/rundown/presence.js";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeActions, fakeDocument } from "../fakes.ts";

function setup(people: PresencePerson[]) {
  document.body.innerHTML = '<div id="rundown"><div class="rundown-track"><div class="rundown-overlay"></div><div class="rundown-blocks"><div style="left:0px;width:40px"></div><div style="left:40px;width:40px"></div></div></div></div>';
  const doc = migrateRows({ title: "Presence", rows: [{ id: "r1", visualText: "", audioText: "" }, { id: "r2", visualText: "", audioText: "" }] }, fakeMigration().ports);
  const actions = fakeActions();
  const ports: RundownPresencePorts = {
    document: fakeDocument(doc).document,
    presence: { shown: () => people },
    actions: actions.actions
  };
  return { actions, owner: mountPresence(ports) };
}

function dots(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".rundown-presence .rd-who")];
}

test("rundown presence: one dot per person on their scene's block, read through the presence and document ports", () => {
  const { owner } = setup([
    { id: "p1", name: "Sam", color: "#f00", rowId: "r2", field: "audioText" },
    { id: "p2", name: "Ada", color: "#0f0", rowId: "missing", field: "audioText" }
  ]);
  paintRundownPresence();
  assert.deepEqual(dots().map((d) => [d.getAttribute("data-row"), d.getAttribute("data-person"), d.title]), [["r2", "p1", "Sam is in scene 02"]]);
  owner.dispose();
});

test("rundown presence: a click on a dot goes to its scene through the go-to-scene action", () => {
  const { actions, owner } = setup([{ id: "p1", name: "Sam", color: "#f00", rowId: "r1", field: "visualText" }]);
  paintRundownPresence();
  dots()[0]?.click();
  assert.deepEqual(actions.calls, [{ id: "go-to-scene", source: "button", input: "r1" }]);
  owner.dispose();
});

test("rundown presence: dispose removes the click listener and stops painting", () => {
  const people: PresencePerson[] = [{ id: "p1", name: "Sam", color: "#f00", rowId: "r1", field: "visualText" }];
  const { actions, owner } = setup(people);
  paintRundownPresence();
  owner.dispose();
  dots()[0]?.click();
  assert.deepEqual(actions.calls, []);
  people.push({ id: "p2", name: "Ada", color: "#0f0", rowId: "r2", field: "audioText" });
  paintRundownPresence();
  assert.equal(dots().length, 1);
});
