import { test } from "node:test";
import assert from "node:assert/strict";
import { createSaveDestinations } from "../../src/application/save/destinations.ts";
import type { SaveDestination } from "../../src/application/save/destinations.ts";

interface Request {
  readonly kind: string;
}

function destination(id: string, takes: (request: Request, place: string) => boolean): SaveDestination<Request, string> {
  return {
    id: id,
    takes: takes,
    autoSaveTarget: () => null,
    write: () => Promise.resolve({ kind: "saved" as const })
  };
}

test("taking asks the newest destination first and answers the first that takes the request at that place", () => {
  const registry = createSaveDestinations<Request, string>();
  const asked: string[] = [];
  registry.register(destination("catch-all", (r, p) => { asked.push("catch-all " + r.kind + "@" + p); return true; }));
  registry.register(destination("copies", (r, p) => { asked.push("copies " + r.kind + "@" + p); return r.kind === "saveAs"; }));
  assert.equal(registry.taking({ kind: "saveAs" }, "file")?.id, "copies");
  assert.equal(registry.taking({ kind: "save" }, "file")?.id, "catch-all");
  assert.deepEqual(asked, ["copies saveAs@file", "copies save@file", "catch-all save@file"]);
  assert.deepEqual(registry.ids(), ["copies", "catch-all"]);
});

test("taking answers null when no destination takes the request", () => {
  const registry = createSaveDestinations<Request, string>();
  assert.equal(registry.taking({ kind: "save" }, "file"), null);
  registry.register(destination("server", (_r, p) => p === "server"));
  assert.equal(registry.taking({ kind: "save" }, "file"), null);
  assert.equal(registry.taking({ kind: "save" }, "server")?.id, "server");
});

test("register returns a removal that drops only that destination, and a second removal does nothing", () => {
  const registry = createSaveDestinations<Request, string>();
  const dropA = registry.register(destination("a", () => true));
  registry.register(destination("b", () => false));
  dropA();
  dropA();
  assert.deepEqual(registry.ids(), ["b"]);
  assert.equal(registry.taking({ kind: "save" }, "x"), null);
  registry.register(destination("a", () => true));
  assert.equal(registry.taking({ kind: "save" }, "x")?.id, "a", "a dropped id can be registered again");
});

test("register refuses a duplicate id, a missing id and a destination without its functions", () => {
  const registry = createSaveDestinations<Request, string>();
  registry.register(destination("a", () => true));
  assert.throws(() => registry.register(destination("a", () => true)), /a destination called a is already registered/);
  assert.throws(() => registry.register(destination("", () => true)), /needs an id/);
  for (const name of ["takes", "autoSaveTarget", "write"]) {
    const broken = { ...destination("broken", () => true), [name]: undefined } as unknown as SaveDestination<Request, string>;
    assert.throws(() => registry.register(broken), new RegExp("the broken destination has no " + name + " function"));
  }
  assert.throws(() => registry.register(null as unknown as SaveDestination<Request, string>), /must be an object/);
  assert.deepEqual(registry.ids(), ["a"]);
});

test("a registered destination is held as it was given: changing the caller's object later changes nothing", () => {
  const registry = createSaveDestinations<Request, string>();
  const given = { ...destination("a", () => true) };
  registry.register(given);
  given.takes = () => false;
  assert.equal(registry.taking({ kind: "save" }, "x")?.id, "a");
});
