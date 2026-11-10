import assert from "node:assert/strict";
import { bag, records } from "./value.ts";

export const projectionExclusion = Object.freeze({
  fixture: "supplement.splitpage",
  fields: [
    { path: "$.rows.0.imageLinks.0.location", value: { kind: "path", path: "C:\\shoot\\take.mp4" } },
    { path: "$.rows.0.imageLinks.1.location", value: { kind: "bundled", name: "notes.pdf" } }
  ]
});

export function expectedProjectionBytes(fixture: string, appSaved: string): string {
  if (fixture !== projectionExclusion.fixture) return appSaved;
  const document = bag(JSON.parse(appSaved));
  assert.equal(JSON.stringify(document, null, 2), appSaved, "Exclusion must preserve all other byte formatting");
  const links = records(records(document.rows)[0]?.imageLinks);
  assert.equal(links.length, 2, "Declared exclusion fixture links changed");
  for (const [index, field] of projectionExclusion.fields.entries()) {
    const link = links[index];
    assert.ok(link);
    assert.deepEqual(link.location, field.value, `Declared exclusion changed: ${field.path}`);
    delete link.location;
  }
  return JSON.stringify(document, null, 2);
}

export function assertProjectionBytes(fixture: string, appSaved: string, actual: string): void {
  assert.equal(actual, expectedProjectionBytes(fixture, appSaved), `PROJ bytes: ${fixture}`);
}
