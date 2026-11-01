import test from "node:test";
import assert from "node:assert/strict";
import { compileFixtures } from "../../../tools/ts-fixtures.mjs";

const fixture = "tests/__desktop__/fixture.ts";
const setup = 'import type { DesktopPort } from "../../src/adapters/desktop/desktop-port.ts";\ndeclare const port: DesktopPort;\n';

function errors(source) {
  return compileFixtures({ [fixture]: setup + source }).errorLines(fixture);
}

test("the desktop port keeps the wire result shapes and nullable paths", () => {
  assert.deepEqual(errors('export async function read() { const stat = await port.statFile("f"); return stat && stat.size; }'), []);
  assert.deepEqual(errors('export async function read() { const hit = await port.historyGet({ docId: "d" }, "s"); return hit && hit.stateJson.toUpperCase(); }'), []);
  for (const source of [
    'export const wrong: Pick<DesktopPort, "statFile"> = { statFile: async () => ({ ok: true }) };',
    'export const wrong: Pick<DesktopPort, "readFile"> = { readFile: async () => ({ id: "f", name: "a" }) };',
    'export async function read() { return (await port.statFile("f")).size; }',
    'export async function read() { return (await port.saveFileDialog({}))?.bytes; }',
    'export async function read() { return (await port.takeDraft())?.file.bytes; }'
  ]) assert.ok(errors(source).length > 0, source);
});
