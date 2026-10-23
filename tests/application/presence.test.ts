import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESENCE_MAX_SHOWN, createPresence } from "../../src/application/collaboration/presence.ts";
import type { Presence, PresentPerson } from "../../src/application/collaboration/presence.ts";
import { PERSON_COLORS, hashedPersonColor } from "../../src/core/document/person-colors.ts";

interface World {
  readonly presence: Presence;
  readonly seen: string[];
  name: string;
  color: string;
  doc: unknown;
}

const BLUE = PERSON_COLORS[0] as string;
const AMBER = PERSON_COLORS[1] as string;
const VIOLET = PERSON_COLORS[2] as string;

function world(): World {
  const seen: string[] = [];
  const w: World = {
    seen: seen,
    name: "",
    color: "",
    doc: undefined,
    presence: createPresence({
      selfName: () => w.name,
      selfColor: () => w.color,
      documentColors: () => w.doc
    })
  };
  w.presence.onChange(() => { seen.push("change"); });
  w.presence.onRecolor(() => { seen.push("recolor"); });
  return w;
}

test("presence: apply holds who is here and tells change listeners, then recolor listeners only when a live colour changed", () => {
  const w = world();
  w.presence.apply([{ id: "p1", name: "Ann", color: BLUE.toLowerCase() }]);
  assert.deepEqual(w.seen, ["change", "recolor"]);
  assert.equal(w.presence.here().length, 1);
  w.seen.length = 0;
  w.presence.apply([{ id: "p1", name: "Ann", color: BLUE, rowId: "r1" }]);
  assert.deepEqual(w.seen, ["change"]);
  w.seen.length = 0;
  w.presence.apply(null);
  assert.deepEqual(w.seen, ["change", "recolor"]);
  assert.deepEqual(w.presence.here(), []);
});

test("presence: a person's colour is their chosen palette colour, else my colour for me, a live colour, the document's, then a hash", () => {
  const w = world();
  assert.equal(w.presence.personColor("Ann"), hashedPersonColor("Ann"));
  w.doc = { Ann: VIOLET };
  assert.equal(w.presence.personColor("ann"), VIOLET);
  w.presence.apply([{ id: "p1", name: "Ann", color: AMBER }]);
  assert.equal(w.presence.personColor("Ann"), AMBER);
  w.name = "Ann";
  w.color = BLUE;
  assert.equal(w.presence.personColor("Ann"), BLUE);
  assert.equal(w.presence.colorOf({ name: "Ann", color: VIOLET }), VIOLET);
  assert.equal(w.presence.colorOf({ name: "Ann", color: "not a colour" }), BLUE);
  assert.equal(w.presence.colorOf(null), hashedPersonColor(""));
});

test("presence: shown lists at most eight people with their id, name, colour and place, falling back to the seed and Guest", () => {
  const w = world();
  const people: PresentPerson[] = Array.from({ length: PRESENCE_MAX_SHOWN + 2 }, (_, i) => ({ id: "p" + String(i), name: "N" + String(i), color: BLUE }));
  people[0] = { name: "Bo", rowId: "r1", field: "audioText" };
  people[1] = { id: "p1" };
  w.presence.apply(people);
  const shown = w.presence.shown();
  assert.equal(shown.length, PRESENCE_MAX_SHOWN);
  assert.deepEqual(shown[0], { id: "Bo", name: "Bo", color: hashedPersonColor("Bo"), rowId: "r1", field: "audioText" });
  assert.deepEqual(shown[1], { id: "p1", name: "Guest", color: hashedPersonColor("p1"), rowId: "", field: "" });
  assert.equal(w.presence.nameOf(undefined), "Guest");
});

test("presence: colorsWithMine records my colour under my name, replacing a differently cased entry, and says nothing when it is already there", () => {
  const w = world();
  assert.equal(w.presence.colorsWithMine({ personColors: {} }), null, "no name or colour");
  w.name = "  Ann ";
  w.color = BLUE;
  assert.equal(w.presence.colorsWithMine(null), null);
  assert.deepEqual(w.presence.colorsWithMine({}), { Ann: BLUE });
  assert.deepEqual(w.presence.colorsWithMine({ personColors: { ann: AMBER, Bo: VIOLET } }), { Bo: VIOLET, Ann: BLUE });
  assert.equal(w.presence.colorsWithMine({ personColors: { ANN: BLUE } }), null);
});

test("presence: a listener can unsubscribe, and dispose forgets who is here, the live colours and every listener", () => {
  const w = world();
  const extra: string[] = [];
  const stop = w.presence.onChange(() => { extra.push("x"); });
  w.presence.apply([{ name: "Ann", color: AMBER }]);
  stop();
  w.presence.apply([{ name: "Ann", color: AMBER }]);
  assert.deepEqual(extra, ["x"]);
  w.seen.length = 0;
  w.presence.dispose();
  assert.deepEqual(w.presence.here(), []);
  assert.equal(w.presence.personColor("Ann"), hashedPersonColor("Ann"));
  w.presence.apply([{ name: "Ann", color: AMBER }]);
  assert.deepEqual(w.seen, []);
});
