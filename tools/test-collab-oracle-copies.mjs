import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { REPO } from "./source-scan.mjs";
import { COLLAB_ORACLE_COPIES } from "./collab-oracle-copies.mjs";
import { needsChecks, needsOldAdapterTests } from "./ci-changes.mjs";

function oracleDigest(text, path) {
  const source = ts.createSourceFile(path, text.replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest);
  const declarations = source.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(source));
  return createHash("sha256").update(JSON.stringify(declarations)).digest("hex");
}

function filesUnder(folder) {
  return readdirSync(join(REPO, folder), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(REPO, join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
    .sort();
}

for (const [file, expected] of Object.entries(COLLAB_ORACLE_COPIES)) {
  test(file + " declares the verified oracle", () => {
    assert.equal(oracleDigest(readFileSync(join(REPO, file), "utf8"), file), expected);
  });
}

test("every oracle is pinned and its changes trigger both root test matrices", () => {
  const files = filesUnder("tests/collab/oracles");
  assert.deepEqual(files, Object.keys(COLLAB_ORACLE_COPIES).sort());
  for (const file of files) {
    assert.equal(needsChecks([file]), true, file);
    assert.equal(needsOldAdapterTests([file]), true, file);
  }
});

test("the digest pins declarations and exports while allowing imports and leading comments to move", () => {
  const file = "oracle.ts";
  const source = 'import type { Pair } from "./one.ts";\nconst original: Pair = [1, 2];\nexport { original as expected };\n';
  const digest = oracleDigest(source, file);
  assert.equal(oracleDigest(source.replace("./one.ts", "./two.ts").replace("const original", "// origin\nconst original"), file), digest);
  for (const changed of [
    source.replace("[1, 2]", "[1, 3]"),
    source.replace("[1, 2]", "[1,2]"),
    source.replace("as expected", "as renamed"),
    source.replace("export { original as expected };", ""),
    source + "export { other } from './other.ts';\n",
    source + "const other = 3;\n"
  ]) assert.notEqual(oracleDigest(changed, file), digest);
});
