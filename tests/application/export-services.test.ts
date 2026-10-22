import { test } from "node:test";
import assert from "node:assert/strict";
import { exportServices, exportServicesStarted, installExportServices } from "../../src/application/export/services.ts";
import type { ExportServices } from "../../src/application/export/services.ts";
import { noFreeze } from "../../src/core/document/freeze.ts";
import type { ProductionReaders } from "../../src/core/production/ports.ts";

function services(tag: string): ExportServices {
  return {
    cellOf: () => [],
    inertBody: () => tag,
    fromHtml: () => [],
    htmlToMarkdown: () => tag,
    htmlToPlainText: () => tag,
    productionReaders: {} as ProductionReaders,
    cacheSeal: noFreeze
  };
}

test("export services: reading before the start or after the stop throws, and a second start is refused", () => {
  assert.equal(exportServicesStarted(), false);
  assert.throws(() => exportServices(), /The export services are not started yet/);
  const stop = installExportServices(services("first"));
  try {
    assert.equal(exportServicesStarted(), true);
    assert.equal(exportServices().htmlToPlainText("x"), "first");
    assert.throws(() => installExportServices(services("second")), /already started/);
  } finally {
    stop();
  }
  assert.equal(exportServicesStarted(), false);
  assert.throws(() => exportServices(), /not started yet/);
});

test("export services: the port keeps its own copy, refuses one with a service missing, and an old stop leaves a newer start in place", () => {
  const given = services("held") as { -readonly [K in keyof ExportServices]: ExportServices[K] };
  const stopOld = installExportServices(given);
  given.htmlToPlainText = () => "changed";
  assert.equal(exportServices().htmlToPlainText("x"), "held");
  assert.ok(Object.isFrozen(exportServices()));
  stopOld();
  const stopNew = installExportServices(services("new"));
  try {
    stopOld();
    assert.equal(exportServices().htmlToPlainText("x"), "new");
  } finally {
    stopNew();
  }
  for (const name of ["cellOf", "inertBody", "fromHtml", "htmlToMarkdown", "htmlToPlainText", "productionReaders", "cacheSeal"] as const) {
    const partial = { ...services("partial"), [name]: undefined } as unknown as ExportServices;
    assert.throws(() => installExportServices(partial), new RegExp("The export services have no " + name), name);
    assert.equal(exportServicesStarted(), false, name);
  }
});
