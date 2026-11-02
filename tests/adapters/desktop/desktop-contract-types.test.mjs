import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { compileFixtures } from "../../../tools/ts-fixtures.mjs";

const fixture = "tests/__desktop__/fixture.ts";
const setup = 'import type { DesktopPort, DesktopTestPort } from "../../src/adapters/desktop/desktop-port.ts";\nimport type { DesktopAnswer } from "../../src/application/desktop/shell.ts";\nimport { useDesktopForTest } from "../../src/adapters/desktop/desktop-port.ts";\nimport { makeFakeDesktopBackend } from "../../src/adapters/desktop/fake-desktop.ts";\ndeclare const port: DesktopPort;\n';

function errors(source) {
  return ts.getPreEmitDiagnostics(compileFixtures({ [fixture]: setup + source }).program);
}

test("the desktop port keeps the wire result shapes and nullable paths", () => {
  assert.deepEqual(errors('export async function read() { const stat = await port.statFile("f"); return stat && stat.size; }').map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
  assert.deepEqual(errors('export async function read() { const hit = await port.historyGet({ docId: "d" }, "s"); return hit && typeof hit.stateJson === "string" && hit.stateJson.toUpperCase(); }').map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
  assert.deepEqual(errors('export const checked: Omit<DesktopTestPort, "getSessionInfo" | "openPrompterInBrowser"> = makeFakeDesktopBackend();').map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
  const cases = [
    {
      source: 'export async function read() { const hit = await port.historyGet({ docId: "d" }, "s"); return hit && hit.stateJson.toUpperCase(); }',
      code: 18048, at: 'hit.stateJson', about: 'undefined'
    },
    {
      source: 'export async function read() { const docs = await port.historyListDocs(); return docs.map(d => d.title.toUpperCase()); }',
      code: 18046, at: 'd.title', about: 'unknown'
    },
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
    },
    {
      source: 'export const wrong: DesktopTestPort = { readFile: async () => ({}) };',
      code: 2322, at: 'readFile', about: 'bytes'
    },
    {
      source: 'export const wrong: DesktopTestPort = { statFile: async () => ({}) };',
      code: 2322, at: 'statFile', about: 'size'
    },
    {
      source: 'export const wrong: DesktopTestPort = { takeDraft: async () => ({}) };',
      code: 2322, at: 'takeDraft', about: 'DesktopTakenDraft'
    },
    {
      source: 'useDesktopForTest({ takeDraft: async () => ({}) });',
      code: 2322, at: 'takeDraft', about: 'DesktopTakenDraft'
    },
    {
      source: 'export const wrong: DesktopTestPort = { writeDraft: async () => null };',
      code: 2322, at: 'writeDraft', about: 'null'
    },
    {
      source: 'export const wrong: DesktopTestPort = { discardDraft: async () => null };',
      code: 2322, at: 'discardDraft', about: 'null'
    },
    {
      source: 'export const wrong: DesktopTestPort = { historyCopy: async () => ({ ok: false, copied: 0 }) };',
      code: 2322, at: 'historyCopy', about: 'code'
    },
    {
      source: 'export const wrong: DesktopAnswer = { ok: true, kind: "file", voice: "not-a-mode" };',
      code: 2322, at: 'voice', about: '"browser" | "relay"'
    },
    {
      source: 'makeFakeDesktopBackend()._setDraft({});',
      code: 2345, at: '{}', about: 'DesktopTakenDraft'
    },
    {
      source: 'export async function wrong(): ReturnType<DesktopPort["writeDraft"]> { return { ok: true, seq: 1, bytes: 1, obsolete: true }; }',
      code: 2322, at: 'obsolete', about: 'undefined'
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

test("the history wrapper preserves the actual call's result", () => {
  const path = "src/adapters/storage/history-backends.ts";
  const original = readFileSync(new URL("../../../" + path, import.meta.url), "utf8");
  const source = original.replace('desktopPort().historyList(docId || null)', 'desktopPort().historyTouch(docId || "", "")');
  assert.notEqual(source, original);
  const found = ts.getPreEmitDiagnostics(compileFixtures({ [path]: source }).program);
  assert.equal(found.length, 1);
  const error = found[0];
  assert.ok(error.file?.fileName.replaceAll("\\", "/").endsWith("/" + path));
  assert.equal(error.code, 2339);
  assert.equal(error.start, source.indexOf("r.usage", source.indexOf("const desktopHistoryBackend")) + 2);
  assert.equal(error.length, "usage".length);
  assert.ok(ts.flattenDiagnosticMessageText(error.messageText, " ").includes("usage"));
});

test("the reusable fake checks its native read reply", () => {
  const path = "src/adapters/desktop/fake-desktop.ts";
  const original = readFileSync(new URL("../../../" + path, import.meta.url), "utf8");
  const source = original.replace('return Promise.resolve({ id: id, name: f.name, lastModified: f.lastModified, size: f.bytes.length, bytes: f.bytes });', 'return Promise.resolve({});');
  assert.notEqual(source, original);
  const found = ts.getPreEmitDiagnostics(compileFixtures({ [path]: source }).program);
  assert.equal(found.length, 1);
  const error = found[0];
  assert.ok(error.file?.fileName.replaceAll("\\", "/").endsWith("/" + path));
  assert.equal(error.code, 2322);
  assert.equal(error.start, source.indexOf("readFile: function"));
  assert.equal(error.length, "readFile".length);
  assert.ok(ts.flattenDiagnosticMessageText(error.messageText, " ").includes("bytes"));
});
