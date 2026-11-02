import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { compileFixtures } from "../../tools/ts-fixtures.mjs";

test("history stamping accepts writable numbers and rejects frozen or narrower properties", () => {
  const file = "tests/__history__/stamp.ts";
  const source = 'import { historyStampAfter } from "../../shared/history-policy.ts";\n' +
    'const mutable = { atMs: 1, id: "abc" };\n' +
    'const result: typeof mutable = historyStampAfter(mutable, 10);\n' +
    'historyStampAfter(Object.freeze({ atMs: 1 }), 10);\n' +
    'const frozen: Readonly<{ atMs: number }> = { atMs: 1 };\n' +
    'historyStampAfter(frozen, 10);\n' +
    'const literal: { atMs: 0 } = { atMs: 0 };\n' +
    'historyStampAfter(literal, 10);\n';
  const diagnostics = ts.getPreEmitDiagnostics(compileFixtures({ [file]: source }).program);
  assert.equal(diagnostics.length, 3);
  assert.deepEqual(diagnostics.map((d) => ({
    file: d.file.fileName.replaceAll("\\", "/").endsWith("/" + file),
    line: d.file.getLineAndCharacterOfPosition(d.start).line + 1,
    code: d.code
  })), [4, 6, 8].map((line) => ({ file: true, line, code: 2345 })));
});
