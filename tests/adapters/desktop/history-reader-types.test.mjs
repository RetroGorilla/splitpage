import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { compileFixtures } from "../../../tools/ts-fixtures.mjs";

test("filesystem history implements the real store protocol without promising sanitized disk metadata", () => {
  const file = "tests/__history__/reader.ts";
  const setup = 'import type { createHistoryFsBackend, cleanIndexDoc } from "../../desktop/history-fs-backend.ts";\n' +
    'import type { SharedHistoryBackend, SharedHistoryBucketReader } from "../../shared/history-store.ts";\n' +
    'declare const open: typeof createHistoryFsBackend;\n' +
    'declare const read: typeof cleanIndexDoc;\n' +
    'declare const options: Parameters<typeof open>[0];\n' +
    'declare const raw: unknown;\n' +
    'declare const record: SharedHistoryBucketReader;\n';
  const good = setup + 'const backend: SharedHistoryBackend = open(options);\n' +
    'const doc = read(raw);\n' +
    'const title: unknown = doc && doc.buckets["doc"]?.title;\n' +
    'backend.exclusive(tx => tx.commit({ doc: { title: { toString: null }, snapshots: [] } }, []));\n';
  assert.deepEqual(ts.getPreEmitDiagnostics(compileFixtures({ [file]: good }).program), []);
  const bad = setup + 'const title: string = record.title;\nrecord.snapshots.push({ id: "s01", sha: "bad" });\n';
  const errors = ts.getPreEmitDiagnostics(compileFixtures({ [file]: bad }).program);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map((d) => ({
    code: d.code,
    line: d.file.getLineAndCharacterOfPosition(d.start).line + 1
  })), [{ code: 2322, line: 8 }, { code: 2339, line: 9 }]);
});
