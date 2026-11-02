import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { compileFixtures } from "../../tools/ts-fixtures.mjs";

const fixture = "tests/application/save-completion-fixture.ts";
const setup = `
import type { Home } from "../../src/application/location/document-location.ts";
import type { CompletedWrite, LandedWrite, SaveCompletionPorts } from "../../src/application/save/save-completion.ts";
import { createSaveCompletion } from "../../src/application/save/save-completion.ts";
type Baseline = { rev: number };
declare const ports: SaveCompletionPorts<Baseline>;
declare const home: Home<Baseline>;
declare const landed: LandedWrite<Baseline>;
declare const write: CompletedWrite<Baseline>;
const result = ports.location.amendHome(home, { diskBase: { rev: 3 } });
`;

test("save completion carries a partial baseline through the location and landed write", () => {
  const source = setup + `
export const amendedRev: number | undefined = result.diskBase?.rev;
export const landedRev: number | undefined = landed.home.diskBase?.rev;
export const completedRev: number | undefined = write.landed?.home.diskBase?.rev;
createSaveCompletion(ports).confirmWrite(write);
`;
  assert.deepEqual(ts.getPreEmitDiagnostics(compileFixtures({ [fixture]: source }).program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});

test("a partial save baseline never advertises document rows or accepts an unrelated published type", () => {
  const source = setup + `
export const amendedRows = result.diskBase?.rows.length;
export const landedRows = landed.home.diskBase?.rows.length;
export const completedRows = write.landed?.home.diskBase?.rows.length;
export type WrongPublished = CompletedWrite<Baseline, { title: string }>;
`;
  const errors = ts.getPreEmitDiagnostics(compileFixtures({ [fixture]: source }).program);
  assert.equal(errors.length, 4);
  for (const [index, error] of errors.entries()) {
    assert.ok(error.file?.fileName.replaceAll("\\", "/").endsWith("/" + fixture));
    const message = ts.flattenDiagnosticMessageText(error.messageText, " ");
    if (index < 3) {
      assert.equal(error.code, 2339);
      assert.equal(source.slice(error.start, error.start + error.length), "rows");
      assert.match(message, /Baseline/);
    } else {
      assert.equal(error.code, 2344);
      assert.match(message, /rev/);
    }
  }
});
