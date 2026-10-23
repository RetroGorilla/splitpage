import { test } from "node:test";
import assert from "node:assert/strict";
import { installProjectFileServices, projectFileServices, projectFileServicesStarted } from "../../src/application/formats/project-file-services.ts";
import type { ProjectFileServices } from "../../src/application/formats/project-file-services.ts";
import { migrateRows } from "../../src/js/02-state.js";

function services(tag: string): ProjectFileServices {
  return {
    migrateRows: (raw) => migrateRows(raw),
    migrateDocument: (raw) => migrateRows(raw),
    sanitizeHtml: () => tag,
    tagFieldOccurrences: (html) => ({ hits: 0, html: html }),
    inertBody: () => ({ ownerDocument: { getElementById: () => null } }),
    askMarkdownRows: () => Promise.resolve("keep")
  };
}

test("project file services: reading before the start or after the stop throws, and a second start is refused", () => {
  assert.equal(projectFileServicesStarted(), false);
  assert.throws(() => projectFileServices(), /The project file services are not started yet/);
  const stop = installProjectFileServices(services("first"));
  try {
    assert.equal(projectFileServicesStarted(), true);
    assert.equal(projectFileServices().sanitizeHtml("x"), "first");
    assert.throws(() => installProjectFileServices(services("second")), /already started/);
  } finally {
    stop();
  }
  assert.equal(projectFileServicesStarted(), false);
  assert.throws(() => projectFileServices(), /not started yet/);
});

test("project file services: the port keeps its own copy, refuses one with a service missing, and an old stop leaves a newer start in place", () => {
  const given = services("held") as { -readonly [K in keyof ProjectFileServices]: ProjectFileServices[K] };
  const stopOld = installProjectFileServices(given);
  given.sanitizeHtml = () => "changed";
  assert.equal(projectFileServices().sanitizeHtml("x"), "held");
  assert.ok(Object.isFrozen(projectFileServices()));
  stopOld();
  const stopNew = installProjectFileServices(services("new"));
  try {
    stopOld();
    assert.equal(projectFileServices().sanitizeHtml("x"), "new");
  } finally {
    stopNew();
  }
  for (const name of ["migrateRows", "migrateDocument", "sanitizeHtml", "tagFieldOccurrences", "inertBody", "askMarkdownRows"] as const) {
    const partial = { ...services("partial"), [name]: undefined };
    assert.throws(() => Reflect.apply(installProjectFileServices, undefined, [partial]), new RegExp("The project file services have no " + name + " function"), name);
    assert.equal(projectFileServicesStarted(), false, name);
  }
});
