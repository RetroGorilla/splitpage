import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { compileFixtures } from "../../../tools/ts-fixtures.mjs";

const fixture = "tests/__desktop__/fixture.ts";
const setup = 'import type { DesktopPort } from "../../src/adapters/desktop/desktop-port.ts";\ndeclare const port: DesktopPort;\n';

function errors(source) {
  return ts.getPreEmitDiagnostics(compileFixtures({ [fixture]: setup + source }).program);
}

test("the desktop port keeps the wire result shapes and nullable paths", () => {
  assert.deepEqual(errors('export async function read() { const stat = await port.statFile("f"); return stat && stat.size; }'), []);
  assert.deepEqual(errors('export async function read() { const hit = await port.historyGet({ docId: "d" }, "s"); return hit && hit.stateJson.toUpperCase(); }'), []);
  const cases = [
    {
      "source": "export const wrong: Pick<DesktopPort, \"takeDraft\"> = { takeDraft: async () => ({}) };",
      "code": 2322,
      "at": "({})",
      "about": "DesktopTakenDraft"
    },
    {
      "source": "export const wrong: Pick<DesktopPort, \"statFile\"> = { statFile: async () => ({ ok: true }) };",
      "code": 2322,
      "at": "({ ok: true })",
      "about": "size"
    },
    {
      "source": "export const wrong: Pick<DesktopPort, \"readFile\"> = { readFile: async () => ({ id: \"f\", name: \"a\" }) };",
      "code": 2322,
      "at": "({ id: \"f\", name: \"a\" })",
      "about": "bytes"
    },
    {
      "source": "export async function read() { return (await port.statFile(\"f\")).size; }",
      "code": 2531,
      "at": "(await port.statFile(\"f\"))",
      "about": "null"
    },
    {
      "source": "export async function read() { return (await port.saveFileDialog({}))?.bytes; }",
      "code": 2339,
      "at": "bytes",
      "about": "bytes"
    },
    {
      "source": "export async function read() { return (await port.takeDraft())?.file.bytes; }",
      "code": 2533,
      "at": "(await port.takeDraft())?.file",
      "about": "null"
    }
  ];
  for (const expected of cases) {
    const found = errors(expected.source);
    assert.equal(found.length, 1, expected.source);
    const error = found[0];
    assert.ok(error.file?.fileName.replaceAll("\\", "/").endsWith("/" + fixture), expected.source);
    assert.equal(error.code, expected.code, expected.source);
    assert.equal(error.start, setup.length + expected.source.indexOf(expected.at), expected.source);
    assert.equal(error.length, expected.at.length, expected.source);
    assert.ok(ts.flattenDiagnosticMessageText(error.messageText, " ").includes(expected.about), expected.source);
  }
});
