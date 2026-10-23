import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocumentSources } from "../../src/application/transitions/sources.ts";
import type { DocumentSource } from "../../src/application/transitions/sources.ts";

interface Opening {
  readonly kind: string;
}

function source(id: string, takes: (opening: Opening) => boolean): DocumentSource<Opening, string> {
  return { id: id, takes: takes, open: (opening) => id + ":" + opening.kind };
}

test("taking asks the newest source first and answers the first that takes the opening", () => {
  const registry = createDocumentSources<Opening, string>();
  const asked: string[] = [];
  registry.register(source("files", (o) => { asked.push("files " + o.kind); return o.kind === "file"; }));
  registry.register(source("anything", (o) => { asked.push("anything " + o.kind); return o.kind !== "file"; }));
  assert.equal(registry.taking({ kind: "file" })?.id, "files");
  assert.equal(registry.taking({ kind: "server" })?.id, "anything");
  assert.deepEqual(asked, ["anything file", "files file", "anything server"]);
  assert.deepEqual(registry.ids(), ["anything", "files"]);
});

test("taking answers null when no source takes the opening", () => {
  const registry = createDocumentSources<Opening, string>();
  assert.equal(registry.taking({ kind: "file" }), null);
  registry.register(source("server", (o) => o.kind === "server"));
  assert.equal(registry.taking({ kind: "file" }), null);
});

test("register returns a removal that drops only that source, and a second removal does nothing", () => {
  const registry = createDocumentSources<Opening, string>();
  const dropA = registry.register(source("a", () => true));
  registry.register(source("b", () => false));
  dropA();
  dropA();
  assert.deepEqual(registry.ids(), ["b"]);
  registry.register(source("a", () => true));
  assert.equal(registry.taking({ kind: "file" })?.id, "a", "a dropped id can be registered again");
});

test("register refuses a duplicate id, a missing id and a source without its functions", () => {
  const registry = createDocumentSources<Opening, string>();
  registry.register(source("a", () => true));
  assert.throws(() => registry.register(source("a", () => true)), /a source called a is already registered/);
  assert.throws(() => registry.register(source("", () => true)), /needs an id/);
  for (const name of ["takes", "open"]) {
    const broken = { ...source("broken", () => true), [name]: undefined } as unknown as DocumentSource<Opening, string>;
    assert.throws(() => registry.register(broken), new RegExp("the broken source has no " + name + " function"));
  }
  assert.throws(() => registry.register(null as unknown as DocumentSource<Opening, string>), /must be an object/);
  assert.deepEqual(registry.ids(), ["a"]);
});

test("a registered source is held as it was given: changing the caller's object later changes nothing", () => {
  const registry = createDocumentSources<Opening, string>();
  const given = { ...source("a", () => true) };
  registry.register(given);
  given.takes = () => false;
  assert.equal(registry.taking({ kind: "file" })?.id, "a");
});
